import { streamSha256 } from "./sha256-stream";

// يحسب البصمة خارج خيط الواجهة؛ يرسل التقدم كل شريحة. الإلغاء بإنهاء الـWorker نفسه.
self.onmessage = async (event: MessageEvent<Blob>) => {
  try {
    const hex = await streamSha256(event.data, bytes => self.postMessage({ type: "progress", bytes }));
    self.postMessage({ type: "done", hex });
  } catch { self.postMessage({ type: "error" }); }
};
