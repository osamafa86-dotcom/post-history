// رفعات الحاسوب غير المكتملة في IndexedDB، لاستئنافها بعد إغلاق التبويب بإعادة اختيار الملف (#88).
// لا رمز هنا: رمز الرفع يبقى في ذاكرة الصفحة، ويُعاد بطلب POST /uploads بمفتاح عدم التكرار نفسه ما دامت الجلسة created.
// عنوان tus قدرة حاملة (SEC-06)، لكنه لا يقبل بايتًا دون رمز ingest لا يصدر إلا لجلسة دخول حية للمستخدم نفسه.
// يُمسح كل شيء عند الخروج أو الإبطال (clear-private-state).
export type PendingUpload = {
  key: string; material_id: string; idempotency_key: string;
  create: { material_id: string; kind: "original"; size_bytes: number; filename: string; mime_type: string | null; client_sha256: string; client_fingerprint?: { size_bytes: number; head_sha256: string; tail_sha256: string } };
  session_id?: string; upload_url?: string; endpoint?: string; expires_at?: string; updated_at: number;
  tus?: { metadata: Record<string, string>; part_size: number; ingest: boolean };
};
const database = "post-history-uploads", store = "pending";

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(database, 1);
    request.onupgradeneeded = () => { request.result.createObjectStore(store, { keyPath: "key" }); };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
async function run<T>(mode: IDBTransactionMode, action: (objects: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(store, mode), request = action(transaction.objectStore(store));
      transaction.oncomplete = () => resolve(request.result);
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
  } finally { db.close(); }
}
const live = (item: PendingUpload) => !item.expires_at || Date.parse(item.expires_at) > Date.now();

export async function pendingUploads(): Promise<PendingUpload[]> {
  try {
    const items = await run("readonly", objects => objects.getAll() as IDBRequest<PendingUpload[]>);
    await Promise.all(items.filter(item => !live(item)).map(item => forgetUpload(item.key)));
    return items.filter(live).sort((a, b) => b.updated_at - a.updated_at);
  } catch { return []; }
}
export async function findUpload(key: string): Promise<PendingUpload | undefined> {
  try { const item = await run("readonly", objects => objects.get(key) as IDBRequest<PendingUpload | undefined>); return item && live(item) ? item : undefined; }
  catch { return undefined; }
}
export async function rememberUpload(item: PendingUpload) { try { await run("readwrite", objects => objects.put({ ...item, updated_at: Date.now() })); } catch { /* الاستئناف بعد الإغلاق يتعذر فقط */ } }
export async function forgetUpload(key: string) { try { await run("readwrite", objects => objects.delete(key)); } catch { /* لا شيء */ } }
export function clearUploads() { try { indexedDB.deleteDatabase(database); } catch { /* لا شيء */ } }
