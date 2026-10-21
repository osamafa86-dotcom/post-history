// طبقات الهوية للقالب العاجل: شريط الاسم والعنوان وشارة «عاجل»، بخلفية شفافة تُركَّب فوق الفيديو بـ FFmpeg.
// النص العربي يرسمه محرك المتصفح بخط Noto Naskh Arabic المضمَّن في الحزمة (لا خط من النظام ولا من الشبكة).
import '@fontsource/noto-naskh-arabic/700.css';
import '@fontsource/noto-naskh-arabic/400.css';
import React from 'react';
import { AbsoluteFill, Composition, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

const FONT = "'Noto Naskh Arabic', serif";

type LowerThirdProps = { name: string; role: string };

const LowerThird: React.FC<LowerThirdProps> = ({ name, role }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const enter = spring({ frame, fps, config: { damping: 200 } });
  const exit = interpolate(frame, [durationInFrames - 15, durationInFrames], [0, 1], { extrapolateLeft: 'clamp' });
  const x = interpolate(enter - exit, [0, 1], [700, 0]);
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'flex-start', padding: 90, direction: 'rtl' }}>
      <div style={{ transform: `translateX(${x}px)`, opacity: enter - exit, textAlign: 'right' }}>
        <div style={{ background: '#b3001b', color: 'white', fontFamily: FONT, fontWeight: 700, fontSize: 64,
          padding: '8px 36px', borderRadius: 6 }}>{name}</div>
        <div style={{ background: 'rgba(15,15,15,0.85)', color: 'white', fontFamily: FONT, fontSize: 40,
          padding: '6px 36px', marginTop: 6, borderRadius: 6 }}>{role}</div>
      </div>
    </AbsoluteFill>
  );
};

const Breaking: React.FC<{ label: string }> = ({ label }) => {
  const frame = useCurrentFrame();
  const pulse = 0.85 + 0.15 * Math.sin((frame / 30) * Math.PI * 2);
  return (
    <AbsoluteFill style={{ alignItems: 'flex-start', padding: 70, direction: 'rtl' }}>
      <div style={{ background: '#d10a0a', color: 'white', fontFamily: FONT, fontWeight: 700, fontSize: 56,
        padding: '4px 40px', borderRadius: 8, opacity: pulse }}>{label}</div>
    </AbsoluteFill>
  );
};

export const Root: React.FC = () => (
  <>
    <Composition id="LowerThird" component={LowerThird} durationInFrames={180} fps={30} width={1920} height={1080}
      defaultProps={{ name: 'مراسل الشبكة', role: 'غزة، بث مباشر' }} />
    <Composition id="Breaking" component={Breaking} durationInFrames={120} fps={30} width={1920} height={1080}
      defaultProps={{ label: 'عاجل' }} />
  </>
);
