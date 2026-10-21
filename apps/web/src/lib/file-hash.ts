import { bytesToHex } from "@noble/hashes/utils.js";
import { fingerprintBytes } from "./upload-policy";

export function hashFile(file: Blob, progress: (bytes: number) => void, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./hash.worker.ts", import.meta.url), { type: "module" });
    const stop = () => { worker.terminate(); reject(new DOMException("Aborted", "AbortError")); };
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    worker.onmessage = (event: MessageEvent<{ type: "progress"; bytes: number } | { type: "done"; hex: string } | { type: "error" }>) => {
      if (event.data.type === "progress") return progress(event.data.bytes);
      signal.removeEventListener("abort", stop); worker.terminate();
      if (event.data.type === "done") resolve(event.data.hex); else reject(new Error("Hash failed"));
    };
    worker.onerror = () => { signal.removeEventListener("abort", stop); worker.terminate(); reject(new Error("Hash failed")); };
    worker.postMessage(file);
  });
}

/** بصمة رخيصة لترشيح المكررات (أول وآخر 1 MiB)؛ لا تمنح أي حق عند الخادم. */
export async function fileFingerprint(file: Blob) {
  const digest = async (part: Blob) => bytesToHex(new Uint8Array(await crypto.subtle.digest("SHA-256", await part.arrayBuffer())));
  return { size_bytes: file.size, head_sha256: await digest(file.slice(0, fingerprintBytes)), tail_sha256: await digest(file.slice(Math.max(0, file.size - fingerprintBytes))) };
}
