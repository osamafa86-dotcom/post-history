"""توقيع C2PA للنسخ التي تغادر المنصة (ADR 0060): التصدير النهائي، وملفات حزمة التسليم، ومعاينة المتجر.

- التوقيع بـ `c2patool` المثبّت في الصورة، بقائمة وسائط ومهلة وبيئة نظيفة (`ffmpeg.run`)، وينتج ملفًا جديدًا دائمًا.
- البيان قائمة بيضاء مغلقة: مولّد المنصة، ومكوّن الأصل بمعرّف معتم `HMAC-SHA256(سر الخادم، بصمة الأصل)` بلا بصمته
  الخام، والإجراءات المعروفة، واسم الشبكة ناشرًا. بعد التوقيع يُقرأ البيان كاملًا ويُرفض أي شيء خارج القائمة.
- الإعدادات من ملف يكتبه العامل في مجلد المهمة: لا OCSP ولا جلب بيان بعيد، ولا طابع زمني خارجي في هذه المرحلة.
- الإنتاج يوقّع عبر أمر خارجي (`signer_path`) يستدعي وحدة المفاتيح، فلا يلمس العامل المفتاح؛ الاختبار بمفتاح ملف.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import os
import re
from dataclasses import dataclass, field
from pathlib import Path

from .ffmpeg import run

C2PATOOL = os.environ.get("C2PATOOL_BIN", "c2patool")
GENERATOR = "post-history-media"
WORKER_VERSION = "0.1.0"  # يطابق pyproject.toml
SOURCE_PREFIX = "post-history:source:"
# `c2pa.watermarked` في المواصفة للعلامة غير المرئية بربط ناعم؛ علامة المعاينة المرئية المحروقة `c2pa.edited`
ACTIONS = frozenset({"c2pa.opened", "c2pa.transcoded", "c2pa.edited", "c2pa.color_adjustments"})
ASSERTIONS = frozenset({"c2pa.actions.v2", "stds.schema-org.CreativeWork", "c2pa.hash.bmff.v3", "c2pa.hash.bmff.v2",
                        "c2pa.hash.data"})
# مفاتيح البيان والمكوّن التي يكتبها c2patool نفسه؛ ما عداها خارج القائمة
MANIFEST_KEYS = frozenset({"claim_generator_info", "title", "instance_id", "ingredients", "assertions",
                           "signature_info", "label", "format", "claim_version"})
INGREDIENT_KEYS = frozenset({"title", "format", "instance_id", "relationship", "label"})
SIGNATURE_KEYS = frozenset({"alg", "issuer", "common_name", "cert_serial_number", "time"})
ALGS = frozenset({"es256", "es384", "ps256", "ed25519"})
SAFE_TEXT = re.compile(r"^[\w .\-]{1,80}$")


class ManifestRejected(ValueError):
    """البيان الموقَّع يحمل ما ليس في القائمة البيضاء، أو لم يُتحقق منه."""


@dataclass(frozen=True)
class Signer:
    """`cert_chain` سلسلة PEM (الشهادة ثم الوسيطة). `private_key` للاختبار والتطوير وحدهما، و`signer_path` للإنتاج.
    `trust_anchors` جذور PEM للتحقق؛ بلا جذور لا يُقبل إلا `signingCredential.untrusted` بين حالات التحقق."""

    cert_chain: Path
    alg: str = "es256"
    private_key: Path | None = field(default=None, repr=False)
    signer_path: str | None = None
    trust_anchors: Path | None = None

    def __post_init__(self) -> None:
        if self.alg not in ALGS:
            raise ValueError(f"unsupported C2PA signing algorithm {self.alg!r}")
        if (self.private_key is None) == (self.signer_path is None):
            raise ValueError("exactly one of private_key or signer_path")


def source_ref(secret: bytes, sha256: str) -> str:
    """معرّف المكوّن: يربط به الخادم وحده الأصل، ولا يطابقه من يملك الأصل لأنه لا يملك السر."""
    if len(secret) < 32:
        raise ValueError("C2PA source secret must be at least 32 bytes")
    if not re.fullmatch(r"[0-9a-f]{64}", sha256):
        raise ValueError("sha256 must be 64 lowercase hex characters")
    return SOURCE_PREFIX + hmac.new(secret, sha256.encode(), hashlib.sha256).hexdigest()


def manifest_definition(*, title: str, source: str, actions: list[str], publisher: str, version: str) -> dict:
    """تعريف البيان من القائمة البيضاء وحدها. `actions` ما أُجري فعلًا بعد فتح الأصل."""
    if not SAFE_TEXT.match(title) or not SAFE_TEXT.match(publisher) or not SAFE_TEXT.match(version):
        raise ValueError("title, publisher and version must be short plain names")
    if not source.startswith(SOURCE_PREFIX):
        raise ValueError("source must be an opaque reference from source_ref")
    unknown = set(actions) - ACTIONS
    if unknown or "c2pa.opened" in actions:
        raise ValueError(f"unknown or reserved actions: {sorted(unknown) or ['c2pa.opened']}")
    steps = [{"action": "c2pa.opened", "parameters": {"ingredientIds": ["source"]}}]
    steps += [{"action": a, "softwareAgent": {"name": GENERATOR}} for a in actions]
    return {
        "claim_generator_info": [{"name": GENERATOR, "version": version}],
        "title": title,
        "ingredients": [{"title": "original", "relationship": "parentOf", "instance_id": source, "label": "source"}],
        "assertions": [
            {"label": "c2pa.actions.v2", "data": {"actions": steps}},
            {"label": "stds.schema-org.CreativeWork",
             "data": {"@context": "https://schema.org", "@type": "CreativeWork",
                      "publisher": {"@type": "Organization", "name": publisher}}},
        ],
    }


def _settings(work: Path, signer: Signer) -> Path:
    s: dict = {"version": 1, "verify": {"ocsp_fetch": False, "remote_manifest_fetch": False,
                                        "verify_trust": signer.trust_anchors is not None}}
    if signer.trust_anchors is not None:
        s["trust"] = {"trust_anchors": signer.trust_anchors.read_text()}
    path = work / "c2pa-settings.json"
    path.write_text(json.dumps(s))
    return path


def read_report(path: Path, signer: Signer, work: Path, timeout_s: float = 120) -> dict:
    out = run([C2PATOOL, str(path), "--settings", str(_settings(work, signer))], timeout_s=timeout_s, cwd=work)
    return json.loads(out)


def check_report(report: dict, *, source: str, publisher: str, trusted: bool) -> None:
    """يرفض البيان إن حمل شيئًا خارج القائمة البيضاء أو فشل تحققه. يُستدعى بعد كل توقيع وفي اختبار القبول."""
    active = report.get("active_manifest")
    manifests = report.get("manifests") or {}
    if not active or set(manifests) != {active}:
        raise ManifestRejected("exactly one manifest, ours")
    codes = [s.get("code") for s in report.get("validation_status") or []]
    allowed_codes = set() if trusted else {"signingCredential.untrusted"}
    if set(codes) - allowed_codes:
        raise ManifestRejected(f"validation failed: {sorted(set(codes) - allowed_codes)}")
    m = manifests[active]
    if set(m) - MANIFEST_KEYS:
        raise ManifestRejected(f"unexpected manifest fields: {sorted(set(m) - MANIFEST_KEYS)}")
    if set(m.get("signature_info") or {}) - SIGNATURE_KEYS:
        raise ManifestRejected("unexpected signature fields")
    if [g.get("name") for g in m.get("claim_generator_info") or []] != [GENERATOR]:
        raise ManifestRejected("unexpected claim generator")
    ingredients = m.get("ingredients") or []
    if len(ingredients) != 1 or set(ingredients[0]) - INGREDIENT_KEYS or ingredients[0].get("instance_id") != source:
        raise ManifestRejected("ingredient must be the opaque source reference only")
    for a in m.get("assertions") or []:
        label = a.get("label")
        if label not in ASSERTIONS:
            raise ManifestRejected(f"unexpected assertion {label!r}")
        if label == "c2pa.actions.v2":
            for step in a["data"].get("actions") or []:
                if step.get("action") not in ACTIONS or set(step) - {"action", "parameters", "softwareAgent"}:
                    raise ManifestRejected(f"unexpected action {step.get('action')!r}")
        if label == "stds.schema-org.CreativeWork":
            data = a["data"]
            if set(data) - {"@context", "@type", "publisher"} or data.get("publisher", {}).get("name") != publisher:
                raise ManifestRejected("CreativeWork carries only the network as publisher")


def sign(src: Path, dst: Path, *, signer: Signer, title: str, source: str, actions: list[str], publisher: str,
         version: str, timeout_s: float = 600) -> dict:
    """يوقّع `src` إلى ملف جديد `dst` (في مجلد المهمة نفسه)، ثم يقرأ البيان ويتحقق منه. يعيد التقرير."""
    src, dst = Path(src), Path(dst)
    if src.resolve() == dst.resolve() or dst.exists():
        raise ValueError("C2PA output must be a new file")
    work = dst.parent
    definition = manifest_definition(title=title, source=source, actions=actions, publisher=publisher,
                                     version=version)
    definition["alg"] = signer.alg
    definition["sign_cert"] = str(signer.cert_chain)
    if signer.private_key is not None:
        definition["private_key"] = str(signer.private_key)
    mpath = work / "c2pa-manifest.json"
    mpath.write_text(json.dumps(definition))
    args = [C2PATOOL, str(src), "-m", str(mpath), "-o", str(dst), "--settings", str(_settings(work, signer))]
    if signer.signer_path:
        args += ["--signer-path", signer.signer_path]
    try:
        run(args, timeout_s=timeout_s, cwd=work)
        report = read_report(dst, signer, work)
        check_report(report, source=source, publisher=publisher, trusted=signer.trust_anchors is not None)
    except Exception:
        dst.unlink(missing_ok=True)
        raise
    finally:
        mpath.unlink(missing_ok=True)
    return report


@dataclass(frozen=True)
class Signing:
    """إعداد التوقيع في العامل. لا يُبنى إلا خلف `MEDIA_ENABLE_C2PA`، ولا يُفعَّل العلم قبل فحص القبول (ADR 0060)."""

    signer: Signer
    source_secret: bytes = field(repr=False)
    publisher: str


def signing_from_env(env: dict[str, str]) -> Signing | None:
    """`None` والعلم مطفأ. والعلم مفعّل بإعداد ناقص يرفض الإقلاع بدل أن يصدر نسخًا بلا توقيع."""
    if env.get("MEDIA_ENABLE_C2PA", "false").lower() != "true":
        return None
    missing = [k for k in ("MEDIA_C2PA_CERT_CHAIN", "MEDIA_C2PA_SOURCE_SECRET", "MEDIA_C2PA_PUBLISHER")
               if not env.get(k)]
    if missing:
        raise ValueError(f"MEDIA_ENABLE_C2PA needs {', '.join(missing)}")
    key, signer_path = env.get("MEDIA_C2PA_PRIVATE_KEY"), env.get("MEDIA_C2PA_SIGNER_PATH")
    anchors = env.get("MEDIA_C2PA_TRUST_ANCHORS")
    signer = Signer(cert_chain=Path(env["MEDIA_C2PA_CERT_CHAIN"]), alg=env.get("MEDIA_C2PA_ALG", "es256"),
                    private_key=Path(key) if key else None, signer_path=signer_path or None,
                    trust_anchors=Path(anchors) if anchors else None)
    secret = env["MEDIA_C2PA_SOURCE_SECRET"].encode()
    source_ref(secret, "0" * 64)  # يتحقق من طول السر عند الإقلاع
    if not SAFE_TEXT.match(env["MEDIA_C2PA_PUBLISHER"]):
        raise ValueError("MEDIA_C2PA_PUBLISHER must be a short plain name")
    return Signing(signer=signer, source_secret=secret, publisher=env["MEDIA_C2PA_PUBLISHER"])
