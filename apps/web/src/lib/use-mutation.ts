"use client";
import { useRef, useState } from "react";

// المفتاح يبقى في الذاكرة عند فقدان الرد؛ إعادة المحاولة لا تعيد تنفيذ الكتابة.
export function useMutation() {
  const pending = useRef(false), intent = useRef<{ fingerprint: string; key: string } | null>(null);
  const [busy, setBusy] = useState(false), [status, setStatus] = useState(0);
  async function run(fingerprint: string, request: (header: { "Idempotency-Key": string }) => Promise<{ response: Response }>) {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setStatus(0);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: crypto.randomUUID() };
    try {
      const { response } = await request({ "Idempotency-Key": intent.current.key });
      if (response.status === 401) window.dispatchEvent(new Event("session-revoked"));
      if (response.ok || response.status < 500 && response.status !== 429) intent.current = null;
      setStatus(response.ok ? 200 : response.status); return response.ok;
    } catch { setStatus(503); return false; }
    finally { pending.current = false; setBusy(false); }
  }
  return { busy, status, run, clearStatus: () => setStatus(0) };
}
