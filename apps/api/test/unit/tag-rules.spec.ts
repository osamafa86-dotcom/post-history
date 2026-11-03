import { ApiError } from '../../src/common/errors';
import { decodeUsageCursor, encodeUsageCursor, rewriteMode, rewriteSuggestions, rewriteTags, sameList } from '../../src/tags/tag-rules';

// قواعد الدمج وإعادة التسمية والمؤشّر (ADR 0098)
describe('tag rules', () => {
  it('puts the target in the place of the source and keeps the first of any duplicate', () => {
    expect(rewriteTags(['أ', 'ب', 'ج'], 'ب', 'د')).toEqual(['أ', 'د', 'ج']);
    // المادة تحمل الهدف قبل الأصل: يبقى موضعه الأول
    expect(rewriteTags(['د', 'ب', 'ج'], 'ب', 'د')).toEqual(['د', 'ج']);
    // تحمل الأصل قبل الهدف: يأخذ الهدف موضع الأصل
    expect(rewriteTags(['ب', 'ج', 'د'], 'ب', 'د')).toEqual(['د', 'ج']);
    expect(rewriteTags(['أ'], 'ب', 'د')).toEqual(['أ']);
    expect(rewriteTags([], 'ب', 'د')).toEqual([]);
  });

  it('rewrites the suggested list only when it holds the source', () => {
    expect(rewriteSuggestions(['أ', 'ب'], 'ج', 'د')).toBeUndefined();
    expect(rewriteSuggestions(['أ', 'ب', 'ج'], 'ب', 'د')).toEqual(['أ', 'د', 'ج']);
    expect(rewriteSuggestions(['أ', 'ب', 'د'], 'ب', 'د')).toEqual(['أ', 'د']);
  });

  it('is a merge when the target is used or suggested, and a rename otherwise', () => {
    expect(rewriteMode(true, [], 'د')).toBe('merge');
    expect(rewriteMode(false, ['د'], 'د')).toBe('merge');
    expect(rewriteMode(false, ['أ'], 'د')).toBe('rename');
  });

  it('compares lists by order as well as content', () => {
    expect(sameList(['أ', 'ب'], ['أ', 'ب'])).toBe(true);
    expect(sameList(['أ', 'ب'], ['ب', 'أ'])).toBe(false);
    expect(sameList(['أ'], ['أ', 'ب'])).toBe(false);
  });

  it('round-trips the usage cursor and rejects anything else with 400 bad_request', () => {
    const c = encodeUsageCursor(12, 'وسم, "مقتبس"');
    expect(decodeUsageCursor(c)).toEqual({ count: 12, tag: 'وسم, "مقتبس"' });
    for (const bad of ['', 'not-base64-json', Buffer.from('[1]').toString('base64url'), Buffer.from('[-1,"a"]').toString('base64url'),
      Buffer.from('[1.5,"a"]').toString('base64url'), Buffer.from('[1,""]').toString('base64url')]) {
      try {
        decodeUsageCursor(bad);
        throw new Error(`accepted ${bad}`);
      } catch (e) {
        expect(e).toBeInstanceOf(ApiError);
        expect((e as ApiError).status).toBe(400);
      }
    }
  });
});
