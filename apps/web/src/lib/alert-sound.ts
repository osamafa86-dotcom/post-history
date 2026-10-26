/** نغمة تنبيه قصيرة (ربع ثانية) بـ WebAudio؛ لا تعمل قبل أول تفاعل للمستخدم (قيد المتصفحات). */
export function beep() {
  try { const audio = new AudioContext(), tone = audio.createOscillator(), gain = audio.createGain(); tone.frequency.value = 880; gain.gain.value = 0.08; tone.connect(gain).connect(audio.destination); tone.start(); tone.stop(audio.currentTime + 0.25); tone.onended = () => void audio.close(); } catch { /* لا صوت في هذا المتصفح */ }
}
