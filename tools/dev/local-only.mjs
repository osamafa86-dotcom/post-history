// الأدوات تغيّر بيانات اصطناعية فقط داخل compose محلي مصرح به صراحةً.
import { isIP } from 'node:net';
export function localOnly(value, protocols) {
  const u = new URL(value);
  const h = u.hostname.replace(/^\[|\]$/g, '');
  const loop = isIP(h) === 4 && Number(h.split('.')[0]) === 127 || isIP(h) === 6 && h === '::1';
  if (!protocols.includes(u.protocol) || !(loop || ['localhost', 'api', 'postgres', 'tusd'].includes(h)) || u.search || u.hash) throw new Error('local compose endpoint required');
  return value.replace(/\/$/, '');
}
export function requireDemo(env) {
  if (env.DEMO_LOCAL_ONLY !== '1') throw new Error('DEMO_LOCAL_ONLY=1 required; use a disposable compose database');
  localOnly(env.DATABASE_URL, ['postgres:', 'postgresql:']);
  localOnly(env.API_URL, ['http:']);
}
