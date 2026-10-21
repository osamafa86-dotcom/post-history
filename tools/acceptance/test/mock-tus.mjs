// In-memory tus server for self-tests: keeps whatever bytes arrived before a dropped connection, like tusd does.
import http from "node:http";
import { randomUUID } from "node:crypto";

export function startMockTus({ serveGet = true, corrupt = false, forgetOnDrop = false, requireIngest = null } = {}) {
  const seen = { ingestTokens: [] };
  const uploads = new Map();
  const server = http.createServer((req, res) => {
    const id = req.url.split("/").filter(Boolean).pop();
    if (requireIngest) { const t = req.headers["ingest-token"]; if (t) seen.ingestTokens.push(t); if (!t || !requireIngest(t, req)) { res.writeHead(401); return res.end(); } }
    const send = (status, headers = {}, body) => { res.writeHead(status, { "Tus-Resumable": "1.0.0", ...headers }); res.end(body); };
    if (req.method === "POST") {
      const nid = randomUUID();
      uploads.set(nid, { length: Number(req.headers["upload-length"]), chunks: [], offset: 0 });
      return send(201, { Location: `/files/${nid}` });
    }
    const u = uploads.get(id);
    if (!u) return send(404);
    if (req.method === "HEAD") return send(200, { "Upload-Offset": String(u.offset), "Upload-Length": String(u.length) });
    if (req.method === "GET") {
      if (!serveGet) return send(405);
      const data = Buffer.concat(u.chunks);
      if (corrupt) data[0] ^= 1;
      return send(200, {}, data);
    }
    if (req.method === "PATCH") {
      if (Number(req.headers["upload-offset"]) !== u.offset) return send(409);
      const got = [];
      req.on("data", (c) => got.push(c));
      req.on("close", () => {
        if (!req.complete) { // dropped mid-body
          if (forgetOnDrop) return;
          const b = Buffer.concat(got); u.chunks.push(b); u.offset += b.length;
        }
      });
      req.on("end", () => { const b = Buffer.concat(got); u.chunks.push(b); u.offset += b.length; send(204, { "Upload-Offset": String(u.offset) }); });
      return;
    }
    send(405);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${server.address().port}/files/`, close: () => { server.close(); server.closeAllConnections?.(); }, uploads, seen })));
}
