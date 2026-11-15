"use client";
import { useEffect, useState } from "react";
import { browserApi, dataOrThrow } from "@/lib/browser-api";
import { messages, type Locale } from "@/lib/i18n";

/**
 * للطاقم (المالية ومدير النظام) في «الطلبات» و«التراخيص الصادرة»: أسماء المؤسسات المشترية لعمودها، ومرشّحا المؤسسة والحالة إلى معاملات العقد
 * (`organization_id` و`status`). المشتري لا يراهما: نطاقه مؤسسته وحدها في الخادم.
 */
export function useOrganizationNames(enabled: boolean): Record<string, string> {
  const [names, setNames] = useState<Record<string, string>>({});
  useEffect(() => {
    if (!enabled) return;
    const controller = new AbortController();
    void (async () => {
      const found: Record<string, string> = {}; let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const data = dataOrThrow(await browserApi().GET("/buyer-organizations", { params: { query: { limit: 100, ...(cursor ? { cursor } : {}) } }, signal: controller.signal }));
        for (const o of data.items) found[o.id] = o.legal_name;
        cursor = data.next_cursor ?? undefined; if (!cursor) break;
      }
      if (!controller.signal.aborted) setNames(found);
    })().catch(() => { /* بلا الأسماء يبقى العمود بمعرّف قصير */ });
    return () => controller.abort();
  }, [enabled]);
  return names;
}

export const organizationLabel = (names: Record<string, string>, id: string) => names[id] ?? id.slice(0, 8).toUpperCase();

export function StaffFilters<S extends string>({ locale, names, organization, status, statuses, statusLabel, onChange }: { locale: Locale; names: Record<string, string>; organization: string; status: S | ""; statuses: readonly S[]; statusLabel: (s: S) => string; onChange: (next: { organization: string; status: S | "" }) => void }) {
  const m = messages[locale], f = m.staffFilters;
  return <div className="rule-row staff-filters" data-testid="staff-filters">
    <label>{f.organization}<select value={organization} onChange={e => onChange({ organization: e.target.value, status })}><option value="">{m.all}</option>{Object.entries(names).sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
    <label>{f.status}<select value={status} onChange={e => onChange({ organization, status: e.target.value as S | "" })}><option value="">{m.all}</option>{statuses.map(s => <option key={s} value={s}>{statusLabel(s)}</option>)}</select></label>
  </div>;
}
