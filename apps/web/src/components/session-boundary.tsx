"use client";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import type { Me } from "@/lib/types";
import { messages, type Locale } from "@/lib/i18n";
import { authPost, browserApi, dataOrThrow, leaveSession } from "@/lib/browser-api";
import { isBuyer } from "@/lib/buyer-policy";
import { hasRole } from "@/lib/review";
import { homePage } from "@/lib/home-page";
import { untilVisible } from "@/lib/visibility";
import { AccountActions, BottomBar, ShellState, ShellTopBar, Sidebar, useInboxBadge } from "./app-shell";
import { navItems } from "./workspace-nav";
import { CartProvider } from "./store/cart";
import { BrandMark, Icon } from "./icon";
import { EmptyState } from "./empty-state";

const UserContext = createContext<Me | null>(null);
export function useUser() { const me = useContext(UserContext); if (!me) throw new Error("Session required"); return me; }

export function SessionBoundary({ locale, children }: { locale: Locale; children: React.ReactNode }) {
  const m = messages[locale], pathname = usePathname(), router = useRouter();
  const [me, setMe] = useState<Me | null>(null), [error, setError] = useState(false), [confirmAll, setConfirmAll] = useState(false), [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0), [lastMe, setLastMe] = useState<Me | null>(null);
  const logoutPending = useRef(false);
  useEffect(() => {
    let disposed = false, sequence = 0;
    let controller = new AbortController();
    const clear = () => { sequence++; controller.abort(); setMe(null); };
    // الحالة الخاصة تُمحى كلها، ومعها آخر حساب معروف (الشريط وحده كان يُرسم منه أثناء الانقطاع).
    const wipe = () => { clear(); setLastMe(null); };
    const revoke = () => { if (!logoutPending.current) { wipe(); leaveSession(locale, "revoked"); } };
    // `keep`: العائد إلى تبويبه يبقى ما كان يعمل عليه مركّبًا ريثما يُتحقق من جلسته (ADR 0014، تعديل 2026-11-15)؛ في غير العودة يُمحى أولًا.
    const check = async (keep = false) => {
      if (keep) { sequence++; controller.abort(); } else clear();
      const current = sequence; controller = new AbortController();
      try {
        const result = await browserApi().GET("/auth/me", { signal: controller.signal });
        if (disposed || current !== sequence) return;
        // زائر بلا جلسة (لا كوكي): إلى صفحة الدخول بلا «أُبطلت الجلسة»، ويعود إلى رابطه بعد الدخول.
        if (result.response.status === 401 && (result.error as { code?: string } | undefined)?.code === "signed_out") { if (!logoutPending.current) { wipe(); leaveSession(locale, "none"); } return; }
        const data = dataOrThrow(result);
        setMe(old => (old && JSON.stringify(old) === JSON.stringify(data) ? old : data)); setLastMe(data); setError(false);
      } catch { if (!disposed && current === sequence && !controller.signal.aborted && !keep) setError(true); }
    };
    // إخفاء التبويب لا يزيل محتواه (حوار مفتوح، مسودة، بحث)؛ الاستطلاع ينتظر (`untilVisible`). عند العودة يُسأل الخادم عن الجلسة: 401 يمحو
    // ويحوّل إلى الدخول كما في كل طلب، وتعذّر الوصول يترك الصفحة لحالاتها (E3) ولا يمحو عملًا لم يُحفظ.
    const visibility = () => { if (document.visibilityState !== "hidden") void check(true); };
    const restored = (event: PageTransitionEvent) => { if (event.persisted) void check(); };
    const channel = "BroadcastChannel" in window ? new BroadcastChannel("web-session") : null;
    // خروج صاحب الجلسة في تبويب آخر خروجٌ هنا بالرسالة نفسها، لا «أُبطلت الجلسة»؛ وغيره (دخول حساب، جلسة انتهت) يُتحقق منه.
    // «signing-out» تسبق طلب الخروج: استطلاعٌ هنا يردّ 401 بين الطلب ورسالة تمامه لا يُقرأ إبطالًا. إن لم يتمّ الخروج عاد التبويب إلى حاله.
    let leaving: ReturnType<typeof setTimeout> | undefined;
    if (channel) channel.onmessage = event => {
      if (event.data === "signing-out") { logoutPending.current = true; clearTimeout(leaving); leaving = setTimeout(() => { logoutPending.current = false; }, 10000); return; }
      if (event.data === "signed-out") { wipe(); leaveSession(locale, "signed-out", false); return; }
      clear(); void check();
    };
    window.addEventListener("session-revoked", revoke);
    window.addEventListener("clear-private-state", wipe);
    window.addEventListener("pageshow", restored);
    document.addEventListener("visibilitychange", visibility);
    void check();
    return () => { disposed = true; controller.abort(); clearTimeout(leaving); channel?.close(); window.removeEventListener("session-revoked", revoke); window.removeEventListener("clear-private-state", wipe); window.removeEventListener("pageshow", restored); document.removeEventListener("visibilitychange", visibility); };
  }, [locale, attempt]);
  // E3: تعذّر الوصول إلى الخادم؛ نعيد المحاولة كل 15 ثانية وعند عودة الشبكة، والهيكل باقٍ.
  const offline = !me && error;
  useEffect(() => {
    if (!offline) return;
    const retry = () => setAttempt(n => n + 1), timer = setTimeout(retry, 15000);
    window.addEventListener("online", retry);
    return () => { clearTimeout(timer); window.removeEventListener("online", retry); };
  }, [offline, attempt]);

  async function logout(all: boolean) {
    // في الانقطاع (لا حساب محمّل) تبقى حالة E3 ظاهرة؛ فشل الخروج يُبقيها كما هي.
    logoutPending.current = true; setBusy(true); if (me) setError(false);
    if ("BroadcastChannel" in window) { const channel = new BroadcastChannel("web-session"); channel.postMessage("signing-out"); channel.close(); }
    try {
      const result = await authPost("logout", { all_sessions: all });
      if (result.response.ok || result.response.status === 401) { setMe(null); setLastMe(null); leaveSession(locale, result.response.status === 401 ? "revoked" : "signed-out"); }
      else setError(true);
    } catch { setError(true); }
    finally { logoutPending.current = false; setBusy(false); }
  }
  // حساب المشتري لا يرى صفحات الطاقم: المتجر ومؤسسته وحدهما.
  const buyer = !!me && isBuyer(me), buyerPage = /^\/(ar|en)\/(store|organization|security)(\/|$)/.test(pathname);
  useEffect(() => { if (buyer && !buyerPage) router.replace(`/${locale}/store`); }, [buyer, buyerPage, locale, router]);
  const languageHref = pathname.replace(`/${locale}`, locale === "ar" ? "/en" : "/ar");
  if (offline) return <OfflineShell locale={locale} me={lastMe} pathname={pathname} languageHref={languageHref} busy={busy} retry={() => setAttempt(n => n + 1)} logout={() => void logout(false)} />;
  if (!me || (buyer && !buyerPage)) return <main className="center-state" role="status"><span className="skeleton block" aria-hidden="true" />{m.loading}</main>;
  // جلسة مقيّدة (كلمة المرور عُيّنت وربط المصادقة لم يكتمل): كل صفحة تردّ 403، فتُشرح الحال والخطوة التالية بدل «خارج صلاحيات دورك».
  if (me.credential_reset_required) return <main className="center-state" data-testid="reset-incomplete">
    <EmptyState icon="key" role="alert" title={m.resetIncomplete.title} actions={<button type="button" disabled={busy} onClick={() => void logout(false)}><Icon name="logout" />{m.logout}</button>}>
      <p>{m.resetIncomplete.body}</p><p>{m.resetIncomplete.next}</p>
    </EmptyState>
  </main>;
  const items = navItems(me, locale, pathname), inboxHref = `/${locale}/${homePage(me)}`;
  const account = <AccountActions me={me} locale={locale} languageHref={languageHref} busy={busy} logout={() => void logout(false)} logoutAll={() => setConfirmAll(true)} />;
  // هيكل v2 (W1، M1، T1): الشريط الجانبي في جهة البداية، والشريط العلوي فوق المحتوى، والشريط السفلي على الجوال.
  // المشتري بلا شريط جانبي ولا سفلي (M4)، ووجه المتجر داكن صراحةً كما في إطارات S (`data-mode`).
  return <UserContext.Provider value={me}><CartProvider owner={me.user_id}><ShellState>{badge => <>
    <a className="skip-link" href="#main-content">{m.skip}</a>
    <div className={`app-shell${buyer ? " buyer" : ""}`} data-mode={buyer ? "dark" : undefined}>
      {!buyer && <Sidebar items={items} locale={locale} brandHref={inboxHref} badge={badge} />}
      <div className="app-main">
        <ShellTopBar me={me} locale={locale} buyer={buyer} items={items} inboxHref={inboxHref} account={account} />
        <main id="main-content" className="main-content">{error && <p className="notice error" role="alert">{m.error}</p>}{!buyer && <UrgentBadge me={me} skip={/^\/(ar|en)\/inbox(\/|$)/.test(pathname)} />}{children}</main>
      </div>
      {!buyer && <BottomBar items={items} locale={locale} badge={badge} account={account} />}
    </div>
    {confirmAll && <dialog className="modal" ref={node => { if (node && !node.open) node.showModal(); }} onCancel={() => setConfirmAll(false)} aria-labelledby="logout-title"><h2 id="logout-title">{m.logoutAll}</h2><p>{m.logoutAllWarning}</p><div className="actions"><button autoFocus className="secondary" disabled={busy} onClick={() => setConfirmAll(false)}>{m.cancel}</button><button className="danger" disabled={busy} onClick={() => void logout(true)}>{m.confirm}</button></div></dialog>}
  </>}</ShellState></CartProvider></UserContext.Provider>;
}

/**
 * الانقطاع (E3) بالهيكل لا بشاشة فارغة: عنوان الصفحة، والشريط بما يملكه آخر حساب معروف في هذا التبويب (لا يُخزَّن خارج الذاكرة؛ ولا شريط
 * إن لم يُعرف حساب بعد)، واللغة والخروج، ثم حالة الانقطاع بزرّ «أعد المحاولة الآن». محتوى الصفحة لا يُرسم حتى يعود الاتصال.
 */
function OfflineShell({ locale, me, pathname, languageHref, busy, retry, logout }: { locale: Locale; me: Me | null; pathname: string; languageHref: string; busy: boolean; retry: () => void; logout: () => void }) {
  const m = messages[locale], t = m.shell.offline, buyer = !!me && isBuyer(me), items = me ? navItems(me, locale, pathname) : [];
  const home = `/${locale}/${me ? homePage(me) : "inbox"}`, title = items.find(item => item.active)?.label ?? m.product;
  return <>
    <a className="skip-link" href="#main-content">{m.skip}</a>
    <div className={`app-shell${buyer || !me ? " buyer" : ""}`} data-mode={buyer ? "dark" : undefined} data-testid="offline-shell">
      {me && !buyer && <Sidebar items={items} locale={locale} brandHref={home} badge={null} />}
      <div className="app-main">
        <header className={`topbar workspace${buyer ? " store" : ""}`} data-testid="topbar">
          <Link prefetch={false} className={`topbar-brand${me && !buyer ? " compact" : ""}`} href={home} aria-label={m.product}><BrandMark />{(!me || buyer) && <span>{m.product}</span>}</Link>
          {buyer && <nav className="topbar-nav" aria-label={m.workspace}>{items.map(item => <Link key={item.key} prefetch={false} href={item.href} aria-current={item.active ? "page" : undefined}>{item.label}</Link>)}</nav>}
          <div className="topbar-end">
            <a className="button secondary small" href={languageHref} lang={locale === "ar" ? "en" : "ar"}><Icon name="globe" />{m.language}</a>
            <button type="button" className="secondary small" disabled={busy} onClick={logout}><Icon name="logout" />{m.logout}</button>
          </div>
        </header>
        <main id="main-content" className="main-content">
          <div className="page-head"><div><h1>{title}</h1></div></div>
          <EmptyState icon="offline" role="status" testId="offline-state" title={t.title} actions={<button onClick={retry}>{m.retry}</button>}><p>{t.body}</p></EmptyState>
        </main>
      </div>
      {me && !buyer && <BottomBar items={items} locale={locale} badge={null} account={<button type="button" className="menu-item" disabled={busy} onClick={logout}><Icon name="logout" />{m.logout}</button>} />}
    </div>
  </>;
}

/**
 * عدّاد بند الوارد: العاجل المفتوح من لقطة غرفة الأخبار كل 60 ثانية لأدوار اللوحة وحدها. صفحة الوارد تستطلع اللقطة نفسها كل 5 ثوانٍ
 * وتحدّث العدّاد منها، فلا يستطلع الهيكل هناك (`skip`)، كي لا يعمل مستطلعان لنقطة واحدة.
 */
function UrgentBadge({ me, skip }: { me: Me; skip: boolean }) {
  const set = useInboxBadge(), allowed = hasRole(me, "supervisor", "producer", "editor_in_chief", "rights_officer", "system_admin");
  useEffect(() => {
    if (!allowed || skip) return;
    const controller = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    async function poll() { await untilVisible(controller.signal); if (controller.signal.aborted) return; try { const data = dataOrThrow(await browserApi().GET("/dashboard/newsroom", { signal: controller.signal })); if (!controller.signal.aborted) set(data.urgent_open); } catch { /* يبقى بآخر قيمة */ } finally { if (!controller.signal.aborted) timer = setTimeout(poll, 60000); } }
    void poll(); return () => { controller.abort(); clearTimeout(timer); };
  }, [allowed, skip, set]);
  return null;
}
