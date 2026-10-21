"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow, RequestError } from "@/lib/browser-api";
import { formatDate, messages, type Locale } from "@/lib/i18n";
import { identityAccesses, identityReasons } from "@/lib/admin-policy";
import type { ReporterIdentityAccess, ReporterIdentitySetting, ReporterIdentitySettingUpdate } from "@/lib/types";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";

export function IdentitySetting({ locale, onChanged }: { locale: Locale; onChanged: () => void }) {
  const m = messages[locale], t = m.admin, mutation = useMutation();
  const [data, setData] = useState<ReporterIdentitySetting | null>(null), [status, setStatus] = useState(0), [attempt, setAttempt] = useState(0);
  const [access, setAccess] = useState<ReporterIdentityAccess>("separate"), [reason, setReason] = useState<ReporterIdentitySettingUpdate["reason_code"] | "">("");
  const [intent, setIntent] = useState<ReporterIdentitySettingUpdate | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    async function load() {
      try {
        const result = dataOrThrow(await browserApi().GET("/admin/settings/reporter-identity", { signal: controller.signal }));
        if (!controller.signal.aborted) { setData(result); setAccess(result.access); setStatus(200); }
      } catch (error) { if (!controller.signal.aborted) setStatus(error instanceof RequestError ? error.status : 503); }
    }
    void load(); return () => controller.abort();
  }, [attempt]);
  async function apply() {
    if (!intent) return;
    let saved: ReporterIdentitySetting | undefined;
    const ok = await mutation.run(JSON.stringify(intent), async header => {
      const result = await browserApi().PUT("/admin/settings/reporter-identity", { params: { header }, body: intent }); saved = result.data; return result;
    });
    if (ok && saved) { setData(saved); setAccess(saved.access); setReason(""); setIntent(null); onChanged(); }
  }
  return <section className="card identity-setting" aria-labelledby="identity-setting-title">
    <h2 id="identity-setting-title">{t.identityTitle}</h2><p className="muted">{t.identityHelp}</p>
    {!data ? <><p role={status ? "alert" : "status"}>{status === 403 ? t.denied : status ? m.error : m.loading}</p>{status !== 0 && <button className="secondary" onClick={() => { setStatus(0); setAttempt(n => n + 1); }}>{m.retry}</button>}</> : <>
      <p>{t.currentAccess}: <strong>{t.accessOptions[data.access]}</strong></p>
      <p className="muted">{m.updated}: {formatDate(data.updated_at, locale)} · {m.review.actor}: <bdi>{data.updated_by ?? t.defaultSetting}</bdi></p>
      <div className="field-grid">
        <label>{t.identityAccess}<select aria-label={t.identityAccess} value={access} disabled={mutation.busy || !!intent} onChange={event => { setAccess(event.target.value as ReporterIdentityAccess); mutation.clearStatus(); }}>{identityAccesses.map(value => <option key={value} value={value}>{t.accessOptions[value]}</option>)}</select></label>
        <label>{t.codedReason}<select aria-label={t.codedReason} value={reason} disabled={mutation.busy || !!intent} onChange={event => setReason(event.target.value as typeof reason)}><option value="">{m.choose}</option>{identityReasons.map(value => <option key={value} value={value}>{t.reasonOptions[value]}</option>)}</select></label>
      </div>
      <p className="notice">{access === "protected_source" ? t.sourceAccessWarning : t.separateAccessHelp}</p>
      <button disabled={mutation.busy || !reason || access === data.access} onClick={() => { if (reason) { mutation.clearStatus(); setIntent({ access, reason_code: reason }); } }}>{t.saveSetting}</button>
      {!intent && <ActionStatus status={mutation.status} locale={locale} />}
    </>}
    {intent && <dialog className="modal" ref={node => { if (node && !node.open) node.showModal(); }} aria-labelledby="confirm-identity-title" onCancel={event => { if (mutation.busy) event.preventDefault(); else setIntent(null); }}>
      <h2 id="confirm-identity-title">{t.confirmSetting}</h2><p>{t.accessOptions[data!.access]} {m.review.to} {t.accessOptions[intent.access]}</p>
      <p>{intent.access === "protected_source" ? t.sourceAccessWarning : t.separateAccessHelp}</p><p>{t.codedReason}: {t.reasonOptions[intent.reason_code]}</p><p className="muted">{t.settingAudit}</p>
      <ActionStatus status={mutation.status} locale={locale} /><div className="actions"><button autoFocus className="secondary" disabled={mutation.busy} onClick={() => setIntent(null)}>{m.cancel}</button><button disabled={mutation.busy} onClick={() => void apply()}>{mutation.busy ? m.review.saving : t.confirm}</button></div>
    </dialog>}
  </section>;
}
