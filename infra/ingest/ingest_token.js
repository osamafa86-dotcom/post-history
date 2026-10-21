// بوابة نطاق ingest. غير المُوكَّل (ADR 0011): لا يمر إلى tusd-proxy إلا طلب يحمل رمز رفع قصيرًا (JWT ES256)
// أصدره الخادم بعد التحقق من شهادة الجهاز (App Attest / Play Integrity). البوابة تحمل المفاتيح العامة وحدها:
// اختراقها لا يسمح بإصدار رموز. الرمز مربوط بجلسة رفع واحدة (sid = upload_session_id = معرّف tus المثبّت).
//
// الرفض بلا تفاصيل: 401 لرمز مفقود أو تالف أو منتهٍ، و403 لرمز صالح لجلسة أخرى. لا يُسجَّل الرمز ولا محتواه.

const MAX_LIFETIME_S = 900; // exp - iat؛ الخادم يصدر 600 ث افتراضيًا، والبوابة ترفض ما يتجاوز 15 دقيقة
const SKEW_S = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// المفاتيح العامة بمعرّفها: INGEST_TOKEN_PUBLIC_KEYS="kid:spki_b64,kid:spki_b64". مفتاحان أثناء التدوير
// (الجديد يُضاف هنا أولًا، ثم يوقّع به الخادم بـ kid الجديد، ثم يُزال القديم)؛ رمز بـ kid غير مدرج = 401.
// خانة مفتاح الاختبار (ADR 0022): INGEST_QA_PUBLIC_KEY="qa-<...>:spki_b64" مع INGEST_QA_KEY_EXPIRES (ISO-8601). معرّف
// ببادئة qa- لا يُقبل إلا من هذه الخانة وحتى انتهائها، ولا يُقبل من قائمة الإنتاج. فئة المفتاح (key_class) تُشتق من
// الخانة التي تحقق منها التوقيع، لا من مطالبات الرمز، وتُرسل مع كل فحص للجلسة.
const KID = /^[A-Za-z0-9._-]{1,64}$/;
const QA = 'qa-';
let keys = null;
let qaKey = null; // { kid, key, expires } أو null

function importSpki(b64) {
    const der = Buffer.from(b64.trim(), 'base64');
    return crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
}

function loadKeys() {
    keys = {};
    const entries = (process.env.INGEST_TOKEN_PUBLIC_KEYS || '').split(',');
    for (let i = 0; i < entries.length; i++) {
        const at = entries[i].indexOf(':');
        if (at < 1) continue;
        const id = entries[i].slice(0, at).trim();
        if (KID.test(id) && id.indexOf(QA) !== 0) keys[id] = importSpki(entries[i].slice(at + 1));
    }
    const qa = (process.env.INGEST_QA_PUBLIC_KEY || '').trim();
    const expires = Date.parse(process.env.INGEST_QA_KEY_EXPIRES || '');
    const at = qa.indexOf(':');
    if (at > 0 && !isNaN(expires)) {
        const id = qa.slice(0, at).trim();
        if (KID.test(id) && id.indexOf(QA) === 0) qaKey = { kid: id, key: importSpki(qa.slice(at + 1)), expires: expires };
    }
}

// { key, keyClass } أو null: مفتاح qa- من خانته وحدها وقبل انتهائها، وكل معرّف آخر من قائمة الإنتاج.
function keyFor(kid) {
    if (keys === null) loadKeys();
    if (kid.indexOf(QA) === 0) {
        return qaKey !== null && qaKey.kid === kid && Date.now() < qaKey.expires ? { key: qaKey.key, keyClass: 'qa' } : null;
    }
    return Object.prototype.hasOwnProperty.call(keys, kid) ? { key: keys[kid], keyClass: 'production' } : null;
}

function part(s) {
    return Buffer.from(s, 'base64url');
}

// Upload-Metadata: "key b64,key b64"؛ القيمة المطلوبة وحدها، أو null.
function metadataValue(header, name) {
    const pairs = (header || '').split(',');
    for (let i = 0; i < pairs.length; i++) {
        const kv = pairs[i].trim().split(' ');
        if (kv[0] === name && kv.length === 2) {
            return part(kv[1].replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')).toString();
        }
    }
    return null;
}

// الجلسة التي يخصها الطلب: من البيانات الوصفية عند الإنشاء، ومن المسار بعده. معرّف tus في مخزن S3 هو
// "<المعرّف المثبّت>+<معرّف الرفع متعدد الأجزاء>"، فالجلسة ما قبل "+".
// يعمل في طلب فرعي (auth_request): الطريقة والمسار من الطلب الأصلي عبر المتغيرات.
function requestedSession(r) {
    const method = r.variables.request_method;
    const path = (r.variables.request_uri || '').split('?')[0];
    if (method === 'POST' && path === '/files/') {
        return metadataValue(r.headersIn['Upload-Metadata'], 'upload_session_id');
    }
    const m = /^\/files\/([^/+]+)(\+[^/]*)?$/.exec(path);
    return m ? m[1] : null;
}

async function claimsOf(token) {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const header = JSON.parse(part(parts[0]).toString());
    if (header.alg !== 'ES256' || header.typ !== 'JWT') return null;
    if (typeof header.kid !== 'string' || !KID.test(header.kid)) return null;
    const slot = keyFor(header.kid);
    if (slot === null) return null;
    const key = await slot.key;
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
        part(parts[2]), parts[0] + '.' + parts[1]);
    if (!ok) return null;
    const c = JSON.parse(part(parts[1]).toString());
    const now = Date.now() / 1000;
    if (c.aud !== 'ingest' || typeof c.sid !== 'string' || !UUID.test(c.sid)) return null;
    // رمز الجهاز (ios|android) أو رمز الويب (web، مع ses: جلسة الدخول التي أصدرته). غيابه = رمز جهاز قديم.
    if (c.plat !== undefined && c.plat !== 'ios' && c.plat !== 'android' && c.plat !== 'web') return null;
    if (c.ses !== undefined && (typeof c.ses !== 'string' || !UUID.test(c.ses))) return null;
    if (c.plat === 'web' && c.ses === undefined) return null;
    if (typeof c.iat !== 'number' || typeof c.exp !== 'number') return null;
    if (c.iat > now + SKEW_S || c.exp < now - SKEW_S || c.exp - c.iat > MAX_LIFETIME_S) return null;
    return { claims: c, keyClass: slot.keyClass };
}

// حالة جلسة الرفع (وجلسة الدخول ses لرمز الويب) عند الخادم (SEC-01): الرمز صالح توقيعًا وعمرًا، لكن الإبطال (جلسة دخول مُبطلة، حساب موقوف، جلسة رفع
// منتهية) يجب أن يسري خلال ثوانٍ لا بعد انتهاء الرمز. طلب فرعي داخلي إلى /internal على الخادم، والجواب مخبأ ثانيتين
// لكل جلسة (nginx.conf). 204 مسموح، و403/404 مرفوض، وغير ذلك (الخادم لا يجيب) يرفض البوابة كلها: الإغلاق عند العطل.
// INGEST_SESSION_CHECK=off لاختبار البوابة وحدها بلا خادم (infra/ingest/test-gate.sh)؛ بيئة التجربة لا تمرره.
// key_class يُرسل دائمًا: مع qa يقبل الخادم جلسات حساب القبول وحده (ACCEPTANCE_UPLOADER_USER_ID).
async function sessionAllowed(r, c, keyClass) {
    if (process.env.INGEST_SESSION_CHECK === 'off') return true;
    const args = 'sid=' + c.sid + (c.ses ? '&ses=' + c.ses : '') + '&key_class=' + keyClass;
    const reply = await r.subrequest('/_session_state', { method: 'GET', args: args });
    if (reply.status === 204) return true;
    if (reply.status === 403 || reply.status === 404) return false;
    throw new Error('session state unavailable');
}

// ترويسة الطلب الداخلي إلى الخادم: سر البوابة (ليس رمز العميل)، من البيئة.
function stateAuth(r) {
    const t = process.env.INGEST_GATE_TOKEN || '';
    return t ? 'Bearer ' + t : '';
}

// معالج auth_request: 204 يمرّر الطلب الأصلي (وجسمه يتدفق دون أن تقرأه البوابة)، و401/403 ترفضه.
async function gate(r) {
    if (r.variables.request_method === 'OPTIONS') {
        // اكتشاف إمكانات tus بلا بيانات؛ لا يكشف شيئًا عن الجلسات.
        r.return(204);
        return;
    }
    let verified = null;
    const token = r.headersIn['Ingest-Token'] || '';
    try {
        verified = await claimsOf(token);
    } catch (e) {
        verified = null;
    }
    if (!verified) {
        r.return(401);
        return;
    }
    const claims = verified.claims;
    if (requestedSession(r) !== claims.sid) {
        r.return(403);
        return;
    }
    let allowed = false;
    try {
        allowed = await sessionAllowed(r, claims, verified.keyClass);
    } catch (e) {
        r.return(500);  // auth_request: كل ما ليس 2xx/401/403 خطأ (500 للعميل)، فلا يمر شيء والخادم لا يجيب
        return;
    }
    r.return(allowed ? 204 : 403);
}

export default { gate, stateAuth };
