/**
 * حاوية جدول تُمرَّر أفقيًا على الجوال: منطقة مسمّاة يصلها المفتاح Tab فتُمرَّر بالأسهم (axe `scrollable-region-focusable`، WCAG 2.1.1).
 * الاسم يقول ما في الجدول، ولا يكرّر عنوان القسم الذي يحويه.
 */
export function ScrollRegion({ label, className, children, testId }: { label: string; className: string; children: React.ReactNode; testId?: string }) {
  return <div className={className} role="region" aria-label={label} tabIndex={0} data-testid={testId}>{children}</div>;
}
