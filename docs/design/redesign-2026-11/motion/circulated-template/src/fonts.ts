// الخطّان مضمَّنان في المشروع (من تطبيق iOS، برخصة OFL في public/fonts)، فلا يُجلب خط من الشبكة ولا من النظام وقت التصدير.
import { useEffect, useState } from 'react';
import { loadFont } from '@remotion/fonts';
import { cancelRender, continueRender, delayRender, staticFile } from 'remotion';

export const TITLE_FONT = 'PP Rubik';
export const TEXT_FONT = 'PP Readex Pro';

// وعد التحميل مُصدَّر: `calculateMetadata` ينتظره قبل قياس العنوان، وإلا قاس بخطّ بديل
export const fontsReady = Promise.all([
  loadFont({ family: TITLE_FONT, url: staticFile('fonts/Rubik_700Bold.ttf'), weight: '700' }),
  loadFont({ family: TEXT_FONT, url: staticFile('fonts/ReadexPro_600SemiBold.ttf'), weight: '600' }),
]);

/**
 * لا يُرسم قالبٌ يقيس النص قبل تحميل الخطّين (ADR 0109، 0111): `measureText` يحفظ أول قياس لكل نصّ في ذاكرة الصفحة، فقياسٌ
 * قبل الخط يثبت عرض الخط البديل (لنسبة العنوان، ولكبسولة وسم «الشاهد») في كل إطارات تلك الصفحة. والمرسِم يوزّع الإطارات على
 * صفحات متوازية، فتختلف الإطارات بين صفحة وأخرى. `delayRender` يمنع التصوير حتى يُرسم القالب بالخطّين.
 */
export const useFontsLoaded = (label: string) => {
  const [handle] = useState(() => delayRender(label));
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    fontsReady.then(() => setLoaded(true), (err) => cancelRender(err));
  }, []);
  // بعد أن يُثبَّت الرسم بالقياس الصحيح، لا قبله
  useEffect(() => {
    if (loaded) continueRender(handle);
  }, [loaded, handle]);
  return loaded;
};
