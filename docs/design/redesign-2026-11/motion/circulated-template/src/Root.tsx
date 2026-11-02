import React from 'react';
import { CalculateMetadataFunction, Composition, Folder } from 'remotion';
import { Aspect, CirculatedProps, CirculatedTemplate } from './CirculatedTemplate';

const SIZE: Record<Aspect, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 },
  square: { width: 1080, height: 1080 },
};

// العيّنات نصّ تجريبي ظاهر، لا عناوين أخبار ولا أماكن حقيقية: لقطة منها قد تُتداول خارج المستودع
// المقاس من `aspect`، ومعدل الإطارات من `fps` (25 أو 30 بحسب المصدر)، والمدة من `durationInSeconds` (ADR 0091)
const metadata: CalculateMetadataFunction<CirculatedProps> = ({ props }) => ({
  fps: props.fps,
  ...SIZE[props.aspect],
  durationInFrames: Math.max(3 * props.fps, Math.round(props.durationInSeconds * props.fps)),
});

const base: CirculatedProps = {
  titleLines: ['عنوان تجريبي', 'للمادة المتداولة'],
  location: 'مدينة، محافظة',
  tag: 'circulated_footage',
  aspect: 'vertical',
  fps: 30,
  background: 'plate',
  reducedMotion: false,
  durationInSeconds: 8,
};

const C: React.FC<{ id: string; props: Partial<CirculatedProps> }> = ({ id, props }) => {
  const p = { ...base, ...props };
  return (
    <Composition
      id={id}
      component={CirculatedTemplate}
      fps={p.fps}
      {...SIZE[p.aspect]}
      durationInFrames={Math.round(p.durationInSeconds * p.fps)}
      calculateMetadata={metadata}
      defaultProps={p}
    />
  );
};

export const Root: React.FC = () => (
  <>
    <Folder name="Preview">
      <C id="Circulated-Vertical" props={{}} />
      <C id="Circulated-Vertical-ThreeLines" props={{ titleLines: ['عنوان تجريبي', 'من ثلاثة أسطر', 'للمادة المتداولة'] }} />
      <C id="Circulated-Horizontal" props={{ aspect: 'horizontal' }} />
      <C id="Circulated-Square" props={{ aspect: 'square' }} />
      {/* VT-08: مصدر 16:9 في مخرج عمودي، المقدّمة عند y≈580 والخلفية مموّهة منه */}
      <C id="Circulated-Vertical-FromHorizontal" props={{ previewSource: 'horizontal' }} />
    </Folder>
    <Folder name="Checks">
      {/* سطر طويل: الكتلة كلها تصغر بنسبة واحدة حتى 70% ولا يلتفّ سطر */}
      <C id="Check-LongLine" props={{ titleLines: ['عنوان تجريبي أطول قليلًا من الحدّ', 'سطر ثانٍ قصير'] }} />
      {/* الغياب لا يرسم شيئًا: وسم `none` ومكان `null` */}
      <C id="Check-NoTagNoLocation" props={{ tag: 'none', location: null }} />
      {/* مصدر 25 إطارًا/ث: الطبقة تُرسم بمعدل الناتج نفسه */}
      <C id="Check-25fps" props={{ fps: 25 }} />
    </Folder>
    <Folder name="Overlay">
      {/* طبقة شفافة تُصدَّر ProRes 4444 وتُركَّب فوق المقطع المتداول بـ FFmpeg */}
      <C id="Overlay-Vertical" props={{ background: 'none' }} />
    </Folder>
  </>
);
