/**
 * أيقونات v2 الخطّية (`icon/*` في صفحة `v2 — Components`): شبكة 24 بخط 1.8، تُلوَّن من لون النص الذي حولها (`currentColor`).
 * زخرفية دائمًا (`aria-hidden`): المعنى في الكلمة بجانبها، فلا تُترك حالة للأيقونة وحدها.
 */
const paths = {
  inbox: "M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6z",
  wall: "M3 5h18v11H3zM8 20h8M12 16v4",
  board: "M4 4h4v16H4zM10 4h4v10h-4zM16 4h4v13h-4z",
  tasks: "M9 12l2 2 4-4M4 6h3M4 12h2M4 18h3M12 18h8",
  upload: "M12 16V4M7 9l5-5 5 5M4 16v4h16v-4",
  mine: "M8 7a4 4 0 1 0 8 0 4 4 0 0 0-8 0M4 21a8 8 0 0 1 16 0",
  money: "M4 20V10M10 20V4M16 20v-7M2 20h20",
  form: "M12 3 3 8l9 5 9-5zM3 13l9 5 9-5",
  bell: "M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0",
  store: "M4 9l1.5-5h13L20 9M4 9v11h16V9M4 9h16M9 14h6",
  license: "M14 3H6v18h12V7zM14 3v4h4M9 13h6M9 17h4",
  orders: "M4 5h2l2 10h10l2-7H7M10 20a1 1 0 1 0 0-.1M17 20a1 1 0 1 0 0-.1",
  template: "M4 4h16v6H4zM4 14h7v6H4zM15 14h5v6h-5z",
  users: "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8M2 21a7 7 0 0 1 14 0M16 3.5a4 4 0 0 1 0 7.5M22 21a7 7 0 0 0-4-6.3",
  org: "M4 21V5l8-2v18M12 9h8v12M7 8h2M7 12h2M7 16h2M15 13h2M15 17h2M2 21h20",
  rules: "M4 6h10M4 12h16M4 18h7M17 4v4M14 16l2 2 4-4",
  payout: "M3 7h18v10H3zM12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0M6 10v4M18 10v4",
  percent: "M19 5 5 19M7 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4M17 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4",
  conflict: "M12 3 2 20h20zM12 10v4M12 17v.5",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2",
  preview: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14M21 21l-5-5",
  check: "M5 12.5 10 17l9-10",
  pencil: "M4 20h4L19 9l-4-4L4 16zM13.5 6.5l4 4",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 7v5l3 2",
  bolt: "M13 2 4 14h7l-1 8 9-12h-7z",
  shield: "M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z",
  alert: "M12 3 2 20h20zM12 10v4M12 17v.5",
  key: "M8 15a4 4 0 1 0 0-8 4 4 0 0 0 0 8M11 11h10M18 11v3M15 11v2",
  x: "M6 6l12 12M18 6 6 18",
  more: "M5 12h.01M12 12h.01M19 12h.01",
  filter: "M12 3 3 8l9 5 9-5zM3 13l9 5 9-5",
  offline: "M3 3l18 18M8.5 16.5a5 5 0 0 1 7 0M5 13a10 10 0 0 1 5-2.7M14 10.3A10 10 0 0 1 19 13M2 9.5a15 15 0 0 1 4.5-2.8M10.5 5.1A15 15 0 0 1 22 9.5M12 20h.01",
  ban: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M5.6 5.6l12.8 12.8",
  logout: "M15 4h4v16h-4M10 8l-4 4 4 4M6 12h11",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18",
  play: "M8 5v14l11-7z",
  menu: "M4 6h16M4 12h16M4 18h16",
} as const;

export type IconName = keyof typeof paths;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}

/** علامة المنصة: دوائر البثّ من شعار الشبكة (ADR 0085)، بلون الفعل الرئيسي الثابت لا بالتدرّج (التدرّج للأيقونة وزرّ الإرسال في تطبيق المراسل). */
export function BrandMark({ size = 32 }: { size?: number }) {
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" focusable="false">
    <rect width="32" height="32" rx="9" fill="currentColor" />
    <g fill="none" stroke="var(--v2-c-text-on-brand)" strokeWidth="1.8"><circle cx="16" cy="16" r="10" opacity=".55" /><circle cx="16" cy="16" r="6.5" /></g>
    <circle cx="16" cy="16" r="3" fill="var(--v2-c-text-on-brand)" />
  </svg>;
}
