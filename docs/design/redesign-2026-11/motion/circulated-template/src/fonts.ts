// الخطّان مضمَّنان في المشروع (من تطبيق iOS، برخصة OFL في public/fonts)، فلا يُجلب خط من الشبكة ولا من النظام وقت التصدير.
import { loadFont } from '@remotion/fonts';
import { staticFile } from 'remotion';

export const TITLE_FONT = 'PP Rubik';
export const TEXT_FONT = 'PP Readex Pro';

loadFont({ family: TITLE_FONT, url: staticFile('fonts/Rubik_700Bold.ttf'), weight: '700' });
loadFont({ family: TEXT_FONT, url: staticFile('fonts/ReadexPro_600SemiBold.ttf'), weight: '600' });
