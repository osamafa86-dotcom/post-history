"""توقيع C2PA (ADR 0060): ملف جديد موقَّع، والبيان قائمة بيضاء مغلقة بلا أي قيمة مزروعة ولا بصمة الأصل.

الشهادات سلسلة اختبار (جذر ثم شهادة توقيع) تُولَّد هنا بـ openssl ولا تُحفظ؛ تثبت الصياغة والمحتوى لا الثقة الحقيقية.
"""

import copy
import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from conftest import LEAKY_TAGS, STREAM_TAGS, synth
from media_worker import c2pa
from media_worker.export import strip_metadata
from media_worker.probe import probe
from media_worker.watermark import make_watermarked_preview

SECRET = b"test-only-c2pa-source-secret-0123456789"
PUBLISHER = "Test Network"


def _openssl(*args: str, cwd: Path) -> None:
    subprocess.run(["openssl", *args], cwd=cwd, check=True, capture_output=True)


def make_certs(d: Path) -> Path:
    _openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "ca.key", cwd=d)
    _openssl("req", "-x509", "-new", "-key", "ca.key", "-sha256", "-days", "2", "-subj", "/CN=Test Root/O=test",
             "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign",
             "-out", "ca.pem", cwd=d)
    _openssl("ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", "leaf.ec", cwd=d)
    _openssl("pkcs8", "-topk8", "-nocrypt", "-in", "leaf.ec", "-out", "leaf.key", cwd=d)
    _openssl("req", "-new", "-key", "leaf.ec", "-subj", "/CN=Test Signer/O=test", "-out", "leaf.csr", cwd=d)
    (d / "ext.cnf").write_text("basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\n"
                               "extendedKeyUsage=emailProtection\nsubjectKeyIdentifier=hash\n"
                               "authorityKeyIdentifier=keyid\n")
    _openssl("x509", "-req", "-in", "leaf.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial", "-days", "2",
             "-sha256", "-extfile", "ext.cnf", "-out", "leaf.pem", cwd=d)
    (d / "chain.pem").write_text((d / "leaf.pem").read_text() + (d / "ca.pem").read_text())
    return d


@pytest.fixture(scope="module")
def certs(tmp_path_factory) -> Path:
    return make_certs(tmp_path_factory.mktemp("certs"))


def _signer(certs: Path, trusted: bool = True) -> c2pa.Signer:
    return c2pa.Signer(cert_chain=certs / "chain.pem", private_key=certs / "leaf.key",
                       trust_anchors=certs / "ca.pem" if trusted else None)


@pytest.fixture(scope="module")
def original(tmp_path_factory) -> Path:
    return synth(tmp_path_factory.mktemp("c2") / "orig.mov", seconds=2, start_offset=1, leaky_tags=True,
                 stream_tags=True)


def _planted() -> list[bytes]:
    return [v.encode() for v in [*LEAKY_TAGS.values(), *STREAM_TAGS.values()]]


@pytest.mark.parametrize("output", ["export", "store_preview"])
def test_signed_copy_is_a_new_file_and_carries_only_the_whitelist(certs: Path, original: Path, tmp_path: Path,
                                                                 output: str):
    sha = hashlib.sha256(original.read_bytes()).hexdigest()
    built = tmp_path / ("clip.mov" if output == "export" else "preview.mp4")
    if output == "export":
        strip_metadata(original, built)
        actions = ["c2pa.transcoded"]
    else:  # المعاينة توقَّع بعد العلامة المائية، فلا تكسر إعادة الترميز البيان
        make_watermarked_preview(original, built, probe(original), b"test-only-watermark-key-0123456789", "m-1")
        actions = ["c2pa.transcoded", "c2pa.edited"]
    source = c2pa.source_ref(SECRET, sha)
    signed = tmp_path / f"signed{built.suffix}"
    report = c2pa.sign(built, signed, signer=_signer(certs), title=signed.name, source=source, actions=actions,
                       publisher=PUBLISHER, version="1")
    assert report.get("validation_state") == "Trusted"
    blob, text = signed.read_bytes(), json.dumps(report)
    for value in _planted():
        assert value not in blob and value.decode() not in text
    # لا بصمة الأصل الخام في الملف ولا في البيان، بأي ترميز
    assert sha not in text and sha.encode() not in blob and bytes.fromhex(sha) not in blob
    assert source in text
    assert hashlib.sha256(original.read_bytes()).hexdigest() == sha  # الأصل لم يُمس
    assert probe(signed).duration_ms == probe(built).duration_ms


def test_signing_refuses_to_overwrite(certs: Path, original: Path, tmp_path: Path):
    clip = tmp_path / "clip.mov"
    strip_metadata(original, clip)
    with pytest.raises(ValueError):
        c2pa.sign(clip, clip, signer=_signer(certs), title="clip.mov", source=c2pa.source_ref(SECRET, "0" * 64),
                  actions=[], publisher=PUBLISHER, version="1")


def test_without_anchors_trust_is_not_claimed(certs: Path, original: Path, tmp_path: Path):
    clip = tmp_path / "clip.mov"
    strip_metadata(original, clip)
    report = c2pa.sign(clip, tmp_path / "s.mov", signer=_signer(certs, trusted=False), title="s.mov",
                       source=c2pa.source_ref(SECRET, "1" * 64), actions=[], publisher=PUBLISHER, version="1")
    assert report.get("validation_state") != "Trusted" and not report.get("validation_status")


@pytest.fixture(scope="module")
def good_report(certs: Path, original: Path, tmp_path_factory) -> dict:
    d = tmp_path_factory.mktemp("rep")
    strip_metadata(original, d / "clip.mov")
    return c2pa.sign(d / "clip.mov", d / "s.mov", signer=_signer(certs), title="s.mov",
                     source=c2pa.source_ref(SECRET, "2" * 64), actions=["c2pa.edited"], publisher=PUBLISHER,
                     version="1")


def _active(report: dict) -> dict:
    return report["manifests"][report["active_manifest"]]


@pytest.mark.parametrize("tamper", ["assertion", "ingredient_hash", "action", "publisher_extra", "second_manifest",
                                    "validation"])
def test_report_outside_the_whitelist_is_rejected(good_report: dict, tamper: str):
    source = c2pa.source_ref(SECRET, "2" * 64)
    c2pa.check_report(good_report, source=source, publisher=PUBLISHER, trusted=True)
    r = copy.deepcopy(good_report)
    m = _active(r)
    if tamper == "assertion":
        m["assertions"].append({"label": "stds.exif", "data": {"exif:GPSLatitude": "1"}})
    elif tamper == "ingredient_hash":
        m["ingredients"][0]["data"] = {"hash": "2" * 64}
    elif tamper == "action":
        actions = next(a for a in m["assertions"] if a["label"] == "c2pa.actions.v2")
        actions["data"]["actions"].append({"action": "c2pa.published", "parameters": {"where": "x"}})
    elif tamper == "publisher_extra":
        cw = next(a for a in m["assertions"] if a["label"] == "stds.schema-org.CreativeWork")
        cw["data"]["author"] = [{"name": "real name"}]
    elif tamper == "second_manifest":
        r["manifests"]["urn:c2pa:other"] = {}
    else:
        r["validation_status"] = [{"code": "assertion.dataHash.mismatch"}]
    with pytest.raises(c2pa.ManifestRejected):
        c2pa.check_report(r, source=source, publisher=PUBLISHER, trusted=True)


def test_definition_and_source_reference_guards():
    with pytest.raises(ValueError):
        c2pa.source_ref(b"short", "0" * 64)
    a, b = c2pa.source_ref(SECRET, "0" * 64), c2pa.source_ref(SECRET + b"x", "0" * 64)
    assert a != b and "0" * 64 not in a
    with pytest.raises(ValueError):
        c2pa.manifest_definition(title="x.mov", source="0" * 64, actions=[], publisher=PUBLISHER, version="1")
    with pytest.raises(ValueError):
        c2pa.manifest_definition(title="x.mov", source=a, actions=["c2pa.published"], publisher=PUBLISHER,
                                 version="1")
    with pytest.raises(ValueError):
        c2pa.manifest_definition(title="../etc/x", source=a, actions=[], publisher=PUBLISHER, version="1")
    with pytest.raises(ValueError):
        c2pa.Signer(cert_chain=Path("c.pem"))


def test_signing_config_is_off_by_default_and_refuses_partial_setup():
    assert c2pa.signing_from_env({}) is None
    with pytest.raises(ValueError):
        c2pa.signing_from_env({"MEDIA_ENABLE_C2PA": "true", "MEDIA_C2PA_CERT_CHAIN": "/c.pem"})
    base = {"MEDIA_ENABLE_C2PA": "true", "MEDIA_C2PA_CERT_CHAIN": "/c.pem", "MEDIA_C2PA_PUBLISHER": PUBLISHER,
            "MEDIA_C2PA_SIGNER_PATH": "/usr/local/bin/kms-sign"}
    with pytest.raises(ValueError):  # سر قصير
        c2pa.signing_from_env({**base, "MEDIA_C2PA_SOURCE_SECRET": "short"})
    s = c2pa.signing_from_env({**base, "MEDIA_C2PA_SOURCE_SECRET": SECRET.decode()})
    assert s.signer.signer_path and s.signer.private_key is None and SECRET.decode() not in repr(s)
