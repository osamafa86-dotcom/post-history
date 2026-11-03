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
  chevron: "M9 6l6 6-6 6",
  download: "M12 4v11M7 10l5 5 5-5M4 20h16",
  film: "M4 4h16v16H4zM8 4v16M16 4v16M4 8h4M4 12h4M4 16h4M16 8h4M16 12h4M16 16h4",
  pin: "M12 21s-7-6.3-7-11.5a7 7 0 0 1 14 0C19 14.7 12 21 12 21M12 12a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5",
  printer: "M7 8V3h10v5M7 17H4v-7h16v7h-3M7 14h10v7H7z",
  cart: "M3 4h2l2.5 11h11L21 7H6.5M9.5 20a1 1 0 1 0 0-.1M17.5 20a1 1 0 1 0 0-.1",
  text: "M5 6h14M12 6v13M9 19h6",
  list: "M9 6h11M9 12h11M9 18h11M4 6h.01M4 12h.01M4 18h.01",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  hash: "M5 9h14M5 15h14M10 4 8 20M16 4l-2 16",
  toggle: "M7 7h10a5 5 0 0 1 0 10H7A5 5 0 0 1 7 7M7 10a2 2 0 1 0 0 4 2 2 0 0 0 0-4",
  clip: "M20 11.5 12 19.5a5 5 0 0 1-7-7L13.5 4a3.5 3.5 0 0 1 5 5L10 17.5a2 2 0 0 1-3-3L15 6.5",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4 21a8 8 0 0 1 16 0",
  tag: "M3 12V4h8l10 10-8 8zM7.5 8.5h.01",
  lock: "M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4",
  plus: "M12 5v14M5 12h14",
  grip: "M9 6h.01M15 6h.01M9 12h.01M15 12h.01M9 18h.01M15 18h.01",
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
