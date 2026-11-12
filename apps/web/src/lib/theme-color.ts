/**
 * لون شريط المتصفح على الهاتف (`theme-color`): خلفية الشريط العلوي `--v2-c-bg-raised` في الوضعين الفاتح والداكن.
 * القيمتان من رموز التصميم؛ الوسم لا يقرأ متغيّرات CSS، فاختبار في `tests/touch-styles.test.ts` يطابقهما بـ `src/generated/tokens.css`.
 */
export const themeColor = { light: "#FFFFFF", dark: "#121A28" } as const;
