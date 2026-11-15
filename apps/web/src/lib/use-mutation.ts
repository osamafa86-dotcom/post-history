"use client";
import { useRef, useState } from "react";
import { refusalFromBody, type Refusal } from "./refusal-policy";

// المفتاح يبقى في الذاكرة عند فقدان الرد؛ إعادة المحاولة لا تعيد تنفيذ الكتابة.
export function useMutation() {
  const pending = useRef(false), intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(0), [refusal, setRefusal] = useState<Refusal | null>(null);
  // الرفض الذي يمرّ برمزه من الـBFF (قرار المنسّق 2026-11-15) يُحفظ مع الحالة، فتقول الواجهة سببه بدل الرسالة العامة.
  async function run(fingerprint: string, request: (header: { "Idempotency-Key": string }) => Promise<{ response: Response; error?: unknown }>) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setStatus(0); setRefusal(null);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const { response, error } = await request({ "Idempotency-Key": intent.current.key });
      if (!response.ok) setRefusal(refusalFromBody(error));
      if (response.status === 401) window.dispatchEvent(new Event("session-revoked"));
      if (response.ok || response.status < 500 && response.status !== 429) intent.current = null;
      setStatus(response.ok ? 200 : response.status); return response.ok;
    } catch { setStatus(503); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  return { busy, status, refusal, run, clearStatus: () => { setStatus(0); setRefusal(null); } };
}
