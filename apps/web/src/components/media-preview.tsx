"use client";
import { useEffect, useRef, useState } from "react";
import Image from "next/image";
import { MaterialPlayer } from "./material-player";
import { messages, type Locale } from "@/lib/i18n";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import type { Material, MaterialFile } from "@/lib/types";
import { previewShape, staffPreview } from "@/lib/preview-policy";

function PreviewAsset({ locale, materialId, file, small }: { locale: Locale; materialId: string; file: MaterialFile; small?: boolean }) {
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
  if (file.kind === "proxy") return <MaterialPlayer key={attempt} source={source} locale={locale} onUnavailable={() => void unavailable()} shape={file.width && file.height ? previewShape(file.width, file.height) : undefined} />;
  return <div className="video-wrap" key={attempt}>
    <Image unoptimized src={source} width={320} height={180} alt={m.thumbnail} onError={() => void unavailable()} />
    <Mark locale={locale} small={small} />
  </div>;
}

/** العلامة المائية: نصها الكامل على المشغّل والملصق، وكلمة قصيرة على مصغّرات الشريط التي لا تسع النص فكان يُقصّ. */
function Mark({ locale, small }: { locale: Locale; small?: boolean }) {
  const m = messages[locale];
  return small ? <span className="watermark short">{m.watermarkShort}</span> : <span className="watermark">{m.watermark}</span>;
}

/** مصغّرة مقطع داخل زرّه: صورة بلا نص بديل (اسم الزر يكفي)، ورقم المقطع إن تعذّرت. */
function ClipPicture({ locale, materialId, file, number }: { locale: Locale; materialId: string; file: MaterialFile | null; number: number }) {
  const [broken, setBroken] = useState(false);
  if (!file || broken) return <span className="clip-number" aria-hidden="true">{number}</span>;
  return <span className="video-wrap"><Image unoptimized src={`/api/bff/materials/${materialId}/files/${file.id}/content`} width={320} height={180} alt="" onError={() => setBroken(true)} /><Mark locale={locale} small /></span>;
}

/**
 * معاينة الطاقم: النسخة الخفيفة التي أنتجها الخادم وحدها (`staffPreview`)، لا نسخة الهاتف المرفوعة. بلا نسخة من الخادم يظهر الملصق مكانها
 * مع «قيد التحضير»، أو الحالة وحدها إن لم يُنتَج ملصق بعد. المادة بعدة ملفات فيديو: مصغّرة كل مقطع زرّ يبدّل المشغّل إليه، وفوقها «1 من N».
 */
export function MediaPreview({ locale, material }: { locale: Locale; material: Material }) {
  const m = messages[locale], { poster, thumbnails, clips } = staffPreview(material), [chosen, setChosen] = useState<string | null>(null);
  const at = Math.max(0, clips.findIndex(clip => clip.proxy.id === chosen)), current = clips[at] ?? null, many = clips.length > 1;
  const count = (text: string, n: number) => text.replace("{n}", String(n)).replace("{total}", String(clips.length));
  // مصغّرات لا مقطع لها بعد (نسختها قيد التحضير) تبقى صورًا في الشريط؛ ومصغّرات المقاطع أزرارها.
  const paired = new Set(many ? clips.map(clip => clip.thumbnail?.id) : []), strip = (current ? thumbnails : thumbnails.filter(file => file !== poster)).filter(file => !paired.has(file.id));
  return <section className="preview-panel" aria-label={m.preview}>
    {current ? <PreviewAsset key={`${material.id}-${current.proxy.id}`} locale={locale} materialId={material.id} file={current.proxy} />
      : <div className="preview-empty" data-testid="preview-preparing">{poster ? <PreviewAsset key={`${material.id}-${poster.id}`} locale={locale} materialId={material.id} file={poster} /> : <span className="play-mark" aria-hidden="true" />}<p role="status">{material.files.some(file => file.kind === "original" || file.kind === "proxy") ? m.previewPreparing : m.previewNoFile}</p></div>}
    {many && <p className="clip-counter" role="status" data-testid="clip-counter">{count(m.clips.counter, at + 1)}</p>}
    {(many || strip.length > 0) && <div className="thumbnails" role={many ? "group" : undefined} aria-label={many ? m.clips.title : undefined}>
      {many && clips.map((clip, index) => <button key={clip.proxy.id} type="button" className="clip-button" data-testid="clip-button" aria-pressed={index === at} aria-label={count(m.clips.open, index + 1)} onClick={() => setChosen(clip.proxy.id)}><ClipPicture locale={locale} materialId={material.id} file={clip.thumbnail} number={index + 1} /></button>)}
      {strip.map(file => <PreviewAsset key={`${material.id}-${file.id}`} locale={locale} materialId={material.id} file={file} small />)}</div>}
  </section>;
}
