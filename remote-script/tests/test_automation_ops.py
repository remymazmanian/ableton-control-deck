import json
import types
import unittest

import test_session_ops
from test_control_deck_live import Parameter


class Envelope(object):
    """Steps as (start, end, value). Like Live 12.4.16, an exact boundary reads the earlier step."""

    def __init__(self, default):
        self.default = default
        self.steps = []

    def insert_step(self, time, duration, value):
        self.steps = [step for step in self.steps if step[1] <= time or step[0] >= time + duration]
        self.steps.append((time, time + duration, value))

    def value_at_time(self, time):
        value = self.default
        for start, end, step_value in sorted(self.steps):
            if start < time <= end:
                value = step_value
        return value


class AutomationClip(test_session_ops.SessionClip):
    def __init__(self, name="Loop"):
        super(AutomationClip, self).__init__(name)
        object.__setattr__(self, "length", 16.0)
        object.__setattr__(self, "envelopes", {})

    def automation_envelope(self, parameter):
        return self.envelopes.get(id(parameter))

    def create_automation_envelope(self, parameter):
        self.envelopes[id(parameter)] = Envelope(parameter.value)
        return self.envelopes[id(parameter)]

    def clear_envelope(self, parameter):
        self.envelopes.pop(id(parameter), None)

    def clear_all_envelopes(self):
        self.envelopes.clear()


class AutomationOpsTests(unittest.TestCase):
    query = test_session_ops.SessionOpsTests.query
    command = test_session_ops.SessionOpsTests.command
    refused = test_session_ops.SessionOpsTests.refused

    def setUp(self):
        test_session_ops.SessionOpsTests.setUp(self)
        self.clip = AutomationClip("Beat")
        self.song.tracks[0].clip_slots[0].clip = self.clip
        self.cutoff = Parameter("Cutoff", 0.5, 0.0, 1.0)
        self.song.tracks[0].devices = [types.SimpleNamespace(name="Drift", class_name="Drift", parameters=[Parameter("Device On", 1.0, 0.0, 1.0), self.cutoff])]
        self.volume = json.dumps({"kind": "mixer", "field": "volume"})
        self.device = json.dumps({"kind": "device", "path": "0", "parameterIndex": 1, "name": "Cutoff"})

    def read(self, parameter, how):
        return json.loads(self.query("/live/clip_automation/get", 0, 0, parameter, how)[0])

    def test_writes_steps_and_reads_inside_each_step(self):
        self.command("/live/clip_automation/write", 0, 0, "Drums", "Beat", self.device, False, 0.0, 8.0, 0.2, False, 8.0, 8.0, 0.9, False)
        state = self.read(self.device, 5)
        self.assertEqual(state["hasEnvelope"], True)
        # Samples at 0, 4, 8, 12, 16: the one at exactly 8 must read the new step, not the earlier one.
        self.assertEqual([round(sample["value"], 2) for sample in state["samples"]], [0.2, 0.2, 0.9, 0.9, 0.9])
        self.assertEqual(self.read(self.device, json.dumps([7.9, 8.1]))["samples"][1]["value"], 0.9)
        self.assertEqual(self.song.undo_log, ["begin", "end"])

    def test_converts_db_steps_for_volume(self):
        self.command("/live/clip_automation/write", 0, 0, "Drums", "Beat", self.volume, False, 0.0, 16.0, -6.0, True)
        value = self.read(self.volume, json.dumps([1.0]))["samples"][0]["value"]
        self.assertAlmostEqual(value, 0.85 - 6.0 / 40.0, places=2)

    def test_lists_and_clears_envelopes(self):
        self.command("/live/clip_automation/write", 0, 0, "Drums", "Beat", self.device, False, 0.0, 4.0, 0.1, False)
        self.command("/live/clip_automation/write", 0, 0, "Drums", "Beat", self.volume, False, 0.0, 4.0, 0.5, False)
        listed = json.loads(self.query("/live/clip_automation/list", 0, 0)[0])
        self.assertEqual([(entry["kind"], entry["name"]) for entry in listed["automated"]], [("mixer", "Volume"), ("device", "Cutoff")])
        self.command("/live/clip_automation/clear", 0, 0, "Drums", "Beat", self.volume, False)
        self.assertIsNone(self.clip.automation_envelope(self.song.tracks[0].mixer_device.volume))
        self.assertIn("confirm", self.refused("/live/clip_automation/clear", 0, 0, "Drums", "Beat", "all", False))
        self.command("/live/clip_automation/clear", 0, 0, "Drums", "Beat", "all", True)
        self.assertEqual(self.clip.envelopes, {})

    def test_refusals_change_nothing(self):
        self.assertIn("inside the clip", self.refused("/live/clip_automation/write", 0, 0, "Drums", "Beat", self.device, False, 12.0, 8.0, 0.5, False))
        self.assertIn("from 0 to 1", self.refused("/live/clip_automation/write", 0, 0, "Drums", "Beat", self.device, False, 0.0, 4.0, 3.0, False))
        self.assertIn("found 'Cutoff'", self.refused("/live/clip_automation/write", 0, 0, "Drums", "Beat", json.dumps({"kind": "device", "path": "0", "parameterIndex": 1, "name": "Res"}), False, 0.0, 4.0, 0.5, False))
        self.assertIn("found 'Beat'", self.refused("/live/clip_automation/write", 0, 0, "Drums", "Fill", self.device, False, 0.0, 4.0, 0.5, False))
        self.assertIn("Send 3 does not exist", self.refused("/live/clip_automation/write", 0, 0, "Drums", "Beat", json.dumps({"kind": "mixer", "field": "send", "sendIndex": 3}), False, 0.0, 4.0, 0.5, False))
        self.assertEqual(self.clip.envelopes, {})


if __name__ == "__main__":
    unittest.main()
