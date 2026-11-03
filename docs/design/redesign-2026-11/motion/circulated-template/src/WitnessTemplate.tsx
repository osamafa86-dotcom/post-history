// القالب الثاني للمواد المتداولة: «الشاهد».
// إطار من أربع زوايا مضيئة حول المشهد، ووسم ذهبي أسطواني، وعنوان بلا ألواح، وسطر مكان وتاريخ،
// وشريط جانبي لحساب صاحب المادة الأصلي. التصميم في Figma (صفحة «Video Template 2 · الشاهد»، VT2-01..07).
import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { measureText } from '@remotion/layout-utils';
import { TEXT_FONT, TITLE_FONT } from './fonts';

export type WitnessLayout = 'vertical' | 'horizontal' | 'square';

export type WitnessProps = {
  readonly titleLines: string[];
  /** المدينة والمحافظة وحدهما؛ فارغ = لا سطر مكان */
  readonly location: string;
  /** تاريخ التصوير مكتوبًا؛ فارغ = يُخفى */
  readonly date: string;
  /** الحساب العامّ الذي نشر المادة أوّلًا؛ فارغ = لا شريط. لا يُكتب لمصدر محميّ */
  readonly credit: string;
  /** «مشاهد متداولة»؛ فارغ = لا وسم */
  readonly tag: string;
  readonly layout: WitnessLayout;
  readonly background: 'plate' | 'none';
  readonly reducedMotion: boolean;
  readonly durationInSeconds: number;
};

// كل لون رمز من tokens.v2.json
const C = {
  signal: '#42CFDF', // color/brand/300
  signalRgb: '66, 207, 223',
  night: '10, 31, 38', // color/brand/950
  gold: '#D0A030', // color/accent/gold/500
  ink: '#0A1F26', // color/brand/950
};

// المقاسات كما في إطارات Figma (VT2-01 وVT2-03 وVT2-04)
const L = {
  vertical: {
    frame: { l: 72, r: 72, t: 200, b: 1360, arm: 120, th: 8 },
    inset: 44, logoW: 260, tag: 32, tagOff: 44, title: 84, loc: 34, blockRight: 160,
    scrimTop: 820, topScrim: 420, credit: 30, creditY: 780, plate: 'plates/plate-9x16.jpg',
  },
  horizontal: {
    frame: { l: 96, r: 96, t: 72, b: 1008, arm: 110, th: 8 },
    inset: 40, logoW: 260, tag: 28, tagOff: 40, title: 76, loc: 32, blockRight: 150,
    scrimTop: 420, topScrim: 260, credit: 26, creditY: 540, plate: 'plates/plate-16x9.jpg',
  },
  square: {
    frame: { l: 64, r: 64, t: 64, b: 1016, arm: 100, th: 7 },
    inset: 36, logoW: 230, tag: 28, tagOff: 36, title: 70, loc: 30, blockRight: 110,
    scrimTop: 420, topScrim: 260, credit: 24, creditY: 540, plate: 'plates/plate-1x1.jpg',
  },
} as const;

const LOGO_PLATE_ALPHA = 0.55; // كالقالب الأول: 3:1 على الأقل فوق لقطة بيضاء
const MIN_TITLE_SCALE = 0.7; // ADR 0091: تصغير الكتلة كلها بنسبة واحدة حتى 70%، بلا التفاف
// شريط الحساب: مدة كل ظهور، وأقلّ فاصل بين الظهورين قبل دمجهما في ظهور واحد
const CREDIT_DWELL = 5;
const CREDIT_GAP = 3;

const EASE = Easing.bezier(0.22, 1, 0.36, 1);
const EASE_EXIT = Easing.bezier(0.64, 0, 0.78, 0);
const clamp = { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' } as const;

const Rings: React.FC<{ size: number; pulse: number; pop: number }> = ({ size, pulse, pop }) => (
  <div style={{ position: 'relative', width: size, height: size, flexShrink: 0, scale: String(pop) }}>
    {[
      { d: 1, w: 2.5, o: 0.35 },
      { d: 0.7, w: 3, o: 0.65 },
      { d: 0.42, w: 3.5, o: 1 },
    ].map((r, i) => (
      <div
        key={i}
        style={{
          position: 'absolute',
          inset: (size * (1 - r.d)) / 2,
          borderRadius: '50%',
          border: `${r.w}px solid ${C.signal}`,
          opacity: r.o * (i === 0 ? 0.55 + 0.45 * pulse : 1),
          scale: i === 0 ? String(0.9 + 0.12 * pulse) : undefined,
        }}
      />
    ))}
    <div style={{ position: 'absolute', inset: size * 0.4, borderRadius: '50%', background: C.signal }} />
  </div>
);

/** زاوية من إطار الشاهد. dx/dy: جهة الذراعين (1 يمين/أسفل، -1 يسار/أعلى) */
const Corner: React.FC<{ x: number; y: number; dx: 1 | -1; dy: 1 | -1; arm: number; th: number; offset: number; opacity: number }> = ({
  x,
  y,
  dx,
  dy,
  arm,
  th,
  offset,
  opacity,
}) => {
  const left = (dx === 1 ? x : x - arm) - dx * offset;
  const top = (dy === 1 ? y : y - arm) - dy * offset;
  const glow = `0 0 16px rgba(${C.signalRgb},0.55)`;
  return (
    <div style={{ position: 'absolute', left, top, width: arm, height: arm, opacity }}>
      <div style={{ position: 'absolute', left: 0, top: dy === 1 ? 0 : arm - th, width: arm, height: th, background: C.signal, boxShadow: glow }} />
      <div style={{ position: 'absolute', left: dx === 1 ? 0 : arm - th, top: 0, width: th, height: arm, background: C.signal, boxShadow: glow }} />
    </div>
  );
};

export const WitnessTemplate: React.FC<WitnessProps> = ({
  titleLines,
  location,
  date,
  credit,
  tag,
  layout,
  background,
  reducedMotion: rm,
}) => {
  const frame = useCurrentFrame();
  const { fps, width: W, height: H, durationInFrames } = useVideoConfig();
  const s = L[layout];
  const f = s.frame;
  const t = frame / fps;
  const lines = titleLines.filter((l) => l.trim().length > 0).slice(0, 3);

  const enter = (from: number, to: number) => interpolate(t, [from, to], [0, 1], { ...clamp, easing: EASE });
  // الخروج في آخر 0.6 ث؛ order يؤخّر ما دخل أوّلًا فيخرج أخيرًا
  const exitAt = (order: number) => {
    const start = (durationInFrames - 0.6 * fps) / fps + order * 0.06;
    return interpolate(t, [start, start + 0.28], [0, 1], { ...clamp, easing: EASE_EXIT });
  };
  const sp = (at: number, damping = 18) =>
    rm ? enter(at, at + 0.3) : spring({ frame: frame - at * fps, fps, config: { damping, stiffness: 140, mass: 0.9 } });

  // الخروج المعكوس (الشريط له خروجه في نافذتيه، أدناه)
  const xDate = exitAt(1);
  const xLine = exitAt(2);
  const xTitle = exitAt(3);
  const xTag = exitAt(4);
  const xLogo = exitAt(5);
  const xCorners = exitAt(6);
  const xMatte = exitAt(7);

  // الثبات الدوري: نبضة كل 0.6 ث (18 إطارًا بـ 30، و15 بـ 25)، وتنفّس الزوايا كل 1.2 ث
  const pulse = rm ? 0 : 0.5 + 0.5 * Math.sin(((t - 1.5) / 0.6) * Math.PI * 2);
  const breathe = rm ? 0 : Math.sin((t / 1.2) * Math.PI * 2) * 2;

  // 1 · العتمة والتدرّجان
  const matte = enter(0, 0.3) * (1 - xMatte);
  // 2 · الزوايا: تنقبض من حافّة الإطار إلى مكانها
  const cIn = sp(0.1, 16);
  const cornerOffset = rm ? 0 : (1 - cIn) * 70 + breathe - xCorners * 40;
  const cornerOp = (rm ? enter(0.1, 0.4) : Math.min(1, cIn * 1.4)) * (1 - xCorners);
  // 3 · الشعار
  const logo = enter(0.3, 0.6) * (1 - xLogo);
  const logoH = s.logoW * (125 / 300);
  const lx = f.l + s.inset;
  const ly = f.t + s.inset;
  const plateRx = Math.round(((s.logoW / 2) * 1.414) / 0.6) + 20;
  const plateRy = Math.round(((logoH / 2) * 1.414) / 0.6) + 20;

  // 4 · كبسولة الوسم: نقطة ← كبسولة ← نصّ، والخروج بالعكس
  const tagH = Math.round(s.tag * 1.72);
  const tagPadX = Math.round(s.tag * 0.85);
  const tagTextW = tag ? measureText({ text: tag, fontFamily: TEXT_FONT, fontSize: s.tag, fontWeight: '600' }).width : 0;
  const tagFullW = Math.ceil(tagTextW + tagPadX * 2);
  const dotIn = rm ? 1 : sp(0.4, 14);
  const grow = rm ? 1 : sp(0.48, 20);
  const tagTextIn = enter(0.64, 0.8);
  const tagTextOut = interpolate(xTag, [0, 0.4], [0, 1], clamp);
  const shrink = interpolate(xTag, [0.3, 0.8], [0, 1], { ...clamp, easing: EASE_EXIT });
  const vanish = interpolate(xTag, [0.75, 1], [0, 1], clamp);
  const tagW = interpolate(Math.min(grow, 1) * (1 - shrink), [0, 1], [tagH, tagFullW]);
  const tagScale = (rm ? 1 : Math.min(dotIn, 1.05)) * (1 - vanish);
  const tagOpacity = (rm ? enter(0.4, 0.7) * (1 - xTag) : 1) * (tag ? 1 : 0);

  // 5 · العنوان: الكتلة كلها بنسبة واحدة حتى 70%، كلمةً كلمة من جهة القراءة
  const maxLineW = W - s.blockRight - f.l - s.inset;
  const widest = Math.max(1, ...lines.map((ln) => measureText({ text: ln, fontFamily: TITLE_FONT, fontSize: s.title, fontWeight: '700' }).width));
  const titleSize = Math.round(s.title * Math.max(MIN_TITLE_SCALE, Math.min(1, maxLineW / widest)));
  let wordIndex = 0;

  // 6 · خطّ الإشارة
  const lineIn = enter(1.3, 1.6) * (1 - xLine);
  // 7 · سطر المكان
  const ringsPop = rm ? 1 : sp(1.5, 12) * (1 - xDate);
  const dateIn = enter(1.62, 1.9) * (1 - xDate);
  // 8 · شريط الحساب: يظهر مرّتين (قرار المالك 2026-11-03)، بعد الدخول لمن بدأ المشاهدة، وقبل الخروج لمن وصل متأخّرًا.
  // كلّ ظهور CREDIT_DWELL ثانية. وإن قصر المقطع فتقاربت النافذتان (أقلّ من CREDIT_GAP بينهما) صارتا ظهورًا واحدًا متّصلًا.
  const D = durationInFrames / fps;
  const finalOut = D - 0.6;
  const firstIn = 1.8;
  const firstOut = firstIn + CREDIT_DWELL;
  const secondIn = finalOut - CREDIT_DWELL;
  const creditWindows =
    secondIn - firstOut < CREDIT_GAP
      ? [{ inAt: firstIn, outAt: finalOut }]
      : [
          { inAt: firstIn, outAt: firstOut },
          { inAt: secondIn, outAt: finalOut },
        ];
  const creditAt = (inAt: number, outAt: number) => {
    const x = interpolate(t, [outAt, outAt + 0.28], [0, 1], { ...clamp, easing: EASE_EXIT });
    return {
      line: enter(inAt, inAt + 0.15),
      slide: rm ? 1 : sp(inAt + 0.12, 17),
      name: enter(inAt + 0.35, inAt + 0.6),
      fade: rm ? enter(inAt + 0.1, inAt + 0.4) : 1,
      x,
      lineOut: interpolate(x, [0.4, 1], [0, 1], clamp),
      visible: t >= inAt - 0.05 && t <= outAt + 0.3,
    };
  };

  return (
    <AbsoluteFill style={{ backgroundColor: background === 'none' ? 'transparent' : `rgb(${C.night})`, overflow: 'hidden' }}>
      {background === 'plate' ? (
        <AbsoluteFill>
          <Img src={staticFile(s.plate)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </AbsoluteFill>
      ) : null}

      {/* 1 · العتمة خارج إطار الشاهد، والتدرّجان */}
      <AbsoluteFill style={{ opacity: matte }}>
        <div
          style={{
            position: 'absolute',
            left: f.l,
            top: f.t,
            width: W - f.l - f.r,
            height: f.b - f.t,
            borderRadius: 4,
            boxShadow: `0 0 0 ${Math.max(W, H)}px rgba(${C.night},0.32)`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: s.scrimTop,
            bottom: 0,
            background: `linear-gradient(to bottom, rgba(${C.night},0) 0%, rgba(${C.night},0.6) 50%, rgba(${C.night},0.92) 100%)`,
          }}
        />
        <div
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            top: 0,
            height: s.topScrim,
            background: `linear-gradient(to bottom, rgba(${C.night},0.45), rgba(${C.night},0))`,
          }}
        />
      </AbsoluteFill>

      {/* 2 · الزوايا */}
      <Corner x={f.l} y={f.t} dx={1} dy={1} arm={f.arm} th={f.th} offset={cornerOffset} opacity={cornerOp} />
      <Corner x={W - f.r} y={f.t} dx={-1} dy={1} arm={f.arm} th={f.th} offset={cornerOffset} opacity={cornerOp} />
      <Corner x={f.l} y={f.b} dx={1} dy={-1} arm={f.arm} th={f.th} offset={cornerOffset} opacity={cornerOp} />
      <Corner x={W - f.r} y={f.b} dx={-1} dy={-1} arm={f.arm} th={f.th} offset={cornerOffset} opacity={cornerOp} />

      {/* 3 · الشعار وهالته */}
      <AbsoluteFill
        style={{
          opacity: logo,
          background: `radial-gradient(ellipse ${plateRx}px ${plateRy}px at ${lx + s.logoW / 2}px ${ly + logoH / 2}px, rgba(${C.night},${LOGO_PLATE_ALPHA}) 0%, rgba(${C.night},${LOGO_PLATE_ALPHA}) 60%, rgba(${C.night},0) 100%)`,
        }}
      />
      <Img
        src={staticFile('brand/palpost-logo-white.png')}
        style={{ position: 'absolute', left: lx, top: ly, width: s.logoW, opacity: logo, translate: rm ? undefined : `0px ${(1 - logo) * -10}px` }}
      />

      {/* 4 · كبسولة الوسم، مثبّتة من جهة البداية فتتمدّد نحو اليسار */}
      {tag ? (
        <div
          style={{
            position: 'absolute',
            right: f.r + f.th + s.tagOff,
            top: f.t + f.th + Math.round(s.tagOff * 0.6),
            width: tagW,
            height: tagH,
            borderRadius: 999,
            background: C.gold,
            boxShadow: `0 4px 14px rgba(${C.night},0.35)`,
            overflow: 'hidden',
            opacity: tagOpacity,
            scale: String(tagScale),
            transformOrigin: 'right center',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <div
            dir="rtl"
            style={{
              fontFamily: TEXT_FONT,
              fontWeight: 600,
              fontSize: s.tag,
              lineHeight: 1,
              color: C.ink,
              whiteSpace: 'nowrap',
              paddingBottom: Math.round(s.tag * 0.08),
              opacity: tagTextIn * (1 - tagTextOut),
              translate: rm ? undefined : `${(1 - tagTextIn) * 10}px 0px`,
            }}
          >
            {tag}
          </div>
        </div>
      ) : null}

      {/* 5–7 · العنوان وخطّ الإشارة وسطر المكان */}
      <div
        dir="rtl"
        lang="ar"
        style={{
          position: 'absolute',
          right: s.blockRight,
          bottom: H - f.b + s.inset,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'flex-start',
          gap: Math.round(titleSize * 0.08),
        }}
      >
        {lines.map((line, li) => (
          <div
            key={li}
            style={{
              fontFamily: TITLE_FONT,
              fontWeight: 700,
              fontSize: titleSize,
              lineHeight: 1.18,
              whiteSpace: 'nowrap',
              color: li === 0 ? C.signal : '#FFFFFF',
              textShadow: `0 4px 24px rgba(${C.night},0.65), 0 1px 3px rgba(${C.night},0.5)`,
            }}
          >
            {line.split(/\s+/).map((word, wi, arr) => {
              const at = 0.6 + wordIndex++ * 0.09;
              const p = enter(at, at + 0.42);
              const out = interpolate(xTitle, [0, 1], [0, 1], clamp);
              return (
                <span
                  key={wi}
                  style={{
                    display: 'inline-block',
                    opacity: p * (1 - out),
                    translate: rm ? undefined : `0px ${(1 - p) * 16 + out * 10}px`,
                    filter: rm ? undefined : `blur(${(1 - p) * 8}px)`,
                    marginInlineStart: wi === arr.length - 1 ? 0 : undefined,
                  }}
                >
                  {word}
                  {wi < arr.length - 1 ? ' ' : ''}
                </span>
              );
            })}
          </div>
        ))}

        <div
          style={{
            width: Math.round(s.title * 2.8),
            height: Math.max(7, Math.round(s.title * 0.1)),
            borderRadius: 4,
            background: `linear-gradient(to left, ${C.signal}, rgba(${C.signalRgb},0.85) 55%, rgba(${C.signalRgb},0))`,
            boxShadow: `0 0 12px rgba(${C.signalRgb},0.6)`,
            transformOrigin: 'right center',
            scale: rm ? undefined : `${lineIn} 1`,
            opacity: rm ? lineIn : 1,
            marginTop: Math.round(titleSize * 0.06),
          }}
        />

        {location || date ? (
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: Math.round(s.loc * 0.45), marginTop: Math.round(s.loc * 0.15) }}>
            <Rings size={Math.round(s.loc * 1.3)} pulse={pulse} pop={ringsPop} />
            {location ? (
              <div
                style={{
                  fontFamily: TEXT_FONT,
                  fontWeight: 600,
                  fontSize: s.loc,
                  color: '#FFFFFF',
                  whiteSpace: 'nowrap',
                  textShadow: `0 2px 12px rgba(${C.night},0.5)`,
                  opacity: dateIn,
                  translate: rm ? undefined : `${(1 - dateIn) * 18}px 0px`,
                }}
              >
                {location}
              </div>
            ) : null}
            {location && date ? (
              <div style={{ fontFamily: TEXT_FONT, fontWeight: 600, fontSize: s.loc, color: C.signal, opacity: dateIn }}>·</div>
            ) : null}
            {date ? (
              <div
                style={{
                  fontFamily: TEXT_FONT,
                  fontWeight: 600,
                  fontSize: Math.round(s.loc * 0.88),
                  color: 'rgba(255,255,255,0.8)',
                  whiteSpace: 'nowrap',
                  textShadow: `0 2px 12px rgba(${C.night},0.5)`,
                  opacity: dateIn,
                  translate: rm ? undefined : `${(1 - dateIn) * 18}px 0px`,
                }}
              >
                {date}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {/* 8 · شريط الحساب الأصلي على الحافة اليسرى، يُقرأ من الأسفل إلى الأعلى */}
      {credit
        ? creditWindows.map(({ inAt, outAt }) => {
            const c = creditAt(inAt, outAt);
            if (!c.visible) return null;
            return (
              <React.Fragment key={inAt}>
                <div
                  style={{
                    position: 'absolute',
                    left: f.l - 1,
                    top: s.creditY - 160,
                    width: 3,
                    height: 320,
                    background: `linear-gradient(to top, ${C.signal}, rgba(${C.signalRgb},0))`,
                    transformOrigin: 'center bottom',
                    scale: `1 ${c.line * (1 - c.lineOut)}`,
                    opacity: 0.85,
                  }}
                />
                <div
                  style={{
                    position: 'absolute',
                    left: f.l,
                    top: s.creditY,
                    transform: `translate(-50%, -50%) rotate(-90deg) translateY(${rm ? 0 : (1 - Math.min(c.slide, 1)) * 90 + c.x * 110}px)`,
                    opacity: (rm ? c.fade : Math.min(1, c.slide * 1.6)) * (1 - interpolate(c.x, [0.5, 1], [0, 1], clamp)),
                    display: 'flex',
                    flexDirection: 'row',
                    alignItems: 'center',
                    gap: Math.round(s.credit * 0.45),
                    padding: `${Math.round(s.credit * 0.34)}px ${Math.round(s.credit * 0.8)}px ${Math.round(s.credit * 0.42)}px ${Math.round(s.credit * 0.5)}px`,
                    borderRadius: 999,
                    background: `rgba(${C.night},0.62)`,
                    border: `1.5px solid rgba(${C.signalRgb},0.55)`,
                    backdropFilter: 'blur(16px)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Rings size={Math.round(s.credit * 0.9)} pulse={pulse} pop={1} />
                  <div style={{ fontFamily: TEXT_FONT, fontWeight: 600, fontSize: s.credit, color: '#FFFFFF', opacity: c.name }} dir="ltr">
                    {credit}
                  </div>
                  <div style={{ fontFamily: TEXT_FONT, fontWeight: 600, fontSize: Math.round(s.credit * 0.82), color: 'rgba(255,255,255,0.72)', opacity: c.name }}>
                    بعدسة
                  </div>
                </div>
              </React.Fragment>
            );
          })
        : null}
    </AbsoluteFill>
  );
};
