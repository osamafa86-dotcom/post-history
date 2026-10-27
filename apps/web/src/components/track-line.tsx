import { messages, type Locale } from "@/lib/i18n";
import { flaggedTracks, segmentState, trackOrder, type SegmentState } from "@/lib/tracks";
import type { Material } from "@/lib/types";

type Tracks = Pick<Material, "technical_state" | "editorial_state" | "rights_state">;

/** جملة لقارئ الشاشة: «الفنية مكتملة، التحريرية جارية، الحقوق لم تبدأ» (وصف مكوّن Track Line في Figma). */
export function trackSentence(material: Tracks, locale: Locale) {
  const t = messages[locale].trackLine;
  return trackOrder.map(track => `${t.tracksDef[track]} ${t.states[segmentState(track, material[track])]}`).join(locale === "ar" ? "، " : ", ");
}

/**
 * خط المسارات الثلاثة (Figma 166:89): قطعة لكل مسار بالترتيب فنية ← تحريرية ← حقوق، تبدأ من اليمين في RTL.
 * الحالة بالشكل قبل اللون؛ القطع مخفية عن قارئ الشاشة والجملة هي الوصف. `note` يضيف سطر «تحريرية: تحتاج تعديلاً» لما يحتاج انتباهًا أو توقف.
 */
export function TrackLine({ material, locale, size = "row", note = false }: { material: Tracks; locale: Locale; size?: "row" | "wall" | "ticket"; note?: boolean }) {
  const m = messages[locale], flagged = note ? flaggedTracks(material) : [];
  return <div className={`track-cell ${size}`}>
    <span className="track-line" role="img" aria-label={trackSentence(material, locale)} data-testid="track-line">
      {trackOrder.map(track => <span key={track} className="track-seg" data-track={track} data-state={segmentState(track, material[track])} />)}
    </span>
    {flagged.length > 0 && <small className="track-note">{flagged.map(({ track, value }) => `${m.trackLine.tracks[track]}: ${(m.states[track] as Record<string, string>)[value]}`).join(locale === "ar" ? "، " : ", ")}</small>}
  </div>;
}

/** دليل ألوان القطع للوحة الكبيرة (Figma 193:873): الحالة الخمس بقطعة وتسمية. */
export function TrackLegend({ locale }: { locale: Locale }) {
  const t = messages[locale].trackLine, order: SegmentState[] = ["empty", "progress", "done", "attention", "blocked"];
  return <div className="track-legend">
    <ul aria-label={t.legendLabel}>{order.map(state => <li key={state}><span className="track-seg" data-state={state} aria-hidden="true" />{t.legendStates[state]}</li>)}</ul>
    <p>{t.legend}</p>
  </div>;
}
