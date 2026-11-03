import { ApiError } from '../common/errors';

export type TagRewriteMode = 'merge' | 'rename';

/**
 * وسوم المادة بعد الدمج (ADR 0098): `target` يأخذ موضع `source`، وما تكرّر بعدها يُحذف مع إبقاء أول ظهور. هي قاعدة
 * الاستعلام في `TagsService.rewrite` نفسها، مكتوبةً هنا لاختبار الوحدة.
 */
export function rewriteTags(tags: readonly string[], source: string, target: string): string[] {
  const out: string[] = [];
  for (const t of tags) {
    const v = t === source ? target : t;
    if (!out.includes(v)) out.push(v);
  }
  return out;
}

/** القائمة المقترحة بعد الدمج: `target` مكان `source`، أو حذف `source` إن كان `target` فيها. `undefined` إن لم تتغيّر. */
export function rewriteSuggestions(list: readonly string[], source: string, target: string): string[] | undefined {
  if (!list.includes(source)) return undefined;
  return rewriteTags(list, source, target);
}

/** `merge` إن كان الهدف مستعملًا على مادة أو مقترحًا قبل الطلب، وإلا `rename`. */
export function rewriteMode(targetInUse: boolean, suggestions: readonly string[], target: string): TagRewriteMode {
  return targetInUse || suggestions.includes(target) ? 'merge' : 'rename';
}

export function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** مؤشّر «استعمال الوسوم»: العدد ثم الوسم، بترتيب الاستعلام (العدد تنازليًا ثم الوسم بنقاط الترميز). */
export function encodeUsageCursor(count: number, tag: string): string {
  return Buffer.from(JSON.stringify([count, tag])).toString('base64url');
}

export function decodeUsageCursor(cursor: string): { count: number; tag: string } {
  try {
    const [count, tag] = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as [unknown, unknown];
    if (typeof count === 'number' && Number.isInteger(count) && count >= 0 && typeof tag === 'string' && tag.length > 0 && tag.length <= 160) {
      return { count, tag };
    }
  } catch {
    // يقع إلى الخطأ أدناه
  }
  throw new ApiError(400, 'bad_request', 'Invalid cursor.', { params: ['cursor'] });
}
