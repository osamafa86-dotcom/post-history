"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Me } from "@/lib/types";
import { messages, type Locale } from "@/lib/i18n";
import { BrandMark, Icon } from "./icon";
import { NotificationsPanel } from "./notifications-panel";
import { bottomItems, initials, navGroups, userLine, type NavItem } from "./workspace-nav";
import { useCartCount } from "./store/cart";

/** بحث الشريط العلوي (`Web/Top bar`): يصل الوارد عبر هذا السياق، فالبحث داخل الصفحة المحمّلة كما كان (العقد بلا معامل بحث). */
const SearchContext = createContext<{ query: string; setQuery: (value: string) => void }>({ query: "", setQuery: () => {} });
export const useShellSearch = () => useContext(SearchContext);
/** عدّاد بند الوارد في الشريط الجانبي (العاجل المفتوح من لقطة غرفة الأخبار)؛ يختفي حين يكون صفرًا (E1). */
const BadgeContext = createContext<(value: number | null) => void>(() => {});
export const useInboxBadge = () => useContext(BadgeContext);

function NavLink({ item, badge, locale, onNavigate }: { item: NavItem; badge?: number | null; locale: Locale; onNavigate?: () => void }) {
  const m = messages[locale], describe = badge ? `nav-badge-${item.key}` : undefined;
  // وصف العدّاد خارج الرابط كي لا يدخل اسمه؛ يصل قارئ الشاشة بـ aria-describedby.
  return <><Link prefetch={false} href={item.href} className="nav-item" aria-current={item.active ? "page" : undefined} aria-describedby={describe} onClick={onNavigate}>
    <Icon name={item.icon} /><span className="nav-label">{item.label}</span><span className="nav-short" aria-hidden="true">{item.short}</span>
    {badge ? <span className="nav-badge" aria-hidden="true" dir="ltr">{badge}</span> : null}
  </Link>{badge ? <span id={describe} className="visually-hidden">{m.shell.urgentBadge.replace("{n}", String(badge))}</span> : null}</>;
}

/**
 * الشريط الجانبي (`Web/Sidebar`): في جهة البداية، بثلاث مجموعات وما يملكه الدور وحده (E5). كامل بعرض 240 من 1200، وشريط أيقونات بعرض 76
 * وتسميات قصيرة في 768–1199 (T1)، ويختفي دون 768 لصالح الشريط السفلي (M1). الاسم الكامل يبقى اسمَ الرابط في كل النقاط.
 */
export function Sidebar({ items, locale, brandHref, badge }: { items: NavItem[]; locale: Locale; brandHref: string; badge: number | null }) {
  const m = messages[locale];
  return <aside className="sidebar" data-testid="sidebar">
    <Link prefetch={false} className="sidebar-brand" href={brandHref}><BrandMark /><span>{m.product}</span></Link>
    <nav aria-label={m.workspace} className="sidebar-nav">{navGroups(items).map(([group, list]) => <div key={group} className="nav-group">
      <p className="nav-group-title">{m.shell.groups[group]}</p>
      <ul>{list.map(item => <li key={item.key}><NavLink item={item} locale={locale} badge={item.key === "inbox" ? badge : null} /></li>)}</ul>
    </div>)}</nav>
  </aside>;
}

/** الشريط السفلي على الجوال (M1): أربع وجهات و«المزيد» التي تفتح بقية الوجهات وأفعال الحساب في ورقة. */
export function BottomBar({ items, locale, badge, account }: { items: NavItem[]; locale: Locale; badge: number | null; account: React.ReactNode }) {
  const m = messages[locale], { primary, more } = bottomItems(items), [open, setOpen] = useState(false), moreActive = more.some(item => item.active);
  return <>
    <nav className="bottombar" aria-label={m.shell.bottomNav} data-testid="bottombar"><ul>
      {primary.map(item => <li key={item.key}><NavLink item={item} locale={locale} badge={item.key === "inbox" ? badge : null} /></li>)}
      <li><button type="button" className="nav-item" aria-expanded={open} aria-controls="more-sheet" aria-current={moreActive && !open ? "page" : undefined} onClick={() => setOpen(value => !value)}><Icon name="more" /><span className="nav-more">{m.shell.more}</span></button></li>
    </ul></nav>
    {open && <div className="more-sheet" id="more-sheet" role="dialog" aria-modal="false" aria-label={m.shell.more} onKeyDown={e => { if (e.key === "Escape") setOpen(false); }}>
      {more.length > 0 && <ul>{more.map(item => <li key={item.key}><NavLink item={item} locale={locale} onNavigate={() => setOpen(false)} /></li>)}</ul>}
      <div className="more-account">{account}</div>
    </div>}
  </>;
}

/** يغلق القائمة المنبثقة عند النقر خارجها. */
function useDismiss(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (ref.current && !ref.current.contains(event.target as Node)) close(); };
    document.addEventListener("pointerdown", outside); return () => document.removeEventListener("pointerdown", outside);
  }, [open, close]);
  return ref;
}

/** أفعال الحساب: سطر المستخدم (اسم العمل والدور، لا بريد)، واللغة، والخروج، والخروج من كل الأجهزة. */
export function AccountActions({ me, locale, languageHref, busy, logout, logoutAll }: { me: Me; locale: Locale; languageHref: string; busy: boolean; logout: () => void; logoutAll: () => void }) {
  const m = messages[locale];
  return <>
    <p className="account-line" data-testid="topbar-user">{userLine(me, locale)}</p>
    <Link prefetch={false} className="menu-item" href={`/${locale}/security`} data-testid="menu-security"><Icon name="lock" />{m.security.menu}</Link>
    <a className="menu-item" href={languageHref} lang={locale === "ar" ? "en" : "ar"}><Icon name="globe" />{m.language}</a>
    <button type="button" className="menu-item" disabled={busy} onClick={logout}><Icon name="logout" />{m.logout}</button>
    <button type="button" className="menu-item" onClick={logoutAll}><Icon name="logout" />{m.logoutAll}</button>
  </>;
}

/**
 * الشريط العلوي (`Web/Top bar`): البحث والجرس (لوحة W10) والحساب (`Web/Avatar`). على الجوال يصير البحث زرًّا يفتح الحقل.
 * البحث يعمل في الوارد؛ من صفحة أخرى يرسل إليه بالعبارة نفسها.
 */
export function ShellTopBar({ me, locale, buyer, items, inboxHref, account }: { me: Me; locale: Locale; buyer: boolean; items: NavItem[]; inboxHref: string; account: React.ReactNode }) {
  const m = messages[locale], t = m.shell, router = useRouter(), { query, setQuery } = useShellSearch();
  const [bell, setBell] = useState(false), [menu, setMenu] = useState(false), [searching, setSearching] = useState(false);
  const bellRef = useDismiss(bell, () => setBell(false)), menuRef = useDismiss(menu, () => setMenu(false)), onInbox = items.some(item => item.key === "inbox" && item.active);
  // Escape يغلق المنبثقة من أي عنصر فيها أو من زرّها، ويعيد التركيز إلى الزرّ.
  const escape = (open: boolean, close: () => void) => (event: React.KeyboardEvent<HTMLDivElement>) => { if (event.key === "Escape" && open) { close(); event.currentTarget.querySelector<HTMLButtonElement>("button")?.focus(); } };
  return <header className={`topbar workspace${buyer ? " store" : ""}`} data-testid="topbar">
    {buyer ? <>
      <Link prefetch={false} className="topbar-brand" href={`/${locale}/store`}><BrandMark /><span>{m.product}</span></Link>
      <nav className="topbar-nav" aria-label={m.workspace}>{items.map(item => <Link key={item.key} prefetch={false} href={item.href} aria-current={item.active ? "page" : undefined}>{item.label}</Link>)}</nav>
    </> : <>
      <Link prefetch={false} className="topbar-brand compact" href={inboxHref} aria-label={m.product}><BrandMark /></Link>
      <form role="search" className={`topbar-search${searching ? " open" : ""}`} onSubmit={event => { event.preventDefault(); if (!onInbox) router.push(inboxHref); }}>
        <label htmlFor="shell-search" className="visually-hidden">{m.inboxSearch.label}</label>
        <span className="search-icon"><Icon name="search" /></span>
        <input id="shell-search" type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder={m.inboxSearch.placeholder} aria-describedby="shell-search-help" maxLength={200} autoComplete="off" />
        <small id="shell-search-help" className="visually-hidden">{m.inboxSearch.help}</small>
      </form>
      <button type="button" className="icon-button search-toggle" aria-expanded={searching} aria-controls="shell-search" aria-label={t.searchOpen} onClick={() => setSearching(value => !value)}><Icon name="search" /></button>
    </>}
    <div className="topbar-end">
      {buyer && <CartChip locale={locale} />}
      {!buyer && <div className="popover-anchor" ref={bellRef} onKeyDown={escape(bell, () => setBell(false))}>
        <button type="button" className="icon-button" aria-label={t.bell.open} aria-expanded={bell} aria-haspopup="dialog" onClick={() => { setBell(value => !value); setMenu(false); }}><Icon name="bell" /></button>
        {bell && <NotificationsPanel locale={locale} onClose={() => setBell(false)} />}
      </div>}
      <div className="popover-anchor account" ref={menuRef} onKeyDown={escape(menu, () => setMenu(false))}>
        <button type="button" className="avatar" aria-label={`${t.account}: ${userLine(me, locale)}`} aria-expanded={menu} aria-controls="account-menu" onClick={() => { setMenu(value => !value); setBell(false); }}><span aria-hidden="true">{initials(me, locale)}</span></button>
        {menu && <div className="account-menu" id="account-menu">{account}</div>}
      </div>
    </div>
  </header>;
}

/** زرّ السلة في شريط المتجر (S1–S4، M4) بعدّاد بنودها؛ العدد في اسمه لقارئ الشاشة، والرقم الظاهر زخرفي. */
function CartChip({ locale }: { locale: Locale }) {
  const t = messages[locale].store.nav, count = useCartCount(), current = /^\/(ar|en)\/store\/cart(\/|$)/.test(usePathname() ?? "");
  return <Link prefetch={false} className="cart-chip" href={`/${locale}/store/cart`} aria-current={current ? "page" : undefined} aria-label={t.cartCount.replace("{n}", String(count))} data-testid="cart-chip">
    <Icon name="cart" /><span className="cart-chip-label">{t.cart}</span>{count > 0 && <span className="cart-chip-count" aria-hidden="true" dir="ltr">{count}</span>}
  </Link>;
}

/** مزوّدا السياقين: البحث وعدّاد الوارد. */
export function ShellState({ children, badge }: { children: (badge: number | null) => React.ReactNode; badge?: number | null }) {
  const [query, setQuery] = useState(""), [count, setCount] = useState<number | null>(badge ?? null);
  return <SearchContext.Provider value={{ query, setQuery }}><BadgeContext.Provider value={setCount}>{children(count)}</BadgeContext.Provider></SearchContext.Provider>;
}
