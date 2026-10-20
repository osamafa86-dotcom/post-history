// بوابة نطاق ingest. غير المُوكَّل (ADR 0011): لا يمر إلى tusd-proxy إلا طلب يحمل رمز رفع قصيرًا (JWT ES256)
// أصدره الخادم بعد التحقق من شهادة الجهاز (App Attest / Play Integrity). البوابة تحمل المفاتيح العامة وحدها:
// اختراقها لا يسمح بإصدار رموز. الرمز مربوط بجلسة رفع واحدة (sid = upload_session_id = معرّف tus المثبّت).
//
// الرفض بلا تفاصيل: 401 لرمز مفقود أو تالف أو منتهٍ، و403 لرمز صالح لجلسة أخرى. لا يُسجَّل الرمز ولا محتواه.

const MAX_LIFETIME_S = 900; // exp - iat؛ الخادم يصدر 15 دقيقة على الأكثر
const SKEW_S = 60;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// المفاتيح العامة بمعرّفها: INGEST_TOKEN_PUBLIC_KEYS="kid:spki_b64,kid:spki_b64". مفتاحان أثناء التدوير
// (الجديد يُضاف هنا أولًا، ثم يوقّع به الخادم بـ kid الجديد، ثم يُزال القديم)؛ رمز بـ kid غير مدرج = 401.
const KID = /^[A-Za-z0-9._-]{1,64}$/;
let keys = null;

function keyFor(kid) {
    if (keys === null) {
        keys = {};
        const entries = (process.env.INGEST_TOKEN_PUBLIC_KEYS || '').split(',');
        for (let i = 0; i < entries.length; i++) {
            const at = entries[i].indexOf(':');
            if (at < 1) continue;
            const id = entries[i].slice(0, at).trim();
            const der = Buffer.from(entries[i].slice(at + 1).trim(), 'base64');
            if (KID.test(id)) {
                keys[id] = crypto.subtle.importKey('spki', der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
            }
        }
    }
    return Object.prototype.hasOwnProperty.call(keys, kid) ? keys[kid] : null;
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
    const pending = keyFor(header.kid);
    if (pending === null) return null;
    const key = await pending;
    const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key,
        part(parts[2]), parts[0] + '.' + parts[1]);
    if (!ok) return null;
    const c = JSON.parse(part(parts[1]).toString());
    const now = Date.now() / 1000;
    if (c.aud !== 'ingest' || typeof c.sid !== 'string' || !UUID.test(c.sid)) return null;
    if (typeof c.iat !== 'number' || typeof c.exp !== 'number') return null;
    if (c.iat > now + SKEW_S || c.exp < now - SKEW_S || c.exp - c.iat > MAX_LIFETIME_S) return null;
    return c;
}

// معالج auth_request: 204 يمرّر الطلب الأصلي (وجسمه يتدفق دون أن تقرأه البوابة)، و401/403 ترفضه.
async function gate(r) {
    if (r.variables.request_method === 'OPTIONS') {
        // اكتشاف إمكانات tus بلا بيانات؛ لا يكشف شيئًا عن الجلسات.
        r.return(204);
        return;
    }
    let claims = null;
    const token = r.headersIn['Ingest-Token'] || '';
    try {
        claims = await claimsOf(token);
    } catch (e) {
        claims = null;
    }
    if (!claims) {
        r.return(401);
        return;
    }
    if (requestedSession(r) !== claims.sid) {
        r.return(403);
        return;
    }
    r.return(204);
}

export default { gate };
