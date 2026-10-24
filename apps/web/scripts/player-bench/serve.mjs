// تجربة محلية على عينات اصطناعية فقط؛ ليست مسارًا في تطبيق الإنتاج.
import { createServer } from "node:http";
import { readFile, stat, mkdir } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";

export async function serve() {
  if (process.env.WEB_PLAYER_BENCH !== "1") throw new Error("Set WEB_PLAYER_BENCH=1");
  const deps = resolve(".artifacts/player-deps");
  const requireBench = createRequire(join(deps, "package.json"));
  const { build } = requireBench("esbuild");
  const out = resolve(".artifacts/player-bench");
  const fixtures = resolve(process.env.WEB_PLAYER_FIXTURES ?? ".artifacts/player-fixtures");
  await mkdir(out, { recursive: true });
  const sizes = {};
  for (const player of ["videojs", "shaka"]) {
    await build({ entryPoints: [`scripts/player-bench/${player}.mjs`], outdir: out, bundle: true,
      format: "esm", minify: true, target: "es2022", define: { "process.env.NODE_ENV": '"production"' },
      nodePaths: [join(deps, "node_modules")], logLevel: "silent",
      plugins: [{
        name: "local-bench-dependencies",
        setup(builder) {
          builder.onResolve({ filter: /^(@videojs\/|shaka-player\/|react(?:-dom)?(?:\/|$))/ }, args => {
            return { path: requireBench.resolve(args.path) };
          });
          // controls.css يتضمن خط Roboto خارجيًا؛ يُحذف تعريف الخط فقط ويحافظ على إشعار الترخيص.
          builder.onLoad({ filter: /shaka-player[\\/]dist[\\/]controls\.css$/ }, async args => {
            const css = (await readFile(args.path, "utf8")).replace(/@font-face\s*\{[^}]*\}/g, "");
            if (/url\(\s*["']?https?:|@import/i.test(css)) throw new Error("Remote CSS dependency");
            return { contents: css, loader: "css" };
          });
        },
      }],
    });
    sizes[`${player}_js_gzip_bytes`] = gzipSync(await readFile(join(out, `${player}.js`))).byteLength;
    sizes[`${player}_css_gzip_bytes`] = gzipSync(await readFile(join(out, `${player}.css`))).byteLength;
  }
  const requests = [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1"), name = url.pathname;
    requests.push(name);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' blob:; connect-src 'self'; worker-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
    try {
      if (/^\/(videojs|shaka)$/.test(name)) {
        const player = name.slice(1);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.end(`<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${player}</title><link rel="stylesheet" href="/${player}.css"><link rel="stylesheet" href="/bench.css"></head><body><main><h1>${player}</h1><div id="player" class="bench-player"></div></main><script type="module" src="/${player}.js"></script></body></html>`);
        return;
      }
      if (name === "/bench.css") {
        res.setHeader("Content-Type", "text/css");
        res.end("body{margin:32px;background:#111827;color:#fff;font-family:system-ui}main{max-width:900px;margin:auto}.bench-player{width:100%;aspect-ratio:16/9;--shaka-font-family:system-ui}.bench-player video{width:100%;height:100%}");
        return;
      }
      let path;
      if (/^\/(videojs|shaka)\.(js|css)$/.test(name)) path = join(out, name.slice(1));
      else if (/^\/fixtures\/(vfr-offset|hdr-hlg)\/(hls\/(index\.m3u8|init\.mp4|seg_\d{5}\.m4s)|timeline\/(thumbnails\.vtt|sprite\.jpg)|captions\.ar\.vtt|proxy\.mp4)$/.test(name)) path = join(fixtures, name.slice("/fixtures/".length));
      else { res.writeHead(404).end(); return; }
      const bytes = await readFile(path), size = (await stat(path)).size;
      const mimes = { ".js": "text/javascript", ".css": "text/css", ".m3u8": "application/vnd.apple.mpegurl", ".mp4": "video/mp4", ".m4s": "video/iso.segment", ".vtt": "text/vtt", ".jpg": "image/jpeg" };
      res.setHeader("Content-Type", mimes[extname(path)]);
      res.setHeader("Accept-Ranges", "bytes");
      const match = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? "");
      if (match) {
        const start = Number(match[1]), end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
        if (start > end || start >= size) { res.writeHead(416).end(); return; }
        res.writeHead(206, { "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
        res.end(bytes.subarray(start, end + 1));
      } else { res.setHeader("Content-Length", size); res.end(bytes); }
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { origin: `http://127.0.0.1:${server.address().port}`, sizes, requests,
    close: () => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }) };
}
