import React from 'react';
import { CalculateMetadataFunction, Composition, Folder } from 'remotion';
import { Aspect, assertTitleFits, CirculatedProps, CirculatedTemplate } from './CirculatedTemplate';
import { fontsReady } from './fonts';
import { assertWitnessTitleFits, WitnessProps, WitnessRender, WitnessTemplate } from './WitnessTemplate';

const SIZE: Record<Aspect, { width: number; height: number }> = {
  vertical: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 },
  square: { width: 1080, height: 1080 },
};

// العيّنات نصّ تجريبي ظاهر، لا عناوين أخبار ولا أماكن حقيقية: لقطة منها قد تُتداول خارج المستودع
// المقاس من `aspect`، ومعدل الإطارات من `fps` (25 أو 30 بحسب المصدر)، والمدة من `durationInSeconds` (ADR 0091)
// وسطرٌ لا يتّسع عند 70% يرمي `TitleOverflowError` (`code: 'title_overflow'`) قبل رسم أي إطار، فيبلغ عنه العامل بالرمز نفسه
const metadata: CalculateMetadataFunction<CirculatedProps> = async ({ props }) => {
  await fontsReady;
  assertTitleFits(props.titleLines, props.aspect, SIZE[props.aspect].width);
  return {
    fps: props.fps,
    ...SIZE[props.aspect],
    durationInFrames: Math.max(3 * props.fps, Math.round(props.durationInSeconds * props.fps)),
  };
};

// طبقة «الشاهد» في خط الإنتاج (ADR 0109): المعاملات والمعدل والمقاس كطبقة «مواد متداولة»، وسطرٌ لا يتّسع عند 70% في
// صندوق «الشاهد» يرمي `TitleOverflowError` قبل أي إطار. والمقطع لا يقصر عن 4 ث كتركيبات «الشاهد» في الأستوديو
const WITNESS_MIN_SECONDS = 4;
const witnessRenderMeta: CalculateMetadataFunction<CirculatedProps> = async ({ props }) => {
  await fontsReady;
  assertWitnessTitleFits(props.titleLines, props.aspect, SIZE[props.aspect].width);
  return {
    fps: props.fps,
    ...SIZE[props.aspect],
    durationInFrames: Math.max(WITNESS_MIN_SECONDS * props.fps, Math.round(props.durationInSeconds * props.fps)),
  };
};

const WFPS = 30;
const witnessMeta: CalculateMetadataFunction<WitnessProps> = ({ props }) => ({
  durationInFrames: Math.max(4 * WFPS, Math.round(props.durationInSeconds * WFPS)),
});

// القالب الثاني «الشاهد»: نصّ تجريبي ظاهر كالأول، والحساب عيّنة لا حساب حقيقي
const witness = (layout: WitnessProps['layout'], titleLines: string[], background: WitnessProps['background'] = 'plate'): WitnessProps => ({
  titleLines,
  location: 'مدينة، محافظة',
  date: '2 نوفمبر 2026',
  credit: '@sample_account',
  tag: 'مشاهد متداولة',
  layout,
  background,
  reducedMotion: false,
  durationInSeconds: 8,
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
    <Folder name="Witness">
      <Composition id="Witness-Vertical" component={WitnessTemplate} fps={WFPS} width={1080} height={1920} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('vertical', ['عنوان تجريبي', 'للمادة المتداولة'])} />
      <Composition id="Witness-Vertical-ThreeLines" component={WitnessTemplate} fps={WFPS} width={1080} height={1920} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('vertical', ['عنوان تجريبي', 'من ثلاثة أسطر', 'للمادة المتداولة'])} />
      <Composition id="Witness-Horizontal" component={WitnessTemplate} fps={WFPS} width={1920} height={1080} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('horizontal', ['عنوان تجريبي', 'للمادة المتداولة'])} />
      <Composition id="Witness-Square" component={WitnessTemplate} fps={WFPS} width={1080} height={1080} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('square', ['عنوان تجريبي', 'للمادة المتداولة'])} />
      {/* مقطع 20 ث: شريط الحساب يظهر مرّتين، بعد الدخول وقبل الخروج */}
      <Composition id="Witness-Vertical-Long" component={WitnessTemplate} fps={WFPS} width={1080} height={1920} durationInFrames={600} calculateMetadata={witnessMeta} defaultProps={{ ...witness('vertical', ['عنوان تجريبي', 'للمادة المتداولة']), durationInSeconds: 20 }} />
      <Composition id="Witness-Overlay-Vertical" component={WitnessTemplate} fps={WFPS} width={1080} height={1920} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('vertical', ['عنوان تجريبي', 'للمادة المتداولة'], 'none')} />
    </Folder>
    <Folder name="Overlay">
      {/* طبقة شفافة تُصدَّر ProRes 4444 وتُركَّب فوق المقطع المتداول بـ FFmpeg */}
      <C id="Overlay-Vertical" props={{ background: 'none' }} />
      {/* «الشاهد» بمعاملات العقد نفسها (ADR 0109): المقاس من `aspect`، والتاريخ والحساب فارغان دائمًا */}
      <Composition
        id="Witness-Overlay-Render"
        component={WitnessRender}
        fps={base.fps}
        {...SIZE[base.aspect]}
        durationInFrames={Math.round(base.durationInSeconds * base.fps)}
        calculateMetadata={witnessRenderMeta}
        defaultProps={{ ...base, background: 'none' }}
      />
    </Folder>
  </>
);
