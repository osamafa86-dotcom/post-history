import Uppy from "@uppy/core";
import Tus from "@uppy/tus";
import type { components } from "@/generated/schema";
import { fileFingerprint, hashFile } from "./file-hash";
import { fileKey, ingestRefreshMarginMs, withinEndpoint } from "./upload-policy";
import { findUpload, forgetUpload, recordKey, rememberUpload, type PendingUpload } from "./upload-store";

type Created = components["schemas"]["UploadSessionCreated"];
// ما يعيده الـBFF من جلسة الرفع (server/uploads.ts)، مشتق من العقد لا مكتوب يدويًا.
export type SessionView = Pick<Created, "id" | "material_id" | "kind" | "state" | "size_bytes" | "bytes_received" | "failure_reason" | "receipt_number" | "expires_at" | "created_at">;
type CreatedView = SessionView & Pick<Created, "tus_endpoint" | "tus_metadata" | "part_size_bytes" | "ingest_token_required" | "upload_token" | "upload_token_expires_at">;
type IngestToken = components["schemas"]["IngestToken"];

export type UploadPhase = "hashing" | "creating" | "uploading" | "paused" | "processing" | "done" | "failed";
export type UploadFailure = "session_revoked" | "not_accepted" | "rejected" | "network" | "hash" | "checksum_mismatch" | "invalid_file" | "expired" | "storage_error" | "aborted";
export type UploadUpdate = { phase: UploadPhase; hashed: number; sent: number; total: number; resumed: boolean; session?: SessionView; failure?: UploadFailure };

export class BffError extends Error { constructor(readonly status: number) { super("Request failed"); } }
async function bff<T>(method: "GET" | "POST" | "DELETE", path: string, body?: unknown, key?: string): Promise<T> {
  const response = await fetch(`/api/bff/${path}`, {
    method, credentials: "same-origin", cache: "no-store", redirect: "error",
    headers: method !== "GET" ? { "Content-Type": "application/json", "X-Requested-With": "post-history-web", "Idempotency-Key": key ?? crypto.randomUUID() } : {},
    body: method !== "GET" ? JSON.stringify(body ?? {}) : undefined,
  });
  if (response.status === 401) window.dispatchEvent(new Event("session-revoked"));
  if (!response.ok) throw new BffError(response.status);
  return response.status === 204 ? undefined as T : await response.json() as T;
}
export const createMaterial = <T>(body: unknown, key: string) => bff<T>("POST", "materials", body, key);
/** جلسات المستخدم غير النهائية من الخادم (listMyUploadSessions)، لمركز الرفع. */
export const myUploads = () => bff<{ items: SessionView[]; next_cursor: string | null }>("GET", "uploads?limit=100");
/** إلغاء الجلسة على الخادم (abortUploadSession): يبطل رموزها ويحذف ما وصل منها. */
export const abortUpload = (id: string) => bff<void>("DELETE", `uploads/${id}`);

/** قرار إعادة المحاولة أمام البوابة وtus: 401 رمز ingest انتهى فيُجدَّد، 403/404/410 الجلسة لا تقبل، وغيرها لمنطق tus. */
export function retryDecision(status: number | undefined): "refresh_token" | "stop" | "default" {
  if (status === 401) return "refresh_token";
  if (status === 403 || status === 404 || status === 410) return "stop";
  return "default";
}
const terminal = (state: SessionView["state"]) => ["verified", "failed", "deduplicated"].includes(state);
const failureOf = (session: SessionView): UploadFailure => session.failure_reason ?? "rejected";
const sleep = (ms: number, signal: AbortSignal) => new Promise<void>(resolve => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true }); });

// tus-js-client يحفظ عناوين الرفع في localStorage افتراضيًا؛ الحفظ هنا في IndexedDB وحده، وبلا رموز.
const noStorage = { findAllUploads: async () => [], findUploadsByFingerprint: async () => [], removeUpload: async () => undefined, addUpload: async () => "" };

export type UploadControl = { pause(): void; resume(): void; stop(): void; cancel(): void; done: Promise<UploadUpdate> };

export function startUpload(file: File, materialId: string, report: (update: UploadUpdate) => void): UploadControl {
  const controller = new AbortController(), keyed = recordKey(fileKey(file));
  let key = "";
  let update: UploadUpdate = { phase: "hashing", hashed: 0, sent: 0, total: file.size, resumed: false };
  const emit = (patch: Partial<UploadUpdate>) => { update = { ...update, ...patch }; if (!controller.signal.aborted || patch.phase === "failed") report(update); return update; };
  let uppy: Uppy | undefined, fileId: string | undefined;

  async function prepare(): Promise<PendingUpload> {
    key = await keyed;
    const known = await findUpload(key);
    if (known && known.material_id === materialId) { emit({ hashed: file.size, resumed: true }); return known; }
    // البصمة الكاملة قبل إنشاء الجلسة: العقد يلزم client_sha256 عند POST /uploads.
    const sha = await hashFile(file, hashed => emit({ hashed }), controller.signal);
    const pending: PendingUpload = {
      key, material_id: materialId, idempotency_key: crypto.randomUUID(), updated_at: Date.now(),
      create: { material_id: materialId, kind: "original", size_bytes: file.size, client_sha256: sha, client_fingerprint: await fileFingerprint(file) },
    };
    await rememberUpload(pending); return pending;
  }

  async function run(): Promise<UploadUpdate> {
    let pending: PendingUpload;
    try { pending = await prepare(); }
    catch { return emit({ phase: "failed", failure: controller.signal.aborted ? "aborted" : "hash" }); }
    emit({ phase: "creating" });
    let session: CreatedView | SessionView, uploadToken: string | undefined, metadata: Record<string, string> = {};
    try {
      if (pending.session_id && pending.upload_url) {
        session = await bff<SessionView>("GET", `uploads/${pending.session_id}`);
        if (["completed", "verified", "deduplicated"].includes(session.state)) { await forgetUpload(key); return follow(session); }
        if (session.state === "failed") { await forgetUpload(key); return emit({ phase: "failed", session, failure: failureOf(session) }); }
      } else {
        // المفتاح نفسه بعد إغلاق التبويب يعيد الجلسة نفسها برمز رفع جديد ما دامت created (rehydrate في الخادم).
        const created = await bff<CreatedView>("POST", "uploads", { ...pending.create, filename: file.name, mime_type: file.type || null }, pending.idempotency_key);
        session = created; uploadToken = created.upload_token;
        pending = { ...pending, session_id: created.id, endpoint: created.tus_endpoint, expires_at: created.expires_at, tus: { part_size: created.part_size_bytes, ingest: created.ingest_token_required === true } };
        // البيانات الوصفية لـ tus (وفيها اسم الملف) في الذاكرة وحدها: لا تلزم إلا لإنشاء رفع tus، والاستئناف بعنوانه لا يحتاجها.
        metadata = created.tus_metadata as Record<string, string>;
        await rememberUpload(pending);
      }
    } catch (error) {
      if (error instanceof BffError && error.status === 404) await forgetUpload(key);
      return emit({ phase: "failed", failure: error instanceof BffError ? error.status === 401 ? "session_revoked" : error.status === 409 || error.status === 404 ? "not_accepted" : "rejected" : "network" });
    }
    const tus = pending.tus;
    if (!tus || !pending.endpoint || !pending.session_id) { await forgetUpload(key); return emit({ phase: "failed", failure: "rejected" }); }
    emit({ phase: "uploading", session: session as SessionView, sent: (session as SessionView).bytes_received });
    return transfer(pending, tus, uploadToken, metadata);
  }

  async function transfer(pending: PendingUpload, tus: NonNullable<PendingUpload["tus"]>, uploadToken: string | undefined, metadata: Record<string, string>): Promise<UploadUpdate> {
    const endpoint = pending.endpoint!, sessionId = pending.session_id!;
    let ingest: { token: string; expires: number } | undefined, stopped: UploadFailure | undefined;
    const ingestToken = async () => {
      if (!ingest || ingest.expires - Date.now() < ingestRefreshMarginMs) {
        try {
          const data = await bff<IngestToken>("POST", `uploads/${sessionId}/web-ingest-token`);
          ingest = { token: data.token, expires: Date.parse(data.expires_at) };
        } catch (error) {
          // 401 = جلسة الدخول أُبطلت: يتوقف الرفع ولا يُعاد (SEC-01). 404/409 = جلسة الرفع لم تعد تقبل.
          stopped = error instanceof BffError ? error.status === 401 ? "session_revoked" : [404, 409].includes(error.status) ? "not_accepted" : "network" : "network";
          if (stopped !== "network") uppy?.cancelAll();
          throw error;
        }
      }
      return ingest.token;
    };
    uppy = new Uppy({ autoProceed: false, allowMultipleUploadBatches: false });
    uppy.use(Tus, {
      endpoint, chunkSize: tus.part_size, storeFingerprintForResuming: false, removeFingerprintOnSuccess: false, urlStorage: noStorage,
      retryDelays: [0, 1000, 3000, 5000, 10000, 20000, 30000, 60000], limit: 1, allowedMetaFields: Object.keys(metadata),
      headers: uploadToken ? { Authorization: `Bearer ${uploadToken}` } : {},
      async onBeforeRequest(request) {
        const url = request.getURL();
        // Location من الخادم لا يُتبع إلى أصل آخر ومعه الرموز.
        if (url !== endpoint && !withinEndpoint(url, endpoint)) { stopped = "rejected"; throw new Error("Unexpected upload URL"); }
        if (tus.ingest) request.setHeader("Ingest-Token", await ingestToken());
      },
      onShouldRetry(error, attempt, _options, next) {
        if (stopped && stopped !== "network") return false;
        const decision = retryDecision((error as { originalResponse?: { getStatus(): number } | null }).originalResponse?.getStatus());
        if (decision === "refresh_token") { ingest = undefined; return attempt < 3; }
        if (decision === "stop") { stopped = "not_accepted"; return false; }
        return next(error);
      },
    });
    fileId = uppy.addFile({ name: file.name, type: file.type || undefined, data: file, meta: { ...metadata } });
    if (pending.upload_url) uppy.setFileState(fileId, { tus: { uploadUrl: pending.upload_url } });
    let saved = pending.upload_url;
    uppy.on("upload-progress", (_file, progress) => {
      const url = uppy?.getFile(fileId!)?.tus?.uploadUrl ?? undefined;
      if (url && url !== saved && withinEndpoint(url, endpoint)) { saved = url; void rememberUpload({ ...pending, upload_url: url }); }
      emit({ phase: update.phase === "paused" ? "paused" : "uploading", sent: progress.bytesUploaded ?? 0 });
    });
    const result = await uppy.upload().catch(() => undefined);
    const ok = result?.successful?.some(item => item.id === fileId);
    uppy.destroy(); uppy = undefined;
    if (!ok) {
      if (controller.signal.aborted) return emit({ phase: "failed", failure: "aborted" });
      // 403 من البوابة لا يميّز السبب؛ سؤال الـBFF يكشف إبطال جلسة الدخول (401 فيخرج المستخدم) أو حالة الجلسة.
      if (stopped === "not_accepted") {
        try { const session = await bff<SessionView>("GET", `uploads/${sessionId}`); emit({ session }); if (session.state === "failed") stopped = failureOf(session); }
        catch (error) { if (error instanceof BffError && error.status === 401) stopped = "session_revoked"; }
      }
      if (stopped && stopped !== "network") { await forgetUpload(key); if (stopped === "session_revoked") window.dispatchEvent(new Event("session-revoked")); }
      return emit({ phase: "failed", failure: stopped ?? "network" });
    }
    await forgetUpload(key);
    emit({ sent: file.size });
    return follow(await bff<SessionView>("GET", `uploads/${sessionId}`).catch(() => ({ ...(update.session as SessionView), state: "completed" as const })));
  }

  // بعد آخر بايت: الخطّاف ثم التحقق على الخادم يصدران الإيصال؛ يُتابع حتى حالة نهائية أو مهلة.
  async function follow(session: SessionView): Promise<UploadUpdate> {
    emit({ phase: "processing", session, sent: file.size });
    const until = Date.now() + 10 * 60000;
    while (!terminal(session.state) && Date.now() < until && !controller.signal.aborted) {
      await sleep(3000, controller.signal);
      try { session = await bff<SessionView>("GET", `uploads/${session.id}`); emit({ session }); } catch { /* المتابعة اختيارية؛ الإيصال يظهر في صفحة المادة */ }
    }
    if (session.state === "failed") return emit({ phase: "failed", session, failure: failureOf(session) });
    return emit({ phase: terminal(session.state) ? "done" : "processing", session });
  }

  return {
    pause() { if (uppy && fileId && update.phase === "uploading") { uppy.pauseResume(fileId); emit({ phase: "paused" }); } },
    resume() { if (uppy && fileId && update.phase === "paused") { uppy.pauseResume(fileId); emit({ phase: "uploading" }); } },
    // stop: يوقف النقل ويبقي سجل الاستئناف وبيانات الخادم. cancel: قرار المستخدم، فيُنهى رفع tus ويُنسى السجل.
    stop() { controller.abort(); uppy?.pauseAll(); },
    cancel() {
      controller.abort(); uppy?.cancelAll();
      const id = update.session?.id;
      if (id && !["verified", "deduplicated", "failed"].includes(update.session!.state)) void abortUpload(id).catch(() => undefined);
      void keyed.then(forgetUpload);
    },
    done: run(),
  };
}
