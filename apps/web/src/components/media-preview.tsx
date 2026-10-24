"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { MaterialPlayer } from "./material-player";
import { messages, type Locale } from "@/lib/i18n";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import type { Material, MaterialFile } from "@/lib/types";

function PreviewAsset({ locale, materialId, file }: { locale: Locale; materialId: string; file: MaterialFile }) {
  const m = messages[locale], [attempt, setAttempt] = useState(0), [failed, setFailed] = useState(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => { controller.current = new AbortController(); return () => controller.current?.abort(); }, []);
  async function unavailable() {
    try {
      // أخطاء عناصر الوسائط لا تمر بعميل JSON؛ أعد فحص الإبطال قبل إعادة المحاولة مرة واحدة.
      dataOrThrow(await browserApi().GET("/auth/me", { signal: controller.current?.signal }));
      if (!controller.current?.signal.aborted) { if (attempt === 0) setAttempt(1); else setFailed(true); }
    } catch { if (!controller.current?.signal.aborted) setFailed(true); }
  }
  const source = `/api/bff/materials/${materialId}/files/${file.id}/content`;
  if (failed) return <div className="preview-empty" role="status"><p>{m.previewUnavailable}</p><button className="secondary" onClick={() => { setAttempt(0); setFailed(false); }}>{m.retry}</button></div>;
  if (file.kind === "proxy") return <MaterialPlayer key={attempt} source={source} locale={locale} onUnavailable={() => void unavailable()} />;
  return <div className="video-wrap" key={attempt}>
    <Image unoptimized src={source} width={320} height={180} alt={m.thumbnail} onError={() => void unavailable()} />
    <span className="watermark">{m.watermark}</span>
  </div>;
}

export function MediaPreview({ locale, material }: { locale: Locale; material: Material }) {
  const m = messages[locale];
  const verified = material.files.filter(file => file.state === "verified");
  const proxy = verified.find(file => file.kind === "proxy" && file.mime_type === "video/mp4");
  const thumbnails = verified.filter(file => file.kind === "thumbnail");
  return <section className="preview-panel" aria-label={m.preview}>
    {proxy ? <PreviewAsset key={`${material.id}-${proxy.id}`} locale={locale} materialId={material.id} file={proxy} /> : <div className="preview-empty"><span className="play-mark" aria-hidden="true" /><p>{m.previewUnavailable}</p></div>}
    {thumbnails.length > 0 && <div className="thumbnails">{thumbnails.map(file => <PreviewAsset key={`${material.id}-${file.id}`} locale={locale} materialId={material.id} file={file} />)}</div>}
  </section>;
}
