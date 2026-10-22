"""llm_bench scoring: no model, no network. Run in CI."""
from llm_bench import arabic_share, clean, lcs, lead_baseline, rouge_l


def test_lcs_counts_the_longest_common_subsequence():
    assert lcs(list("abcbdab"), list("bdcaba")) == 4
    assert lcs([], ["x"]) == 0


def test_rouge_l_uses_the_same_normalization_as_wer():
    assert rouge_l("وصل الوفد إلى غزة", "وصل الوفد الى غزه") == 1.0  # hamza seat and ta marbuta unified
    assert rouge_l("وصل الوفد إلى غزة", "") == 0.0
    assert 0 < rouge_l("وصل الوفد إلى غزة اليوم", "الوفد وصل غزة") < 1


def test_arabic_share_and_cleanup():
    assert arabic_share("عنوان الخبر") == 1.0 and arabic_share("news title") == 0.0
    assert clean('\n«العنوان: وصول الوفد»\nسطر ثان') == "وصول الوفد"


def test_lead_baseline_takes_the_first_sentence():
    title, summary = lead_baseline("الجملة الأولى هنا. والثانية")
    assert summary == "الجملة الأولى هنا" and title == summary
