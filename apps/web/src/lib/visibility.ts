/**
 * التبويب المخفي لا يستطلع (ADR 0014، تعديل 2026-11-15): دورة الاستطلاع تنتظر هنا حتى يظهر التبويب ثم تكمل طلبها، فأول ما يراه العائد
 * بيانات جديدة. يُحسم فورًا والتبويب ظاهر، وعند إلغاء الإشارة (إزالة المكوّن) كي لا يبقى مستمع.
 */
export function untilVisible(signal?: AbortSignal): Promise<void> {
  if (typeof document === "undefined" || document.visibilityState !== "hidden" || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const done = () => {
      if (document.visibilityState === "hidden" && !signal?.aborted) return;
      document.removeEventListener("visibilitychange", done); signal?.removeEventListener("abort", done); resolve();
    };
    document.addEventListener("visibilitychange", done); signal?.addEventListener("abort", done);
  });
}
