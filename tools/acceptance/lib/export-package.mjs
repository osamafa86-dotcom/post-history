// Reading and judging the editing-export package the media worker builds (workers/media/src/media_worker/export.py):
// a ZIP with clip.<ext> (the original's streams copied into a new file, metadata stripped), proxy.mp4 when there is one,
// metadata.json, sequence.fcpxml, sequence.edl and SHA256SUMS. No dependency: the ZIP reader below covers what the worker
// writes (stored and deflated entries, no encryption, ZIP64 sizes read from the central directory when present).
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { inflateRawSync } from "node:zlib";

const FFPROBE = process.env.FFPROBE_BIN ?? "ffprobe";

/** Entries of a ZIP as Map<name, Buffer>. Throws on anything it cannot read, so a malformed package cannot pass. */
export function readZip(path) {
  const buf = readFileSync(path);
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("not a ZIP: no end-of-central-directory record");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(p + 10);
    let csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24), local = buf.readUInt32LE(p + 42);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    // ZIP64: sizes and offset that did not fit 32 bits are in the 0x0001 extra field, in that order
    let e = p + 46 + nameLen;
    const end = e + extraLen;
    while (e + 4 <= end) {
      const id = buf.readUInt16LE(e), len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (usize === 0xffffffff) { usize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (csize === 0xffffffff) { csize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (local === 0xffffffff) { local = Number(buf.readBigUInt64LE(q)); q += 8; }
      }
      e += 4 + len;
    }
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    const data = method === 0 ? raw : method === 8 ? inflateRawSync(raw) : null;
    if (data === null) throw new Error(`${name}: compression method ${method} is not supported`);
    if (data.length !== usize) throw new Error(`${name}: size ${data.length} != ${usize}`);
    entries.set(name, Buffer.from(data));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

export const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** SHA256SUMS lines ("<hex>  <name>") against the entries: every other entry listed and matching, nothing unlisted. */
export function checkSums(entries) {
  const sums = entries.get("SHA256SUMS")?.toString("utf8");
  if (!sums) return { ok: false, problems: ["SHA256SUMS missing"] };
  const listed = new Map(sums.split("\n").filter(Boolean).map((l) => { const [h, ...n] = l.split("  "); return [n.join("  "), h]; }));
  const problems = [];
  for (const [name, data] of entries) {
    if (name === "SHA256SUMS") continue;
    if (!listed.has(name)) problems.push(`${name} is not in SHA256SUMS`);
    else if (listed.get(name) !== sha256(data)) problems.push(`${name} does not match its SHA256SUMS line`);
  }
  for (const name of listed.keys()) if (!entries.has(name)) problems.push(`SHA256SUMS lists ${name}, which is not in the package`);
  return { ok: problems.length === 0, problems };
}

/** CMX3600 event lines of the EDL: source in/out and record in/out as frame counts at `base` frames per second. */
export function parseEdl(text) {
  const events = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+)\s+(\S+)\s+(\S+)\s+C\s+(\d\d:\d\d:\d\d:\d\d)\s+(\d\d:\d\d:\d\d:\d\d)\s+(\d\d:\d\d:\d\d:\d\d)\s+(\d\d:\d\d:\d\d:\d\d)/.exec(line);
    if (m) events.push({ n: Number(m[1]), reel: m[2], track: m[3], srcIn: m[4], srcOut: m[5], recIn: m[6], recOut: m[7] });
  }
  const clip = /^\* FROM CLIP NAME:\s*(.+)$/m.exec(text)?.[1]?.trim() ?? null;
  return { events, clip };
}

/** Frames between two non-drop timecodes at `base` fps. */
export function tcFrames(tc, base) {
  const [h, m, s, f] = tc.split(":").map(Number);
  return ((h * 60 + m) * 60 + s) * base + f;
}

/** The FCPXML numbers the sequence is judged on: frame duration, sequence duration and the media path, as rationals in seconds. */
export function parseFcpxml(text) {
  const rational = (v) => { const m = /^(\d+)(?:\/(\d+))?s$/.exec(v ?? ""); return m ? Number(m[1]) / Number(m[2] ?? 1) : null; };
  const fd = /<format [^>]*frameDuration="([^"]+)"/.exec(text)?.[1];
  const seq = /<sequence [^>]*duration="([^"]+)"/.exec(text)?.[1];
  const clipDur = /<asset-clip [^>]*duration="([^"]+)"/.exec(text)?.[1];
  const src = /<media-rep [^>]*src="([^"]+)"/.exec(text)?.[1] ?? null;
  return { frameDuration: rational(fd), sequenceDuration: rational(seq), clipDuration: rational(clipDur), src };
}

/** ffprobe of one file: the facts the export must preserve (codec, size, rotation, colour tags, first timestamps, frame count). */
export function streamFacts(path) {
  const out = JSON.parse(execFileSync(FFPROBE, ["-v", "error", "-count_packets", "-show_format", "-show_streams", "-show_entries", "stream_side_data", "-of", "json", path], { maxBuffer: 64 * 1024 * 1024 }).toString());
  const v = out.streams.find((s) => s.codec_type === "video"), a = out.streams.find((s) => s.codec_type === "audio");
  const rot = (v?.side_data_list ?? []).find((d) => d.rotation !== undefined)?.rotation;
  return {
    container: out.format.format_name,
    streams: out.streams.length,
    video: v && { codec: v.codec_name, width: v.width, height: v.height, pix_fmt: v.pix_fmt, rotation: rot === undefined ? 0 : ((Math.round(Number(rot)) % 360) + 360) % 360,
      color_transfer: v.color_transfer ?? null, color_primaries: v.color_primaries ?? null, color_space: v.color_space ?? null,
      start_time: Number(v.start_time), packets: Number(v.nb_read_packets) },
    audio: a && { codec: a.codec_name, sample_rate: Number(a.sample_rate), start_time: Number(a.start_time), packets: Number(a.nb_read_packets) },
    duration: Number(out.format.duration),
    tags: JSON.stringify({ format: out.format.tags ?? {}, streams: out.streams.map((s) => s.tags ?? {}) }),
  };
}

/** Planted or GPS-shaped strings found in `buffers` (name -> Buffer): the names that carry any. */
export function leaks(buffers, planted) {
  const gps = /[+-]\d{1,3}\.\d{2,}[+-]\d{1,3}\.\d{2,}(?:[+-]\d+(?:\.\d+)?)?\//;
  const hits = [];
  for (const [name, buf] of buffers) {
    const text = buf.toString("latin1");
    if (planted.some((p) => text.includes(p)) || /ISO6709/i.test(text) || /com\.apple\.quicktime\.(location|make|model)/i.test(text) || gps.test(text)) hits.push(name);
  }
  return hits;
}
