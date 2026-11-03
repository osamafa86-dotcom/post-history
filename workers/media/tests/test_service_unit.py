from pathlib import Path

from media_worker.service import Config, clean_scratch


def test_config_repr_hides_secrets():
    cfg = Config(redis_url="redis://:redis-pass@redis:6379", api_url="http://api:3000", token="t" * 40,
                 s3_endpoint="http://minio:9000", s3_region="auto", s3_access_key="media-worker",
                 s3_secret_key="s3-secret-value", bucket_uploads="uploads", bucket_derived="media",
                 scratch=Path("/scratch"), consumer="c1")
    text = repr(cfg)
    for secret in ("redis-pass", "t" * 40, "media-worker", "s3-secret-value"):
        assert secret not in text
    assert "http://api:3000" in text


def test_clean_scratch_removes_only_stale_job_dirs(tmp_path: Path):
    (tmp_path / "job-abc").mkdir()
    (tmp_path / "job-abc" / "source").write_bytes(b"copy of an original")
    (tmp_path / "job-def").mkdir()
    (tmp_path / "keep.txt").write_text("not a job directory")
    (tmp_path / "other").mkdir()
    assert clean_scratch(tmp_path) == 2
    assert sorted(p.name for p in tmp_path.iterdir()) == ["keep.txt", "other"]


def test_render_queue_is_separate_and_renders_stay_off_by_default(monkeypatch):
    from media_worker.service import QUEUES, RENDER_GROUP, RENDER_STREAM, STREAM

    assert QUEUES["renders"] == (RENDER_STREAM, RENDER_GROUP) == ("media:renders", "render")
    assert QUEUES["events"][0] == STREAM != RENDER_STREAM
    env = {"REDIS_URL": "redis://r", "MEDIA_API_URL": "http://api:3000", "MEDIA_WORKER_TOKEN": "t" * 40,
           "S3_ENDPOINT": "http://minio:9000", "S3_ACCESS_KEY": "a", "S3_SECRET_KEY": "s",
           "S3_BUCKET_UPLOADS": "uploads", "S3_BUCKET_MEDIA": "media"}
    for k, v in env.items():
        monkeypatch.setenv(k, v)
    monkeypatch.delenv("MEDIA_ENABLE_RENDERS", raising=False)
    assert Config.from_env().enable_renders is False
    monkeypatch.setenv("MEDIA_ENABLE_RENDERS", "true")
    assert Config.from_env().enable_renders is True
