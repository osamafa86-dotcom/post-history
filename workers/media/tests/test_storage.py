from datetime import datetime, timezone

import pytest

from media_worker.storage import S3Storage, sign_v4


def test_sigv4_matches_aws_documented_example():
    # مثال GET Object من وثائق AWS (Signature Version 4، "Example: GET Object")
    headers = sign_v4(
        "GET", "https://examplebucket.s3.amazonaws.com/test.txt", {"Range": "bytes=0-9"},
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
        "AKIAIOSFODNN7EXAMPLE", "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY", "us-east-1",
        datetime(2013, 5, 24, tzinfo=timezone.utc),
    )
    assert headers["authorization"] == (
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, "
        "SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, "
        "Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41"
    )


@pytest.mark.parametrize("key", ["", "/abs", "a/../b", ".."])
def test_rejects_unsafe_keys(key: str):
    s = S3Storage("http://minio:9000", "auto", "a", "b", writable_bucket="media")
    with pytest.raises(ValueError):
        s._url("uploads", key)


def test_writes_only_to_the_derived_bucket(tmp_path):
    s = S3Storage("http://minio:9000", "auto", "a", "b", writable_bucket="media")
    f = tmp_path / "x"
    f.write_bytes(b"x")
    with pytest.raises(PermissionError):
        s.put_file("uploads", "orig/key", f, "0" * 64, "video/mp4")
