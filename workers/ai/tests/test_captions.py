import json

from ai_worker.captions import MAX_LINE_CHARS, RLM, Segment, Word, build_cues, to_json, to_webvtt


def words(*spec):
    return tuple(Word(s, e, t) for s, e, t in spec)


def test_cue_starts_at_first_word_not_at_segment_start():
    # Whisper segments begin where the previous one ended, often inside the silence (asr-bench REPORT)
    seg = Segment(0.0, 3.0, "وصل الوفد", words((0.6, 1.0, "وصل"), (1.1, 1.6, "الوفد")))
    [cue] = build_cues([seg])
    assert (cue.start, cue.end) == (0.6, 1.6)


def test_long_silence_between_words_splits_the_cue():
    seg = Segment(0.0, 9.0, "", words((0.5, 1.0, "أ"), (1.1, 1.5, "ب"), (3.0, 3.4, "ج")))
    cues = build_cues([seg])
    # the last cue is shorter than MIN_CUE_S, so it is held on screen for half a second
    assert [(c.start, c.end) for c in cues] == [(0.5, 1.5), (3.0, 3.5)]


def test_cue_respects_two_lines_and_seven_seconds():
    ws = tuple(Word(i * 0.5, i * 0.5 + 0.4, "كلمة") for i in range(40))
    cues = build_cues([Segment(0, 20, "", ws)])
    for c in cues:
        assert len(c.lines) <= 2
        assert all(len(line) <= MAX_LINE_CHARS for line in c.lines)
        assert c.end - c.start <= 7.0 + 0.5
    assert sum(len(" ".join(c.lines).split()) for c in cues) == 40


def test_cues_never_overlap():
    a = Segment(0, 2, "", words((0.0, 1.9, "أ")))
    b = Segment(1.5, 3, "", words((1.5, 2.5, "ب")))
    cues = build_cues([a, b])
    assert cues[0].end <= cues[1].start


def test_segment_without_word_times_falls_back_to_segment_bounds():
    [cue] = build_cues([Segment(2.0, 4.0, " نص بلا كلمات", ())])
    assert (cue.start, cue.end, cue.lines) == (2.0, 4.0, ("نص بلا كلمات",))


def test_webvtt_is_rtl_and_well_formed():
    vtt = to_webvtt(build_cues([Segment(0, 3700, "", words((3661.5, 3662.25, "123"), (3662.3, 3662.9, "-->كلمة")))]))
    lines = vtt.split("\n")
    assert lines[0].startswith("WEBVTT")
    assert "01:01:01.500 --> 01:01:02.900" in lines
    text = lines[lines.index("01:01:01.500 --> 01:01:02.900") + 1]
    assert text.startswith(RLM)  # starts with a digit, still laid out right to left
    assert text.count("-->") == 0


def test_json_is_a_deterministic_local_draft_without_empty_words():
    segs = [Segment(0.12345, 1.0, " نص ", (Word(0.2, 0.5, " نص", None), Word(0.6, 0.7, " ", 0.5)))]
    kw = dict(duration_s=12.3456, start_pts_us=1500, engine={"name": "x"}, source={"file_id": "f"})
    a, b = to_json(segs, **kw), to_json(segs, **kw)
    assert a == b
    doc = json.loads(a)
    assert (doc["status"], doc["route"], doc["language"]) == ("draft", "local", "ar")
    assert doc["start_pts_us"] == 1500 and doc["duration_s"] == 12.346
    assert doc["segments"] == [{"start": 0.123, "end": 1.0, "text": "نص", "words": [{"start": 0.2, "end": 0.5, "text": "نص"}]}]
