"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { permissionLabel } from "@/lib/admin-labels";
import { identityReasons } from "@/lib/admin-policy";
import { uuid } from "@/lib/query";
import type { PermissionHistoryPage } from "@/lib/types";

export function PermissionHistory({ id, revision, locale }: { id: string; revision: number; locale: Locale }) {
  const m = messages[locale], t = m.admin;
  const [loaded, setLoaded] = useState(false), [attempt, setAttempt] = useState(0), [cursors, setCursors] = useState<(string | undefined)[]>([undefined]);
  const [result, setResult] = useState<{ key: string; status: number; page?: PermissionHistoryPage } | null>(null);
  const cursor = cursors.at(-1), key = JSON.stringify([id, cursor, attempt, revision]);
  const current = result?.key === key ? result : null, page = current?.page, busy = loaded && !current;
  useEffect(() => {
    if (!loaded || !uuid.test(id)) return;
    const controller = new AbortController();
    async function load() {
      try {
        const page = dataOrThrow(await browserApi().GET("/users/{id}/permissions/history", { params: { path: { id }, query: { limit: 20, cursor } }, signal: controller.signal }));
        if (!controller.signal.aborted) setResult({ key, status: 200, page });
      } catch (error) { if (!controller.signal.aborted) setResult({ key, status: error instanceof RequestError ? error.status : 503 }); }
    }
    void load(); return () => controller.abort();
  }, [id, cursor, loaded, key]);
  return <section className="card" aria-labelledby="permission-history-title">
    <div className="page-heading"><h2 id="permission-history-title">{t.history}</h2><button className="secondary" disabled={!uuid.test(id) || busy} onClick={() => { setLoaded(true); setCursors([undefined]); setAttempt(n => n + 1); }}>{loaded ? m.refresh : t.loadHistory}</button></div>
    <p className="muted">{t.historyHelp}</p>
    {!loaded && <p>{t.selectHistoryUser}</p>}{busy && <p role="status">{m.loading}</p>}
    {current && !page && <p className="notice error" role="alert">{current.status === 403 ? t.denied : current.status === 404 ? t.historyMissing : m.error}</p>}
    {page && (page.items.length ? <ul className="history-list" data-testid="permission-history">{page.items.map(item => {
      const code = identityReasons.find(value => value === item.reason_code);
      return <li key={item.id}><strong>{t.historyKinds[item.kind]}</strong>
        {item.permission && <span>{permissionLabel(item.permission, locale)}</span>}
        {item.kind === "setting_changed" && item.value && <span>{t.identityTitle}: {t.accessOptions[item.value]} · {t.globalSetting}</span>}
        <span>{formatDate(item.occurred_at, locale)} · {m.review.actor}: <bdi>{item.actor_id ?? m.notAvailable}</bdi></span>
        {code && <span>{t.codedReason}: {t.reasonOptions[code]}</span>}
      </li>;
    })}</ul> : <p className="empty">{t.emptyHistory}</p>)}
    {loaded && <div className="pagination"><button className="secondary" disabled={busy || cursors.length === 1} onClick={() => setCursors(old => old.slice(0, -1))}>{m.previous}</button><span>{m.page} {cursors.length}</span><button className="secondary" disabled={busy || !page?.next_cursor} onClick={() => setCursors(old => [...old, page!.next_cursor!])}>{m.next}</button></div>}
  </section>;
}
