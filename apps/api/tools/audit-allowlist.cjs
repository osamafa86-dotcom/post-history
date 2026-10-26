#!/usr/bin/env node
// فحص ثغرات الاعتمادات التشغيلية (ADR 0040): يفشل عند أي إرشاد بشدة high أو أعلى، إلا ما في audit-allowlist.json
// باستثناء موثق (المعرّف والسبب وتاريخ الإضافة وشرط الحذف). لا يخفض العتبة: إرشاد جديد بأي معرّف آخر يُفشل CI.
// الاستعمال: node tools/audit-allowlist.cjs  (في apps/api، بعد npm ci)
'use strict';
const { execFileSync } = require('node:child_process');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

const RANK = { info: 0, low: 1, moderate: 2, high: 3, critical: 4 };

function advisories(report) {
  const found = new Map();
  for (const v of Object.values(report.vulnerabilities ?? {})) {
    for (const via of v.via ?? []) {
      if (typeof via !== 'object' || !via.url) continue;
      const id = via.url.split('/').pop();
      if ((RANK[via.severity] ?? 0) >= RANK.high) found.set(id, { id, severity: via.severity, package: via.name });
    }
  }
  return [...found.values()];
}

function check(report, allowlist, today = new Date().toISOString().slice(0, 10)) {
  const allowed = new Map(allowlist.map((a) => [a.id, a]));
  for (const a of allowlist) {
    for (const key of ['id', 'reason', 'added', 'expires', 'removal_condition']) {
      if (typeof a[key] !== 'string' || a[key].trim() === '') throw new Error(`allowlist entry ${a.id ?? '?'} lacks ${key}`);
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(a.added) || !/^\d{4}-\d{2}-\d{2}$/.test(a.expires)) throw new Error(`allowlist entry ${a.id} has a malformed date`);
    if (a.added > today) throw new Error(`allowlist entry ${a.id} is dated in the future`);
    // الاستثناء مؤقت: ينتهي خلال 60 يومًا من إضافته على الأكثر، ويُفشل الفحص بعد انتهائه حتى يُراجَع
    const maxExpiry = new Date(Date.parse(`${a.added}T00:00:00Z`) + 60 * 86_400_000).toISOString().slice(0, 10);
    if (a.expires > maxExpiry) throw new Error(`allowlist entry ${a.id} expires more than 60 days after it was added`);
    if (today > a.expires) throw new Error(`allowlist entry ${a.id} expired on ${a.expires}; review it`);
  }
  const found = advisories(report);
  return {
    blocking: found.filter((f) => !allowed.has(f.id)),
    allowed: found.filter((f) => allowed.has(f.id)),
    // استثناء لم يعد إرشاده قائمًا يُحذف من الملف
    stale: allowlist.filter((a) => !found.some((f) => f.id === a.id)).map((a) => a.id),
  };
}

module.exports = { advisories, check };

if (require.main === module) {
  let raw;
  try {
    raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  } catch (err) {
    // npm audit يخرج بغير الصفر حين يجد ثغرات؛ التقرير في stdout
    raw = err.stdout;
  }
  const allowlist = JSON.parse(readFileSync(join(__dirname, 'audit-allowlist.json'), 'utf8'));
  const result = check(JSON.parse(raw), allowlist);
  for (const a of result.allowed) console.log(`allowed by ADR 0040: ${a.id} (${a.package}, ${a.severity})`);
  for (const id of result.stale) console.log(`stale allowlist entry, remove it: ${id}`);
  for (const b of result.blocking) console.error(`blocking advisory: ${b.id} (${b.package}, ${b.severity})`);
  process.exit(result.blocking.length > 0 ? 1 : 0);
}
