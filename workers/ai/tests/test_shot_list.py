import json

from ai_worker.captions import Segment
from ai_worker.shot_list import EXCERPT_MAX, excerpt, to_json
from ai_worker.shots import Shot


def seg(start, end, text):
    return Segment(start, end, text, ())


def test_excerpt_joins_the_segments_mostly_inside_the_shot():
    segments = [seg(0.0, 2.0, " أولى"), seg(2.0, 6.0, " ثانية"), seg(5.5, 9.0, " ثالثة"), seg(9.0, 9.5, "  ")]
    assert excerpt(Shot(1.5, 7.0), segments) == "ثانية"  # the first and third lie mostly outside
    assert excerpt(Shot(0.0, 10.0), segments) == "أولى ثانية ثالثة"
    assert excerpt(Shot(9.0, 10.0), segments) is None


def test_long_excerpt_is_cut_on_a_word_with_an_ellipsis():
    out = excerpt(Shot(0.0, 60.0), [seg(0.0, 60.0, " ".join(["كلمة"] * 100))])
    assert len(out) <= EXCERPT_MAX and out.endswith("…") and not out[:-1].endswith(" ")
    assert out[:-1].split(" ")[-1] == "كلمة"


def test_same_input_gives_the_same_bytes_and_no_text_without_a_transcript():
    shots = [Shot(3.5, 4.25), Shot(4.25, 9.0)]
    a = to_json(shots, None, source={"file_id": "f", "from": "proxy-480p.mp4"})
    assert a == to_json(shots, None, source={"file_id": "f", "from": "proxy-480p.mp4"})
    doc = json.loads(a)
    assert [(s["start_us"], s["end_us"], s["duration_ms"]) for s in doc["shots"]] == [(3500000, 4250000, 750), (4250000, 9000000, 4750)]
    assert all(s["excerpt"] is None for s in doc["shots"])
