import React from 'react';
import { CalculateMetadataFunction, Composition, Folder } from 'remotion';
import { CirculatedProps, CirculatedTemplate } from './CirculatedTemplate';
import { WitnessProps, WitnessTemplate } from './WitnessTemplate';

const FPS = 30;

// العيّنات نصّ تجريبي ظاهر، لا عناوين أخبار ولا أماكن حقيقية: لقطة منها قد تُتداول خارج المستودع
// مدة الفيديو من المعامل `durationInSeconds`، فيُضبط القالب على طول المقطع المتداول
const metadata: CalculateMetadataFunction<CirculatedProps> = ({ props }) => ({
  durationInFrames: Math.max(3 * FPS, Math.round(props.durationInSeconds * FPS)),
});

const witnessMeta: CalculateMetadataFunction<WitnessProps> = ({ props }) => ({
  durationInFrames: Math.max(4 * FPS, Math.round(props.durationInSeconds * FPS)),
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

export const Root: React.FC = () => (
  <>
    <Folder name="Preview">
      <Composition
        id="Circulated-Vertical"
        component={CirculatedTemplate}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={240}
        calculateMetadata={metadata}
        defaultProps={{
          titleLines: ['عنوان تجريبي', 'للمادة المتداولة'],
          location: 'مدينة، محافظة',
          tag: 'مشاهد متداولة',
          layout: 'vertical',
          background: 'plate',
          reducedMotion: false,
          durationInSeconds: 8,
        }}
      />
      <Composition
        id="Circulated-Vertical-ThreeLines"
        component={CirculatedTemplate}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={240}
        calculateMetadata={metadata}
        defaultProps={{
          titleLines: ['عنوان تجريبي', 'من ثلاثة أسطر', 'للمادة المتداولة'],
          location: 'مدينة، محافظة',
          tag: 'مشاهد متداولة',
          layout: 'vertical',
          background: 'plate',
          reducedMotion: false,
          durationInSeconds: 8,
        }}
      />
      <Composition
        id="Circulated-Horizontal"
        component={CirculatedTemplate}
        fps={FPS}
        width={1920}
        height={1080}
        durationInFrames={240}
        calculateMetadata={metadata}
        defaultProps={{
          titleLines: ['عنوان تجريبي', 'للمادة المتداولة'],
          location: 'مدينة، محافظة',
          tag: 'مشاهد متداولة',
          layout: 'horizontal',
          background: 'plate',
          reducedMotion: false,
          durationInSeconds: 8,
        }}
      />
      <Composition
        id="Circulated-Square"
        component={CirculatedTemplate}
        fps={FPS}
        width={1080}
        height={1080}
        durationInFrames={240}
        calculateMetadata={metadata}
        defaultProps={{
          titleLines: ['عنوان تجريبي', 'للمادة المتداولة'],
          location: 'مدينة، محافظة',
          tag: 'مشاهد متداولة',
          layout: 'square',
          background: 'plate',
          reducedMotion: false,
          durationInSeconds: 8,
        }}
      />
    </Folder>
    <Folder name="Checks">
      {/* سطر طويل (39 حرفًا): يصغر حتى 80% ثم يلتفّ داخل لوحه، ولا يُقصّ عند الحافة */}
      <Composition
        id="Check-LongLine"
        component={CirculatedTemplate}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={240}
        calculateMetadata={metadata}
        defaultProps={{
          titleLines: ['عنوان تجريبي طويل جدًا يتجاوز حدّ السطر', 'سطر ثانٍ قصير'],
          location: 'مدينة، محافظة',
          tag: 'مشاهد متداولة',
          layout: 'vertical',
          background: 'plate',
          reducedMotion: false,
          durationInSeconds: 8,
        }}
      />
    </Folder>
    <Folder name="Witness">
      <Composition id="Witness-Vertical" component={WitnessTemplate} fps={FPS} width={1080} height={1920} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('vertical', ['عنوان تجريبي', 'للمادة المتداولة'])} />
      <Composition id="Witness-Vertical-ThreeLines" component={WitnessTemplate} fps={FPS} width={1080} height={1920} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('vertical', ['عنوان تجريبي', 'من ثلاثة أسطر', 'للمادة المتداولة'])} />
      <Composition id="Witness-Horizontal" component={WitnessTemplate} fps={FPS} width={1920} height={1080} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('horizontal', ['عنوان تجريبي', 'للمادة المتداولة'])} />
      <Composition id="Witness-Square" component={WitnessTemplate} fps={FPS} width={1080} height={1080} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('square', ['عنوان تجريبي', 'للمادة المتداولة'])} />
      <Composition id="Witness-Overlay-Vertical" component={WitnessTemplate} fps={FPS} width={1080} height={1920} durationInFrames={240} calculateMetadata={witnessMeta} defaultProps={witness('vertical', ['عنوان تجريبي', 'للمادة المتداولة'], 'none')} />
    </Folder>
    <Folder name="Overlay">
      {/* طبقة شفافة تُصدَّر ProRes 4444 وتُركَّب فوق المقطع المتداول بـ FFmpeg */}
      <Composition
        id="Overlay-Vertical"
        component={CirculatedTemplate}
        fps={FPS}
        width={1080}
        height={1920}
        durationInFrames={240}
        calculateMetadata={metadata}
        defaultProps={{
          titleLines: ['عنوان تجريبي', 'للمادة المتداولة'],
          location: 'مدينة، محافظة',
          tag: 'مشاهد متداولة',
          layout: 'vertical',
          background: 'none',
          reducedMotion: false,
          durationInSeconds: 8,
        }}
      />
    </Folder>
  </>
);
