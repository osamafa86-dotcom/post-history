"use client";
import { useState } from "react";
import { messages, type Locale } from "@/lib/i18n";
import { browserApi } from "@/lib/browser-api";
import { uuid } from "@/lib/query";
import { workName } from "@/lib/work-name";
import { useMutation } from "@/lib/use-mutation";
import { ActionStatus } from "./action-status";

export function WorkNameEditor({ id, locale }: { id: string; locale: Locale }) {
  const t = messages[locale].admin, mutation = useMutation(), [value, setValue] = useState("");
  async function save(name: string | null) {
    if (!uuid.test(id)) return;
    if (await mutation.run(JSON.stringify([id, name]), header => browserApi().PUT("/users/{id}/work-name", { params: { path: { id }, header }, body: { work_name: name } }))) setValue("");
  }
  return <section className="card"><h2>{t.workName}</h2><p className="muted">{t.workNameHelp}</p>
    <label>{t.workName}<input value={value} maxLength={80} autoComplete="off" disabled={mutation.busy} onChange={e => setValue(e.target.value)} /></label>
    <div className="actions"><button disabled={!uuid.test(id) || !workName(value) || mutation.busy} onClick={() => void save(value)}>{t.workNameSave}</button><button className="secondary" disabled={!uuid.test(id) || mutation.busy} onClick={() => void save(null)}>{t.workNameClear}</button></div>
    {mutation.status === 422 ? <p role="alert" className="notice error">{t.workNameRejected}</p> : <ActionStatus status={mutation.status} locale={locale} />}
  </section>;
}
