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
import { TEXT_FONT, TITLE_FONT } from './fonts';

export type Layout = 'vertical' | 'horizontal' | 'square';

export type CirculatedProps = {
  readonly titleLines: string[];
  readonly location: string;
  readonly tag: string;
  readonly layout: Layout;
  /** صورة تجريبية للمعاينة، أو `none` لطبقة شفافة تُركَّب فوق الفيديو */
  readonly background: 'plate' | 'none';
  readonly reducedMotion: boolean;
  readonly durationInSeconds: number;
};

// الفيروزي المطوَّر (specs/video-template.md)
const C = {
  signal: '#42CFDF',
  logo: '#5CB0BE',
  deep: 'rgba(10, 70, 80, 0.9)',
  night: '6, 38, 45',
  gold: '#D0A030',
  ink: '#04232A',
};

// المقاسات كما في إطارات Figma VT-01 وVT-04 وVT-05
const L = {
  vertical: { m: 72, logoW: 300, logoTop: 220, bottom: 560, title: 66, tag: 28, loc: 32, plate: 'plates/plate-9x16.jpg' },
  horizontal: { m: 96, logoW: 300, logoTop: 72, bottom: 110, title: 64, tag: 28, loc: 32, plate: 'plates/plate-16x9.jpg' },
  square: { m: 64, logoW: 260, logoTop: 64, bottom: 96, title: 58, tag: 26, loc: 30, plate: 'plates/plate-1x1.jpg' },
} as const;

const EASE_IN = Easing.bezier(0.16, 1, 0.3, 1);
const EASE_OUT = Easing.bezier(0.7, 0, 0.84, 0);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

/** تقدّم الدخول (0→1) بين ثانيتين، وتقدّم الخروج (0→1) في آخر الفيديو بترتيب معكوس */
const useMotion = (reduced: boolean) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = (from: number, to: number) =>
    interpolate(frame, [from * fps, to * fps], [0, 1], { ...clamp, easing: EASE_IN });
  // الخروج يبدأ قبل النهاية بـ 0.6 ث؛ `order` يؤخّر الطبقات التي دخلت أولًا فتخرج أخيرًا
  const exit = (order: number) => {
    const start = durationInFrames - 0.6 * fps + order * 0.06 * fps;
    return interpolate(frame, [start, start + 0.3 * fps], [0, 1], { ...clamp, easing: EASE_OUT });
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
  layout,
  background,
  reducedMotion,
}) => {
  const { frame, fps, enter, exit } = useMotion(reducedMotion);
  const { width: W, height: H, durationInFrames } = useVideoConfig();
  const s = L[layout];
  const lines = titleLines.filter((l) => l.trim().length > 0).slice(0, 3);
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
  const kenBurns = interpolate(frame, [0, durationInFrames], [1, 1.06]);

  return (
    <AbsoluteFill style={{ backgroundColor: background === 'none' ? 'transparent' : '#06090d' }}>
      {background === 'plate' ? (
        <AbsoluteFill style={{ overflow: 'hidden' }}>
          <Img src={staticFile(s.plate)} style={{ width: '100%', height: '100%', objectFit: 'cover', scale: String(kenBurns) }} />
        </AbsoluteFill>
      ) : null}

      {/* 7 · التدرّجان */}
      <AbsoluteFill
        style={{
          opacity: scrim * (1 - xScrim),
          background: `linear-gradient(to bottom, rgba(0,0,0,0.45) 0%, rgba(0,0,0,0) ${Math.round(H * 0.22)}px, rgba(0,0,0,0) ${Math.round(
            H * 0.48,
          )}px, rgba(${C.night},0.55) ${Math.round(H * 0.69)}px, rgba(${C.night},0.94) 100%)`,
        }}
      />

      {/* 6 · حقل البثّ */}
      {rm ? null : (
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
          filter: 'drop-shadow(0 2px 8px rgba(0,0,0,0.35))',
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
        {/* 2 · الوسم */}
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
          {tag}
        </div>

        {/* 3 + 4 · الأسطر وعمود الإشارة */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'stretch' }}>
          <div
            style={{
              width: Math.max(8, Math.round(s.title * 0.18)),
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
                    padding: `${Math.round(s.title * 0.15)}px ${Math.round(s.title * 0.36)}px ${Math.round(s.title * 0.21)}px`,
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
                      fontSize: s.title,
                      lineHeight: 1.2,
                      color: '#FFFFFF',
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

        {/* 5 · المكان */}
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
            {location}
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
