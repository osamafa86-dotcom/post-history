// قالب المواد المتداولة: الشعار، وعنوان الفيديو، ومكان الحدث، ووسم «مشاهد متداولة».
// التصميم والتوقيت في docs/design/specs/video-template.md (لوحة VT-07 في Figma).
import React from 'react';
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import { measureText } from '@remotion/layout-utils';
import { TEXT_FONT, TITLE_FONT } from './fonts';

export type Aspect = 'vertical' | 'horizontal' | 'square';

// الأسماء تطابق العقد (ADR 0091): `aspect`، و`title_lines` ← `titleLines`، و`location_text` ← `location`، و`label` ← `tag`
export type CirculatedProps = {
  readonly titleLines: string[];
  /** نصّ يبنيه الخادم من حقلَي المادة؛ `null` أو الفارغ لا يرسم كبسولة */
  readonly location: string | null;
  /** `none` لا يرسم وسمًا، ونصّ الوسم من القالب لا من الطلب */
  readonly tag: 'circulated_footage' | 'none';
  readonly aspect: Aspect;
  /** معدل الإطارات من المصدر: 25 أو 30 (ADR 0091)، يُمرَّر عبر `calculateMetadata` */
  readonly fps: 25 | 30;
  /** صورة تجريبية للمعاينة، أو `none` لطبقة شفافة تُركَّب فوق الفيديو */
  readonly background: 'plate' | 'none';
  /** للمعاينة وحدها: `horizontal` يرسم مصدرًا 16:9 داخل إطار عمودي كما في VT-08 (الخلفية مموّهة، والمقدّمة عند y≈580) */
  readonly previewSource?: 'native' | 'horizontal';
  readonly reducedMotion: boolean;
  readonly durationInSeconds: number;
};

const TAG_TEXT = 'مشاهد متداولة';

// الفيروزي المطوَّر (specs/video-template.md). كل قيمة رمز من tokens.v2.json أو لون الشعار (ADR 0085)
const C = {
  signal: '#42CFDF', // color/brand/300
  logo: '#5CB0BE', // لون الشعار
  deep: 'rgba(10, 70, 80, 0.9)', // color/brand/800 بعتامة 90%
  night: '10, 31, 38', // color/brand/950 للتدرّجين وهالة الشعار
  gold: '#D0A030', // color/accent/gold/500
  ink: '#0A1F26', // color/brand/950 للنص فوق الفيروزي والذهبي
  shadow: 'rgba(10, 31, 38, 0.45)', // ظلّ الشعار: color/brand/950 بعتامة 45%، لا أسود خالص
};

// عتامة هالة الشعار: الأبيض فوق brand/950 بعتامة 55% فوق خلفية بيضاء = 3.86:1 (عنصر غير نصّي، الحدّ 3:1)
const LOGO_PLATE_ALPHA = 0.55;
// الكتلة كلها تصغر بنسبة واحدة حتى 70%، ولا يلتفّ سطر؛ وما لا يتّسع بعدها يفشل في العامل بـ `title_overflow` (ADR 0091)
export const MIN_TITLE_SCALE = 0.7;
// VT-08: مركز المقدّمة في المخرج العمودي حين يكون المصدر أعرض من 1:1 (16:9 يمتدّ نحو 276–884)
const FG_CENTER_Y = 580;

// المقاسات كما في إطارات Figma VT-01 وVT-04 وVT-05
const L = {
  // block: أقصى عرض للكتلة السفلية من عرض الإطار؛ الأفقي يبقى شريطًا سفليًا في جهة البداية لا يمتدّ على العرض كله
  vertical: { m: 72, logoW: 300, logoTop: 220, bottom: 560, title: 66, tag: 32, loc: 32, block: 1, plate: 'plates/plate-9x16.jpg' },
  horizontal: { m: 96, logoW: 300, logoTop: 72, bottom: 110, title: 64, tag: 28, loc: 32, block: 0.55, plate: 'plates/plate-16x9.jpg' },
  square: { m: 64, logoW: 260, logoTop: 64, bottom: 96, title: 58, tag: 26, loc: 30, block: 1, plate: 'plates/plate-1x1.jpg' },
} as const;

// الدخول بمنحنى ease-out (يبدأ سريعًا ويستقرّ)، والخروج بمنحنى ease-in (يبدأ هادئًا ويتسارع)
/** خطأ يتعرّف عليه العامل فيبلغ عنه بـ `title_overflow` (ADR 0091): سطر لا يتّسع حتى عند 70% */
export class TitleOverflowError extends Error {
  readonly code = 'title_overflow' as const;
  constructor(readonly lineIndex: number, readonly requiredScale: number) {
    super(`title_overflow: line ${lineIndex + 1} needs scale ${requiredScale.toFixed(3)} < ${MIN_TITLE_SCALE}`);
    this.name = 'TitleOverflowError';
  }
}

export const cleanLines = (titleLines: string[]) => titleLines.filter((l) => l.trim().length > 0).slice(0, 3);

/** هندسة العنوان: عرض السطر الأقصى، ونسبة الكتلة الواحدة، وأيّ سطر يتجاوز حدّ 70% (أو -1) */
export const titleFit = (titleLines: string[], aspect: Aspect, frameWidth: number) => {
  const s = L[aspect];
  const lines = cleanLines(titleLines);
  const padX = Math.round(s.title * 0.36);
  const accentW = Math.max(8, Math.round(s.title * 0.18));
  // عرض السطر الأقصى: الإطار ناقص الهامشين والعمود وحشوة اللوح
  const maxLineW = Math.min(frameWidth - 2 * s.m, Math.round(frameWidth * s.block)) - accentW - 2 * padX;
  const widths = lines.map((line) => measureText({ text: line, fontFamily: TITLE_FONT, fontSize: s.title, fontWeight: '700' }).width);
  const widest = Math.max(1, ...widths);
  const needed = Math.min(1, maxLineW / widest);
  const overflowLine = widths.findIndex((w) => maxLineW / w < MIN_TITLE_SCALE);
  return { lines, padX, accentW, maxLineW, needed, scale: Math.max(MIN_TITLE_SCALE, needed), overflowLine };
};

/** يرمي `TitleOverflowError` إن لم يتّسع سطر عند 70%؛ يُنادى من `calculateMetadata` بعد تحميل الخط */
export const assertTitleFits = (titleLines: string[], aspect: Aspect, frameWidth: number) => {
  const fit = titleFit(titleLines, aspect, frameWidth);
  if (fit.overflowLine >= 0) throw new TitleOverflowError(fit.overflowLine, fit.needed);
  return fit;
};

const EASE_OUT = Easing.bezier(0.16, 1, 0.3, 1);
const EASE_IN = Easing.bezier(0.7, 0, 0.84, 0);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** تقدّم الدخول (0→1) بين ثانيتين، وتقدّم الخروج (0→1) في آخر الفيديو بترتيب معكوس */
const useMotion = (reduced: boolean) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = (from: number, to: number) =>
    interpolate(frame, [from * fps, to * fps], [0, 1], { ...clamp, easing: EASE_OUT });
  // الخروج يبدأ قبل النهاية بـ 0.6 ث؛ `order` يؤخّر الطبقات التي دخلت أولًا فتخرج أخيرًا
  const exit = (order: number) => {
    const start = durationInFrames - 0.6 * fps + order * 0.06 * fps;
    return interpolate(frame, [start, start + 0.3 * fps], [0, 1], { ...clamp, easing: EASE_IN });
  };
  return { frame, fps, enter, exit, reduced };
};

const Rings: React.FC<{ size: number; color: string; pulse: number }> = ({ size, color, pulse }) => (
  <div style={{ position: 'relative', width: size, height: size, flexShrink: 0 }}>
    {[
      { d: 1, w: 2, o: 0.35 },
      { d: 0.7, w: 2.5, o: 0.6 },
      { d: 0.42, w: 3, o: 1 },
    ].map((r, i) => (
      <div
        key={i}
        style={{
          position: 'absolute',
          inset: (size * (1 - r.d)) / 2,
          borderRadius: '50%',
          border: `${r.w}px solid ${color}`,
          opacity: r.o * (i === 0 ? 0.6 + 0.4 * pulse : 1),
          scale: i === 0 ? String(0.92 + 0.08 * pulse) : undefined,
        }}
      />
    ))}
    <div style={{ position: 'absolute', inset: size * 0.4, borderRadius: '50%', background: color }} />
  </div>
);

/** موجات تتّسع من موضع المكان: واحدة كل 0.6 ث، تعيش 2.4 ث */
const BroadcastField: React.FC<{ cx: number; cy: number; maxR: number; start: number; fadeOut: number }> = ({
  cx,
  cy,
  maxR,
  start,
  fadeOut,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps - start;
  if (t < 0) return null;
  const period = 2.4;
  const every = 0.6;
  const waves = [];
  for (let k = Math.floor((t - period) / every); k <= Math.floor(t / every); k++) {
    const age = t - k * every;
    if (k < 0 || age < 0 || age > period) continue;
    const p = age / period;
    const r = maxR * (0.12 + 0.88 * Easing.out(Easing.quad)(p));
    waves.push(
      <div
        key={k}
        style={{
          position: 'absolute',
          left: cx - r,
          top: cy - r,
          width: r * 2,
          height: r * 2,
          borderRadius: '50%',
          border: `2.5px solid ${C.signal}`,
          opacity: 0.32 * (1 - p) * (1 - fadeOut),
        }}
      />,
    );
  }
  return <AbsoluteFill style={{ overflow: 'hidden', pointerEvents: 'none' }}>{waves}</AbsoluteFill>;
};

export const CirculatedTemplate: React.FC<CirculatedProps> = ({
  titleLines,
  location,
  tag,
  aspect,
  background,
  previewSource = 'native',
  reducedMotion,
}) => {
  const { frame, fps, enter, exit } = useMotion(reducedMotion);
  const { width: W, height: H, durationInFrames } = useVideoConfig();
  const s = L[aspect];
  const place = location && location.trim().length > 0 ? location : null;
  const showTag = tag === 'circulated_footage';
  const rm = reducedMotion;

  // الدخول (بالثواني) كما في خطة التحريك
  const scrim = enter(0, 0.4);
  const logo = enter(0.2, 0.6);
  const accent = enter(0.4, 0.9);
  const tagIn = enter(1.0, 1.3);
  const locIn = enter(1.2, 1.6);
  const field = enter(1.2, 1.6);
  const lineIn = (i: number) => enter(0.6 + i * 0.15, 1.1 + i * 0.15);
  const textIn = (i: number) => enter(0.68 + i * 0.15, 1.18 + i * 0.15);

  // الخروج المعكوس: المكان أولًا، ثم الوسم، ثم الأسطر، ثم العمود، ثم الشعار والتدرّج
  const xLoc = exit(0);
  const xTag = exit(1);
  const xLines = exit(2);
  const xAccent = exit(3);
  const xLogo = exit(4);
  const xScrim = exit(5);

  // نبض دوائر المكان، متزامن مع إطلاق الموجات
  const pulse = rm ? 0 : 0.5 + 0.5 * Math.sin(((frame / fps - 1.2) / 0.6) * Math.PI * 2);

  const ring = Math.round(s.loc * 1.25);
  const pillH = s.loc * 0.69 + ring;
  const cx = W - s.m - s.loc * 0.5 - ring / 2;
  const cy = H - s.bottom - pillH / 2;
  const fromHorizontal = aspect === 'vertical' && previewSource === 'horizontal';
  const fgH = Math.round((W * 9) / 16);
  // تكبير بطيء للصورة التجريبية، ويتوقف في وضع تقليل الحركة
  const kenBurns = rm ? 1 : interpolate(frame, [0, durationInFrames], [1, 1.06]);

  // نسبة واحدة للكتلة كلها: أعرض سطر يحدّدها، ولا تنزل تحت 70%. السطر لا يلتفّ أبدًا
  const { lines, padX, accentW, scale } = titleFit(titleLines, aspect, W);
  const titleSize = Math.floor(s.title * scale);

  // هالة الشعار: قطع ناقص يغطّي صندوق الشعار بعتامة ثابتة ثم يتلاشى
  const logoH = s.logoW * (125 / 300);
  const plateRx = Math.round((s.logoW / 2) * 1.414 / 0.6) + 20;
  const plateRy = Math.round((logoH / 2) * 1.414 / 0.6) + 20;

  return (
    <AbsoluteFill style={{ backgroundColor: background === 'none' ? 'transparent' : `rgb(${C.night})` }}>
      {background === 'plate' && !fromHorizontal ? (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <Img src={staticFile(s.plate)} style={{ width: '100%', height: '100%', objectFit: 'cover', scale: String(kenBurns) }} />
        </AbsoluteFill>
      ) : null}

      {/* VT-08 · مصدر أفقي في مخرج عمودي: ملء مموّه من الإطار نفسه، والمقدّمة كاملة بلا قصّ ومركزها عند y≈580 */}
      {background === 'plate' && fromHorizontal ? (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <Img
            src={staticFile(L.horizontal.plate)}
            style={{ width: '100%', height: '100%', objectFit: 'cover', filter: 'blur(36px) brightness(0.72)', scale: '1.15' }}
          />
          <Img
            src={staticFile(L.horizontal.plate)}
            style={{ position: 'absolute', left: 0, top: FG_CENTER_Y - fgH / 2, width: W, height: fgH, scale: String(kenBurns) }}
          />
        </AbsoluteFill>
      ) : null}

      {/* 7 · التدرّجان */}
      <AbsoluteFill
        style={{
          opacity: scrim * (1 - xScrim),
          background: `linear-gradient(to bottom, rgba(${C.night},0.45) 0%, rgba(${C.night},0) ${Math.round(H * 0.22)}px, rgba(0,0,0,0) ${Math.round(
            H * 0.48,
          )}px, rgba(${C.night},0.55) ${Math.round(H * 0.69)}px, rgba(${C.night},0.94) 100%)`,
        }}
      />

      {/* 1أ · هالة الشعار: تضمن قراءته فوق أي لقطة، حتى البيضاء */}
      <AbsoluteFill
        style={{
          opacity: logo * (1 - xLogo),
          background: `radial-gradient(ellipse ${plateRx}px ${plateRy}px at ${s.m + s.logoW / 2}px ${s.logoTop + logoH / 2}px, rgba(${C.night},${LOGO_PLATE_ALPHA}) 0%, rgba(${C.night},${LOGO_PLATE_ALPHA}) 60%, rgba(${C.night},0) 100%)`,
        }}
      />

      {/* 6 · حقل البثّ */}
      {rm || !place ? null : (
        <AbsoluteFill style={{ opacity: field }}>
          <BroadcastField cx={cx} cy={cy} maxR={Math.min(W, H) * 0.75} start={1.2} fadeOut={xLoc} />
        </AbsoluteFill>
      )}

      {/* 1 · الشعار */}
      <Img
        src={staticFile('brand/palpost-logo-white.png')}
        style={{
          position: 'absolute',
          left: s.m,
          top: s.logoTop,
          width: s.logoW,
          opacity: logo * (1 - xLogo),
          translate: rm ? undefined : `0px ${interpolate(logo, [0, 1], [-12, 0]) - xLogo * 12}px`,
          filter: `drop-shadow(0 2px 8px ${C.shadow})`,
        }}
      />

      {/* 2–5 · الكتلة السفلية، في جهة البداية */}
      <div
        dir="rtl"
        lang="ar"
        style={{
          position: 'absolute',
          right: s.m,
          bottom: s.bottom,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: Math.round(s.title * 0.27),
        }}
      >
        {/* 2 · الوسم: لا يُرسم مع `none` */}
        {showTag ? (
        <div
          style={{
            background: C.gold,
            color: C.ink,
            fontFamily: TEXT_FONT,
            fontWeight: 600,
            fontSize: s.tag,
            lineHeight: 1.3,
            padding: `${Math.round(s.tag * 0.28)}px ${Math.round(s.tag * 0.64)}px ${Math.round(s.tag * 0.36)}px`,
            borderRadius: 6,
            transformOrigin: 'right center',
            opacity: tagIn * (1 - xTag),
            scale: rm ? undefined : String(interpolate(tagIn, [0, 1], [0.9, 1])),
            translate: rm ? undefined : `${xTag * 30}px 0px`,
          }}
        >
          {TAG_TEXT}
        </div>
        ) : null}

        {/* 3 + 4 · الأسطر وعمود الإشارة */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'stretch' }}>
          <div
            style={{
              width: accentW,
              background: `linear-gradient(to bottom, ${C.signal}, ${C.logo})`,
              boxShadow: `0 0 22px rgba(66,207,223,${0.7 * accent})`,
              transformOrigin: 'center bottom',
              scale: rm ? undefined : `1 ${accent}`,
              opacity: (rm ? accent : 1) * (1 - xAccent),
            }}
          />
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: Math.round(s.title * 0.09) }}>
            {lines.map((line, i) => {
              const box = lineIn(i);
              const txt = textIn(i);
              return (
                <div
                  key={i}
                  style={{
                    background: C.deep,
                    padding: `${Math.round(s.title * 0.15)}px ${padX}px ${Math.round(s.title * 0.21)}px`,
                    // المسح من اليمين (جهة القراءة) إلى اليسار
                    clipPath: rm ? undefined : `inset(0 0 0 ${(1 - box) * 100}%)`,
                    opacity: (rm ? box : 1) * (1 - xLines),
                    translate: rm ? undefined : `${xLines * 30}px 0px`,
                  }}
                >
                  <div
                    style={{
                      fontFamily: TITLE_FONT,
                      fontWeight: 700,
                      fontSize: titleSize,
                      lineHeight: 1.2,
                      color: '#FFFFFF',
                      // لا التفاف: ما يتجاوز بعد 70% يرفضه العامل بـ `title_overflow`
                      whiteSpace: 'nowrap',
                      opacity: txt,
                      translate: rm ? undefined : `${(1 - txt) * 28}px 0px`,
                    }}
                  >
                    {line}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        {/* 5 · المكان: لا يُرسم بلا نصّ */}
        {place ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: Math.round(s.loc * 0.38),
            background: `linear-gradient(to left, ${C.signal}, ${C.logo})`,
            borderRadius: 999,
            padding: `${Math.round(s.loc * 0.31)}px ${Math.round(s.loc * 0.5)}px ${Math.round(s.loc * 0.38)}px ${Math.round(s.loc * 0.75)}px`,
            opacity: locIn * (1 - xLoc),
            translate: rm ? undefined : `${(1 - locIn) * 40 + xLoc * 30}px 0px`,
          }}
        >
          <Rings size={ring} color={C.ink} pulse={pulse} />
          <div style={{ fontFamily: TEXT_FONT, fontWeight: 600, fontSize: s.loc, lineHeight: 1.3, color: C.ink, whiteSpace: 'nowrap' }}>
            {place}
          </div>
        </div>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
