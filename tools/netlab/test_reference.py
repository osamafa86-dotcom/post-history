#!/usr/bin/env python3
"""اختبارات وحدة لمعيار المرحلة (أ) النسبي (ADR 0007، تعديل 2026-10-20): الملف المرجعي ومدة صلاحيته والحكم.
مكتبة بايثون القياسية فقط: python3 tools/netlab/test_reference.py
"""
import datetime as dt
import json
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netlab  # noqa: E402

NOW = dt.datetime(2026, 10, 20, 12, 0, tzinfo=dt.timezone.utc)
CHUNK = 256 << 10


def reference(**over):
    doc = {"tool": "netlab", "ended_at": "2026-10-19T12:00:00Z", "network": {"profile": "field-weak"},
           "metrics": {"reference_run": True, "loss_mode": "netem", "client_chunk_bytes": CHUNK,
                       "goodput_connected_kbps": 43.0}}
    for k, v in over.items():
        if k in doc["metrics"] or k in ("reference_run", "loss_mode", "client_chunk_bytes", "goodput_connected_kbps"):
            doc["metrics"][k] = v
        elif k == "profile":
            doc["network"]["profile"] = v
        else:
            doc[k] = v
    fd, path = tempfile.mkstemp(suffix=".json")
    with os.fdopen(fd, "w") as fh:
        json.dump(doc, fh)
    return path


class Reference(unittest.TestCase):
    def load(self, path, loss="netem"):
        try:
            return netlab.load_reference(path, "field-weak", loss, CHUNK, today=NOW)
        finally:
            os.unlink(path)

    def test_valid_reference(self):
        kbps, source, age, loss = self.load(reference())
        self.assertEqual((kbps, age, loss), (43.0, 1.0, "netem"))
        self.assertIn("2026-10-19T12:00:00Z", source)

    def test_rejections(self):
        cases = {
            "not a netlab reference run": dict(reference_run=False),
            "scenario office != field-weak": dict(profile="office"),
            "loss mode iptables-statistic != netem": dict(loss_mode="iptables-statistic"),
            f"chunk {1 << 20} != {CHUNK}": dict(client_chunk_bytes=1 << 20),
            "no goodput": dict(goodput_connected_kbps=0),
            "31 days old (max 30)": dict(ended_at="2026-09-19T12:00:00Z"),
        }
        for message, over in cases.items():
            with self.subTest(message):
                with self.assertRaises(ValueError) as cm:
                    self.load(reference(**over))
                self.assertIn(message, str(cm.exception))

    def test_loss_mode_checked_later_when_unknown(self):
        self.assertEqual(self.load(reference(loss_mode="iptables-statistic"), loss=None)[3], "iptables-statistic")


class StageA(unittest.TestCase):
    def test_rule(self):
        self.assertTrue(netlab.stage_a(0.70, 0, complete=False, match=False))       # partial upload, at the bar
        self.assertFalse(netlab.stage_a(0.69, 0, complete=False, match=False))      # below the bar
        self.assertFalse(netlab.stage_a(0.95, 1, complete=False, match=False))      # a byte lost on resume
        self.assertFalse(netlab.stage_a(0.95, 0, complete=True, match=False))       # complete but checksum differs
        self.assertTrue(netlab.stage_a(1.10, 0, complete=True, match=True))

    def test_connected_time_excludes_blackouts(self):
        events = [(10.0, "blackout-start"), (30.0, "blackout-end"), (130.0, "blackout-start")]
        self.assertAlmostEqual(netlab.connected_seconds(events, 140.0), 140 - 20 - 10)


if __name__ == "__main__":
    unittest.main(verbosity=2)
