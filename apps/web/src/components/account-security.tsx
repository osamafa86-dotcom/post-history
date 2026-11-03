"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { formatDate, longDate, messages, plural, type Locale, type PluralForms } from "@/lib/i18n";
import { cleanText, fill, stripHidden } from "@/lib/admin-text";
import { passkeyLimits, validPasskeyName, type Passkey, type PasskeyChallenge } from "@/lib/passkey-policy";
import { ceremonyFailure, passkeysSupported, registerCeremony } from "@/lib/passkey-client";
import { groupCode, type RecoveryCodes, type RecoveryCodeStatus } from "@/lib/recovery-policy";
import { useMutation } from "@/lib/use-mutation";
import { ConfirmDialog, LengthCounter, ToneBadge } from "./admin-parts";
import { Icon } from "./icon";

type Notice = { tone: "good" | "attention"; text: string } | null;
const still = () => () => {};

/**
 * الأمان (ADR 0107، 0108): مفاتيح المرور (قائمة وإضافة بإعادة تحقق وإبطال بتأكيد) والرموز الاحتياطية (العدد الباقي، وتوليد عشرة جديدة
 * تبطل السابقة بتأكيد وتُعرض مرة). لكل حساب بجلسة، طاقمًا أو مشتريًا. كلمة المرور والرموز في ذاكرة المكوّن وحده وتُمحى بعد الاستعمال.
 */
export function AccountSecurity({ locale }: { locale: Locale }) {
  const t = messages[locale].security;
  return <>
    <div className="page-head"><div><h1>{t.title}</h1><p className="muted">{t.lead}</p></div></div>
    <div className="security-grid">
      <PasskeysCard locale={locale} />
      <BackupCodesCard locale={locale} />
    </div>
  </>;
}

function PasskeysCard({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.security, supported = useSyncExternalStore(still, passkeysSupported, () => false), mutation = useMutation();
  const [items, setItems] = useState<Passkey[] | null>(null), [state, setState] = useState<"loading" | "ready" | "failed" | "off">("loading"), [attempt, setAttempt] = useState(0);
  const [adding, setAdding] = useState(false), [password, setPassword] = useState(""), [code, setCode] = useState(""), [name, setName] = useState(""), [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [notice, setNotice] = useState<Notice>(null), [revoking, setRevoking] = useState<Passkey | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/me/passkeys", { signal: controller.signal }).then(result => {
      if (controller.signal.aborted) return;
      if (result.response.status === 404) { setState("off"); return; }
      setItems(dataOrThrow(result).items); setState("ready");
    }).catch(() => { if (!controller.signal.aborted) setState("failed"); });
    return () => controller.abort();
  }, [attempt]);
  const label = cleanText(name), nameOk = !label || validPasskeyName(label), full = (items?.length ?? 0) >= passkeyLimits.max;
  function close() { setAdding(false); setPassword(""); setCode(""); setName(""); setChecked(false); setError(""); }
  async function add(event: React.FormEvent) {
    event.preventDefault(); setChecked(true); setError(""); setNotice(null);
    if (!password || !nameOk || code && !/^[0-9]{6}$/.test(code)) return;
    setBusy(true);
    try {
      const options = await browserApi().POST("/auth/passkeys/registration-options", { body: { password, ...(code ? { totp_code: code } : {}) } });
      const failure = (options.error as { code?: string } | undefined)?.code;
      if (options.response.status === 422) { setError(failure === "totp_required" ? t.totpRequired : t.stepUpFailed); return; }
      if (options.response.status === 404) { close(); setState("off"); return; }
      if (options.response.status === 409) { setError(t.limit); return; }
      if (options.response.status === 429) { setError(t.tooMany); return; }
      const challenge = dataOrThrow(options) as PasskeyChallenge;
      setPassword(""); setCode("");
      let credential;
      try { credential = await registerCeremony(challenge); }
      catch (reason) { const kind = ceremonyFailure(reason); setError(kind === "cancelled" ? t.cancelled : kind === "exists" ? t.exists : t.failed); return; }
      const box: { status?: number; code?: string; passkey?: Passkey } = {};
      const ok = await mutation.run(JSON.stringify(["passkey", challenge.challenge_id]), async header => {
        const result = await browserApi().POST("/me/passkeys", { params: { header }, body: { challenge_id: challenge.challenge_id, credential, ...(label ? { name: label } : {}) } });
        box.status = result.response.status; box.code = (result.error as { code?: string } | undefined)?.code; box.passkey = result.data; return result;
      });
      if (ok && box.passkey) { const added = box.passkey; setItems(list => [...(list ?? []).filter(item => item.id !== added.id), added]); close(); setNotice({ tone: "good", text: t.added }); return; }
      mutation.clearStatus();
      setError(box.status === 410 ? t.expired : box.status === 409 ? (box.code === "passkey_limit_reached" ? t.limit : t.exists) : t.failed);
    } catch { setError(m.error); } finally { setBusy(false); }
  }
  async function revoke() {
    if (!revoking) return;
    const target = revoking, box: { status?: number } = {};
    const ok = await mutation.run(JSON.stringify(["revoke-passkey", target.id]), async header => { const result = await browserApi().DELETE("/me/passkeys/{passkey_id}", { params: { path: { passkey_id: target.id }, header } }); box.status = result.response.status; return result; });
    // 404: أُبطل من قبل (تبويب آخر)؛ النتيجة نفسها.
    if (ok || box.status === 404) { mutation.clearStatus(); setRevoking(null); setItems(list => (list ?? []).filter(item => item.id !== target.id)); setNotice({ tone: "good", text: t.revoked }); }
  }
  return <section className="card security-card" aria-labelledby="passkeys-title" data-testid="passkeys">
    <h2 id="passkeys-title"><Icon name="key" />{t.passkeysTitle}</h2>
    <p className="muted">{t.passkeysLead}</p>
    {notice && <p className={`notice ${notice.tone}`} role="status" data-testid="passkeys-notice">{notice.text}</p>}
    {state === "loading" && <p className="muted" role="status">{m.loading}</p>}
    {state === "failed" && <p className="notice error" role="alert">{m.error} <button type="button" className="quiet small" onClick={() => { setState("loading"); setAttempt(n => n + 1); }}>{m.retry}</button></p>}
    {state === "off" && <p className="notice" data-testid="passkeys-off">{t.unavailable}</p>}
    {state === "ready" && items && <>
      {items.length ? <ul className="passkey-list">{items.map(item => <li key={item.id}><article aria-label={item.name ?? t.unnamed}>
        <div><strong><bdi>{item.name ?? t.unnamed}</bdi></strong>
          <p className="caption">{[fill(t.created, { date: longDate(item.created_at, locale) }), item.last_used_at ? fill(t.lastUsed, { date: formatDate(item.last_used_at, locale) }) : t.neverUsed].join(" · ")}</p></div>
        <ToneBadge tone={item.multi_device ? "brand" : "muted"} icon={item.multi_device ? "globe" : "lock"}>{item.multi_device ? t.synced : t.deviceOnly}</ToneBadge>
        <button type="button" className="secondary small" disabled={mutation.busy} onClick={() => { mutation.clearStatus(); setNotice(null); setRevoking(item); }}>{t.revoke}</button>
      </article></li>)}</ul> : <p className="muted" data-testid="passkeys-empty">{t.empty}</p>}
      {!supported ? <p className="notice" data-testid="passkeys-unsupported">{t.unsupported}</p> : full ? <p className="notice">{t.limit}</p>
        : adding ? <form className="invite-form security-form" noValidate onSubmit={event => void add(event)} data-testid="passkey-form">
          <h3>{t.stepUpTitle}</h3><p className="caption">{t.stepUpLead}</p>
          <label>{t.password}<input name="password" type="password" dir="ltr" autoComplete="current-password" maxLength={passkeyLimits.password} value={password} aria-invalid={checked && !password || undefined} onChange={event => setPassword(event.target.value)} /></label>
          <label>{t.totp}<input name="totp" inputMode="numeric" dir="ltr" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} value={code} onChange={event => setCode(event.target.value.replace(/\D/g, ""))} /></label>
          <label>{t.name}<input name="passkey-name" maxLength={passkeyLimits.name * 2} value={name} aria-invalid={checked && !nameOk || undefined} aria-describedby="passkey-name-help" onChange={event => setName(stripHidden(event.target.value))} /></label>
          <small id="passkey-name-help" className="field-help">{checked && !nameOk ? t.nameInvalid : t.nameHelp} <LengthCounter value={label} max={passkeyLimits.name} /></small>
          {busy && <p className="caption" role="status">{t.waiting}</p>}
          {error && <p className="notice error" role="alert">{error}</p>}
          <div className="actions"><button type="button" className="secondary" disabled={busy} onClick={close}>{m.cancel}</button><button disabled={busy}>{busy ? m.review.saving : t.continue}</button></div>
        </form> : <div className="actions"><button type="button" data-testid="add-passkey" onClick={() => { setNotice(null); setAdding(true); }}><Icon name="plus" />{t.add}</button></div>}
    </>}
    {revoking && <ConfirmDialog locale={locale} testId="confirm-revoke-passkey" title={t.revokeTitle} confirm={t.revoke} busy={mutation.busy} status={mutation.status} danger onConfirm={() => void revoke()} onCancel={() => setRevoking(null)}>
      <p>{fill(t.revokeEffect, { name: revoking.name ?? t.unnamed })}</p>
    </ConfirmDialog>}
  </section>;
}

function BackupCodesCard({ locale }: { locale: Locale }) {
  const m = messages[locale], t = m.security;
  const [status, setStatus] = useState<RecoveryCodeStatus | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const [confirming, setConfirming] = useState(false), [busy, setBusy] = useState(false), [actionStatus, setActionStatus] = useState(0), [codes, setCodes] = useState<RecoveryCodes | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void browserApi().GET("/auth/recovery-codes", { signal: controller.signal }).then(result => { if (!controller.signal.aborted) { setStatus(dataOrThrow(result)); setFailed(false); } })
      .catch(() => { if (!controller.signal.aborted) setFailed(true); });
    return () => controller.abort();
  }, [attempt]);
  // التوليد بلا مفتاح منع تكرار (مسار `/auth/*`): الرموز لا تُحفظ في جدول المفاتيح، فإعادة المحاولة تولّد مجموعة أخرى تبطل ما قبلها.
  async function generate() {
    setBusy(true); setActionStatus(0);
    try {
      const result = await browserApi().POST("/auth/recovery-codes");
      if (result.response.status === 401) window.dispatchEvent(new Event("session-revoked"));
      if (!result.response.ok || !result.data) { setActionStatus(result.response.status); return; }
      const fresh = result.data;
      setConfirming(false); setCodes(fresh); setStatus({ remaining: fresh.codes.length, generated_at: fresh.generated_at });
    } catch { setActionStatus(503); } finally { setBusy(false); }
  }
  return <section className="card security-card" aria-labelledby="codes-title" data-testid="backup-codes">
    <h2 id="codes-title"><Icon name="shield" />{t.codesTitle}</h2>
    <p className="muted">{t.codesLead}</p>
    {failed && <p className="notice error" role="alert">{m.error} <button type="button" className="quiet small" onClick={() => setAttempt(n => n + 1)}>{m.retry}</button></p>}
    {!status && !failed && <p className="muted" role="status">{m.loading}</p>}
    {codes ? <div className="one-time-link" data-testid="codes-once">
      <p className="notice" role="status">{t.codesOnce}</p>
      <ol className="backup-code-list mono" dir="ltr">{codes.codes.map(code => <li key={code}>{groupCode(code)}</li>)}</ol>
      <div className="actions"><button type="button" className="secondary" onClick={() => setCodes(null)}>{t.codesDone}</button></div>
    </div> : status && <>
      <p data-testid="codes-status"><strong>{status.generated_at ? plural(status.remaining, t.codesLeft as PluralForms, locale) : t.codesNone}</strong>
        {status.generated_at && <span className="caption"> · {fill(t.codesGenerated, { date: longDate(status.generated_at, locale) })}</span>}</p>
      <div className="actions"><button type="button" className={status.generated_at ? "secondary" : undefined} data-testid="generate-codes" onClick={() => { setActionStatus(0); setConfirming(true); }}>{status.generated_at ? t.regenerate : t.generate}</button></div>
    </>}
    {confirming && <ConfirmDialog locale={locale} testId="confirm-generate-codes" title={t.generateTitle} confirm={status?.generated_at ? t.regenerate : t.generate} busy={busy} status={actionStatus} onConfirm={() => void generate()} onCancel={() => setConfirming(false)}>
      <p>{t.generateEffect}</p>
    </ConfirmDialog>}
  </section>;
}
