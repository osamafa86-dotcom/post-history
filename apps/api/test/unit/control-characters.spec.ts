import { ApiError } from '../../src/common/errors';
import { controlCharacterPaths, validateBody, validateQuery } from '../../src/common/contract';

// ADR 0115: محارف التحكم C0 (غير الجدولة والسطر الجديد وعودة العربة) وDEL في أي نص من جسم الطلب أو الاستعلام 422/400 على مسارها
describe('control characters in request strings', () => {
  it('names the path of every string or key that carries one, and lets tab, newline and carriage return through', () => {
    expect(controlCharacterPaths({ a: 'line one\nline two\r\n\tindented', b: ['ok'] })).toEqual([]);
    expect(
      controlCharacterPaths({ a: 'x\u0000', b: [{ c: 'esc\u001b[0m' }], 'd/e': 'del\u007f', ['k\u0001']: 'v', n: 3, t: true, z: null }),
    ).toEqual(['/a', '/b/0/c', '/d~1e', '/']);
    expect(controlCharacterPaths('\u0008')).toEqual(['/']);
  });

  it('rejects a contract-valid body with 422 on the field and a query with 400 on the parameter', () => {
    const body = { email: 'a@example.test', password: 'pass\u0000word-long' };
    expect(() => validateBody('/auth/login', 'post', body)).toThrow(ApiError);
    try {
      validateBody('/auth/login', 'post', body);
    } catch (err) {
      expect(err).toMatchObject({ status: 422, code: 'validation_failed', details: { fields: ['/password'] } });
    }
    expect(validateBody('/auth/login', 'post', { email: 'a@example.test', password: 'multi\nline\tpass' })).toBeTruthy();
    try {
      validateQuery('/catalog', 'get', { q: 'gaza\u0000' });
      throw new Error('expected a 400');
    } catch (err) {
      expect(err).toMatchObject({ status: 400, code: 'bad_request', details: { params: ['q'] } });
    }
  });
});
