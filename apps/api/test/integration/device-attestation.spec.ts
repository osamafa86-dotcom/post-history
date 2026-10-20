import { createHash, createPublicKey, generateKeyPairSync, randomUUID, webcrypto } from 'node:crypto';
import request from 'supertest';
import { schemaValidator } from '../../src/common/contract';
import { PLAY_INTEGRITY_DECODER } from '../../src/attestation/device-attestation.service';
import { AttestationUnavailable, type PlayIntegrityDecoder, UnsignedTestDecoder } from '../../src/attestation/play-integrity';
import { AAGUID_DEVELOPMENT, AppAttestFixtures, type Device } from '../support/app-attest-fixtures';
import { createHarness, type Harness, loginAs, seedUploadSession } from './harness';

type Actor = Awaited<ReturnType<typeof loginAs>>;

const APP_ID = 'ABCDE12345.org.posthistory.reporter';
const PACKAGE = 'org.posthistory.reporter';
const CERT_DIGEST = createHash('sha256').update('release signing cert').digest('base64url');
const sha256 = (b: Buffer) => createHash('sha256').update(b).digest();

/** يبدّل فاكّ Play Integrity أثناء الاختبار (لمحاكاة تعذر Google) دون إعادة بناء التطبيق. */
class SwitchableDecoder implements PlayIntegrityDecoder {
  down = false;
  private readonly inner = new UnsignedTestDecoder();
  decode(token: string): Promise<unknown> {
    if (this.down) throw new AttestationUnavailable(7);
    return this.inner.decode(token);
  }
}

describe('device attestation and ingest tokens (SEC-07, ADR 0011)', () => {
  const fx = new AppAttestFixtures();
  const decoder = new SwitchableDecoder();
  const signing = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  let h: Harness;
  let reporter: Actor;
  beforeAll(async () => {
    h = await createHarness({
      env: {
        ATTESTATION_MODE: 'test',
        APP_ATTEST_APP_ID: APP_ID,
        APP_ATTEST_TEST_ROOT_PEM: Buffer.from(fx.rootPem).toString('base64'),
        PLAY_INTEGRITY_PACKAGE_NAME: PACKAGE,
        PLAY_INTEGRITY_CERT_SHA256: CERT_DIGEST,
        INGEST_TOKEN_SIGNING_KEY: (signing.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer).toString('base64'),
        INGEST_TOKEN_KEY_ID: 'ingest-2026-10',
        INGEST_TOKEN_TTL_SECONDS: '600',
        INGEST_REQUIRED: 'true',
        INGEST_TUS_ENDPOINT: 'https://ingest.example.test/files/',
      },
      overrides: [[PLAY_INTEGRITY_DECODER, decoder]],
    });
    reporter = await loginAs(h, [{ role: 'reporter' }]);
  });
  afterAll(async () => {
    fx.close();
    await h.close();
  });

  const http = () => request(h.app.getHttpServer());
  const want = (status: number) => (res: request.Response) => {
    expect({ status: res.status, code: res.body?.code }).toMatchObject({ status });
    return res;
  };
  const post = (a: Actor, url: string, body?: object, key: string = randomUUID()) =>
    http().post(`/v1${url}`).set('Authorization', `Bearer ${a.token}`).set('Idempotency-Key', key).send(body);
  const challenge = async (a: Actor) => {
    const res = await post(a, '/device-attestations/challenge').expect(200);
    return { id: res.body.challenge_id as string, bytes: Buffer.from(res.body.challenge, 'base64url') };
  };
  const register = async (a: Actor, device: Device, opts: Parameters<AppAttestFixtures['attest']>[3] = {}) => {
    const c = await challenge(a);
    return post(a, '/device-attestations', {
      platform: 'ios',
      key_id: device.keyId.toString('base64'),
      attestation: fx.attest(device, c.bytes, APP_ID, opts),
      challenge_id: c.id,
    });
  };
  const iosToken = async (a: Actor, device: Device, sessionId: string, counter: number, key?: string) => {
    const c = await challenge(a);
    const clientData = Buffer.concat([c.bytes, Buffer.from(sessionId)]);
    return post(a, `/uploads/${sessionId}/ingest-token`, {
      platform: 'ios',
      key_id: device.keyId.toString('base64'),
      assertion: fx.assert(device, clientData, counter, APP_ID),
      challenge_id: c.id,
    }, key);
  };
  const verdict = (requestHash: string, over: Record<string, unknown> = {}) =>
    Buffer.from(
      JSON.stringify({
        requestDetails: { requestPackageName: PACKAGE, requestHash, timestampMillis: String(Date.now()) },
        appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: PACKAGE, certificateSha256Digest: [CERT_DIGEST] },
        deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_DEVICE_INTEGRITY'] },
        ...over,
      }),
    ).toString('base64url');
  const androidToken = async (a: Actor, sessionId: string, over: Record<string, unknown> = {}) => {
    const c = await challenge(a);
    const requestHash = sha256(Buffer.concat([c.bytes, Buffer.from(sessionId)])).toString('base64url');
    return post(a, `/uploads/${sessionId}/ingest-token`, { platform: 'android', integrity_token: verdict(requestHash, over), challenge_id: c.id });
  };
  /** التحقق كما تفعله البوابة (infra/ingest/ingest_token.js): WebCrypto بالمفتاح العام SPKI وحده. */
  const gateVerify = async (token: string) => {
    const [h64, p64, s64] = token.split('.');
    const spki = createPublicKey(signing.privateKey).export({ format: 'der', type: 'spki' });
    const key = await webcrypto.subtle.importKey('spki', spki, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const ok = await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(s64!, 'base64url'), Buffer.from(`${h64}.${p64}`));
    return { ok, header: JSON.parse(Buffer.from(h64!, 'base64url').toString()), claims: JSON.parse(Buffer.from(p64!, 'base64url').toString()) };
  };
  const audits = async (actorId: string) =>
    (await h.pool.query(`SELECT action, target_type, details FROM audit_log WHERE actor_id = $1 ORDER BY id`, [actorId])).rows;

  it('issues a single-use 32-byte challenge bound to the caller', async () => {
    const res = await post(reporter, '/device-attestations/challenge').expect(200);
    const valid = schemaValidator('AttestationChallenge');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);
    expect(Buffer.from(res.body.challenge, 'base64url')).toHaveLength(32);
    const other = await loginAs(h, [{ role: 'reporter' }]);
    const device = fx.newDevice();
    // تحدي غيره لا يصلح، ويُستهلك بالمحاولة نفسها
    const attempt = await post(other, '/device-attestations', {
      platform: 'ios',
      key_id: device.keyId.toString('base64'),
      attestation: fx.attest(device, Buffer.from(res.body.challenge, 'base64url'), APP_ID),
      challenge_id: res.body.challenge_id,
    }).expect(410);
    expect(attempt.body.code).toBe('challenge_expired');
  });

  it('registers an App Attest key: only the key_id hash is stored, and nothing identifying is audited', async () => {
    const device = fx.newDevice();
    const res = await register(reporter, device).then(want(201));
    expect(res.body).toEqual({ key_ref: expect.any(String) });
    const { rows } = await h.pool.query(`SELECT user_id, key_id_hash, sign_count, revoked_at FROM device_attestation_keys WHERE id = $1`, [res.body.key_ref]);
    expect(rows[0]).toMatchObject({ user_id: reporter.id, sign_count: '0', revoked_at: null });
    expect(rows[0].key_id_hash.equals(sha256(device.keyId))).toBe(true);
    const text = JSON.stringify(await audits(reporter.id));
    expect(text).not.toContain(device.keyId.toString('base64'));
    expect(text).not.toContain(device.keyId.toString('hex'));
    expect(await audits(reporter.id)).toContainEqual({
      action: 'device_attestation.registered',
      target_type: 'device_attestation_key',
      details: { target_user_id: reporter.id, reason_code: 'production' },
    });
  });

  it('rejects a corrupt or foreign attestation with one 403 attestation_failed, and audits the internal reason', async () => {
    const actor = await loginAs(h, [{ role: 'reporter' }]);
    fx.foreignChain();
    const cases: Array<[Parameters<AppAttestFixtures['attest']>[3], string]> = [
      [{ tamperAuthData: true }, 'nonce'],
      [{ ca: 'evilint' }, 'chain'],
      [{ aaguid: AAGUID_DEVELOPMENT }, 'aaguid'],
      [{ counter: 3 }, 'counter'],
    ];
    for (const [opts] of cases) {
      const res = await register(actor, fx.newDevice(), opts).then(want(403));
      expect(res.body).toMatchObject({ code: 'attestation_failed', message: 'Device attestation failed.' });
    }
    expect((await audits(actor.id)).filter((a) => a.action === 'device_attestation.rejected').map((a) => a.details.reason_code)).toEqual(
      cases.map(([, reason]) => reason),
    );
    // CBOR تالف وbase64 غير صالح
    const c = await challenge(actor);
    await post(actor, '/device-attestations', { platform: 'ios', key_id: 'AAAA', attestation: Buffer.from('not cbor').toString('base64'), challenge_id: c.id }).expect(403);
    const c2 = await challenge(actor);
    await post(actor, '/device-attestations', { platform: 'ios', key_id: '%%%', attestation: 'AAAA', challenge_id: c2.id }).expect(422);
    const { rows } = await h.pool.query(`SELECT count(*)::int AS n FROM device_attestation_keys WHERE user_id = $1`, [actor.id]);
    expect(rows[0].n).toBe(0);
  });

  it('a key registered to another account is 409 attestation_key_conflict; the same account gets its key_ref back', async () => {
    const device = fx.newDevice();
    const first = (await register(reporter, device).then(want(201))).body.key_ref;
    expect((await register(reporter, device).then(want(201))).body.key_ref).toBe(first);
    const other = await loginAs(h, [{ role: 'reporter' }]);
    expect((await register(other, device).then(want(409))).body.code).toBe('attestation_key_conflict');
  });

  it('iOS: an assertion over challenge ‖ session yields an ES256 token the gateway accepts; replays and other sessions are refused', async () => {
    const device = fx.newDevice();
    await register(reporter, device).then(want(201));
    const session = await seedUploadSession(h, reporter.id);
    const res = await iosToken(reporter, device, session.id, 1).then(want(200));
    const valid = schemaValidator('IngestToken');
    expect(valid(res.body) ? [] : valid.errors).toEqual([]);

    const { ok, header, claims } = await gateVerify(res.body.token);
    expect(ok).toBe(true);
    expect(header).toEqual({ alg: 'ES256', typ: 'JWT', kid: 'ingest-2026-10' });
    expect(claims).toMatchObject({ aud: 'ingest', sid: session.id, plat: 'ios', jti: expect.any(String) });
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
    expect(new Date(res.body.expires_at).getTime()).toBe(claims.exp * 1000);

    // العدّاد نفسه (أو أقل) إعادة تشغيل وإن صح التوقيع
    expect((await iosToken(reporter, device, session.id, 1).then(want(409))).body.code).toBe('assertion_replay');
    await iosToken(reporter, device, session.id, 2).then(want(200));
    // تأكيد على clientData لجلسة أخرى لا يصلح لهذه
    const c = await challenge(reporter);
    const other = await seedUploadSession(h, reporter.id);
    await post(reporter, `/uploads/${session.id}/ingest-token`, {
      platform: 'ios',
      key_id: device.keyId.toString('base64'),
      assertion: fx.assert(device, Buffer.concat([c.bytes, Buffer.from(other.id)]), 5, APP_ID),
      challenge_id: c.id,
    }).expect(403);
    const { rows } = await h.pool.query(`SELECT sign_count FROM device_attestation_keys WHERE key_id_hash = $1`, [sha256(device.keyId)]);
    expect(rows[0].sign_count).toBe('2');
  });

  it('the token never outlives its upload session, and a replay with the same key reissues it with the same expiry', async () => {
    const device = fx.newDevice();
    await register(reporter, device).then(want(201));
    const session = await seedUploadSession(h, reporter.id, { expiresInSeconds: 120 });
    const key = randomUUID();
    const ch = await challenge(reporter);
    const body = {
      platform: 'ios',
      key_id: device.keyId.toString('base64'),
      assertion: fx.assert(device, Buffer.concat([ch.bytes, Buffer.from(session.id)]), 1, APP_ID),
      challenge_id: ch.id,
    };
    const res = await post(reporter, `/uploads/${session.id}/ingest-token`, body, key).expect(200);
    const { claims } = await gateVerify(res.body.token);
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(120);
    // المفتاح نفسه بالجسم نفسه: لا يُخزَّن الرمز، فيُصدر رمز جديد بالانتهاء نفسه لا أبعد
    const c = await post(reporter, `/uploads/${session.id}/ingest-token`, body, key).expect(200);
    expect(c.body.expires_at).toBe(res.body.expires_at);
    expect(c.body.token).not.toBe(res.body.token);
    expect((await gateVerify(c.body.token)).ok).toBe(true);
    const { rows } = await h.pool.query(`SELECT response_body::text AS body FROM idempotency_keys WHERE key = $1`, [key]);
    expect(rows[0].body).not.toContain(res.body.token);
  });

  it('Android: a Play Integrity verdict bound to challenge ‖ session yields a token; any failed condition is 403', async () => {
    const session = await seedUploadSession(h, reporter.id);
    const res = await androidToken(reporter, session.id).then(want(200));
    expect((await gateVerify(res.body.token)).claims).toMatchObject({ sid: session.id, plat: 'android' });
    const bad = [
      { deviceIntegrity: { deviceRecognitionVerdict: ['MEETS_BASIC_INTEGRITY'] } },
      { appIntegrity: { appRecognitionVerdict: 'UNRECOGNIZED_VERSION', packageName: PACKAGE, certificateSha256Digest: [CERT_DIGEST] } },
      { appIntegrity: { appRecognitionVerdict: 'PLAY_RECOGNIZED', packageName: PACKAGE, certificateSha256Digest: ['other'] } },
      { requestDetails: { requestPackageName: PACKAGE, requestHash: 'x', timestampMillis: String(Date.now()) } },
    ];
    for (const over of bad) expect((await androidToken(reporter, session.id, over).then(want(403))).body.code).toBe('attestation_failed');
    // حكم أقدم من 5 دقائق
    const c = await challenge(reporter);
    const hash = sha256(Buffer.concat([c.bytes, Buffer.from(session.id)])).toString('base64url');
    const stale = verdict(hash, { requestDetails: { requestPackageName: PACKAGE, requestHash: hash, timestampMillis: String(Date.now() - 6 * 60_000) } });
    await post(reporter, `/uploads/${session.id}/ingest-token`, { platform: 'android', integrity_token: stale, challenge_id: c.id }).expect(403);
  });

  it('Google unavailable is 503 attestation_unavailable with Retry-After; the challenge is spent', async () => {
    const session = await seedUploadSession(h, reporter.id);
    decoder.down = true;
    try {
      const res = await androidToken(reporter, session.id).then(want(503));
      expect(res.body.code).toBe('attestation_unavailable');
      expect(res.headers['retry-after']).toBe('7');
    } finally {
      decoder.down = false;
    }
  });

  it('only a live tus session of the caller: others 404, finished or revoked 409; a used challenge is 410', async () => {
    const device = fx.newDevice();
    await register(reporter, device).then(want(201));
    const other = await loginAs(h, [{ role: 'reporter' }]);
    const theirs = await seedUploadSession(h, other.id);
    await iosToken(reporter, device, theirs.id, 1).then(want(404));
    const done = await seedUploadSession(h, reporter.id, { state: 'completed' });
    expect((await iosToken(reporter, device, done.id, 1).then(want(409))).body.code).toBe('upload_state_conflict');

    const session = await seedUploadSession(h, reporter.id);
    const c = await challenge(reporter);
    const body = {
      platform: 'ios',
      key_id: device.keyId.toString('base64'),
      assertion: fx.assert(device, Buffer.concat([c.bytes, Buffer.from(session.id)]), 10, APP_ID),
      challenge_id: c.id,
    };
    await post(reporter, `/uploads/${session.id}/ingest-token`, body).expect(200);
    expect((await post(reporter, `/uploads/${session.id}/ingest-token`, body).expect(410)).body.code).toBe('challenge_expired');
  });

  it('revoking every session revokes the device keys: the lost phone gets no more ingest tokens', async () => {
    const owner = await loginAs(h, [{ role: 'reporter' }]);
    const device = fx.newDevice();
    await register(owner, device).then(want(201));
    const session = await seedUploadSession(h, owner.id);
    await iosToken(owner, device, session.id, 1).then(want(200));
    await http().post('/v1/auth/logout').set('Authorization', `Bearer ${owner.token}`).send({ all_sessions: true }).expect(204);
    const { rows } = await h.pool.query(`SELECT revoked_at FROM device_attestation_keys WHERE user_id = $1`, [owner.id]);
    expect(rows.every((r) => r.revoked_at !== null)).toBe(true);
    // يعود صاحب الحساب بدخول جديد: المفتاح القديم لا يصدر رمزًا، ولا يُعاد تسجيله
    const login = await http().post('/v1/auth/login').send({ email: owner.email, password: owner.password }).expect(200);
    const back = { ...owner, token: login.body.access_token as string };
    const fresh = await seedUploadSession(h, owner.id);
    expect((await iosToken(back, device, fresh.id, 2).then(want(403))).body.code).toBe('attestation_failed');
    expect((await register(back, device).then(want(409))).body.code).toBe('attestation_key_conflict');
  });

  it('upload sessions advertise the ingest endpoint while INGEST_REQUIRED is on', async () => {
    const session = await seedUploadSession(h, reporter.id);
    const res = await http().get(`/v1/uploads/${session.id}`).set('Authorization', `Bearer ${reporter.token}`).expect(200);
    expect(res.body).toMatchObject({ ingest_token_required: true, tus_endpoint: 'https://ingest.example.test/files/' });
  });

  it('with ATTESTATION_MODE off (the default) the three operations are 404 and sessions do not require ingest', async () => {
    const off = await createHarness();
    try {
      const actor = await loginAs(off, [{ role: 'reporter' }]);
      const p = (url: string, body?: object) =>
        request(off.app.getHttpServer()).post(`/v1${url}`).set('Authorization', `Bearer ${actor.token}`).set('Idempotency-Key', randomUUID()).send(body);
      await p('/device-attestations/challenge').expect(404);
      const session = await seedUploadSession(off, actor.id);
      await p(`/uploads/${session.id}/ingest-token`, { platform: 'android', integrity_token: 'x', challenge_id: randomUUID() }).expect(404);
      const res = await request(off.app.getHttpServer()).get(`/v1/uploads/${session.id}`).set('Authorization', `Bearer ${actor.token}`).expect(200);
      expect(res.body.ingest_token_required).toBe(false);
    } finally {
      await off.close();
    }
  });
});
