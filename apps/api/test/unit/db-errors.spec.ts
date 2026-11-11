import { databaseUnavailable } from '../../src/common/db-errors';
import { toErrorResponse } from '../../src/common/error.filter';

const coded = (code: string, message = 'x') => Object.assign(new Error(message), { code });
/** كما يلفّ Drizzle خطأ الاستعلام: الأصل في cause. */
const wrapped = (cause: Error) => new Error('Failed query: select 1', { cause });

describe('databaseUnavailable', () => {
  it.each(['08000', '08003', '08006', '57P01', '57P02', '57P03', '53300', '57014', '25P03'])(
    'SQLSTATE %s is an outage or an exceeded time limit',
    (code) => {
      expect(databaseUnavailable(coded(code))).toBe(true);
      expect(databaseUnavailable(wrapped(coded(code)))).toBe(true);
    },
  );

  it.each(['23505', '40001', '40P01', '22P02', '42P01', '55P03'])('SQLSTATE %s is not', (code) => {
    expect(databaseUnavailable(coded(code))).toBe(false);
  });

  it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH'])(
    'a socket failure (%s) is an outage, also behind a wrapper',
    (code) => {
      expect(databaseUnavailable(coded(code))).toBe(true);
      expect(databaseUnavailable(wrapped(new Error('Connection terminated due to connection timeout', { cause: coded(code) })))).toBe(true);
    },
  );

  it.each([
    'timeout exceeded when trying to connect',
    'Connection terminated unexpectedly',
    'Connection terminated due to connection timeout',
    'Connection terminated',
    'Client has encountered a connection error and is not queryable',
  ])('the driver error "%s" is an outage', (message) => {
    expect(databaseUnavailable(new Error(message))).toBe(true);
    expect(databaseUnavailable(wrapped(new Error(message)))).toBe(true);
  });

  it('an ordinary failure is not', () => {
    expect(databaseUnavailable(new Error('boom'))).toBe(false);
    expect(databaseUnavailable(new TypeError("Cannot read properties of undefined (reading 'id')"))).toBe(false);
    expect(databaseUnavailable(coded('ENOENT'))).toBe(false);
    expect(databaseUnavailable(undefined)).toBe(false);
    expect(databaseUnavailable('Connection terminated')).toBe(false);
  });
});

describe('toErrorResponse for a database outage', () => {
  it('is 503 with Retry-After and the fixed code, and says nothing about the cause', () => {
    const res = toErrorResponse(wrapped(coded('57P01', 'terminating connection due to administrator command')), 'r1');
    expect(res.status).toBe(503);
    expect(Number(res.headers?.['Retry-After'])).toBeGreaterThanOrEqual(1);
    expect(res.body).toEqual({ code: 'internal_error', message: 'Service temporarily unavailable.', request_id: 'r1' });
  });

  it('keeps 500 without headers for any other failure', () => {
    expect(toErrorResponse(new Error('boom'), 'r2')).toEqual({
      status: 500,
      body: { code: 'internal_error', message: 'Internal error.', request_id: 'r2' },
    });
  });
});
