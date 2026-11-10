import json
import unittest

import test_session_ops


class SongOpsTests(unittest.TestCase):
    query = test_session_ops.SessionOpsTests.query
    command = test_session_ops.SessionOpsTests.command
    refused = test_session_ops.SessionOpsTests.refused

    def setUp(self):
        test_session_ops.SessionOpsTests.setUp(self)
        song = self.song
        song.root_note, song.scale_name, song.scale_mode, song.scale_intervals = 9, "Minor", True, [0, 2, 3, 5, 7, 8, 10]
        song.groove_amount, song.loop, song.loop_start, song.loop_length = 0.0, False, 8.0, 16.0
        song.punch_in = song.punch_out = song.arrangement_overdub = False
        song.session_automation_record, song.midi_recording_quantization = True, 0
        song.can_capture_midi, song.re_enable_automation_enabled, song.back_to_arranger = False, False, True
        self.captured = []
        song.capture_midi = lambda: self.captured.append("capture")

    def settings(self):
        return json.loads(self.query("/live/song_settings/get")[0])

    def test_reads_every_setting(self):
        state = self.settings()
        self.assertEqual((state["key"], state["scaleName"], state["loop"]), ("A", "Minor", {"enabled": False, "startBeats": 8.0, "lengthBeats": 16.0}))

    def test_sets_several_settings_after_checking_all(self):
        self.command("/live/song_settings/set", "root_note", 6, "scale_name", "Dorian", "groove_amount", 0.5, "loop_length", 32.0, "loop_start", 16.0, "loop", True)
        state = self.settings()
        self.assertEqual((state["key"], state["scaleName"], state["grooveAmount"], state["loop"]), ("F#", "Dorian", 0.5, {"enabled": True, "startBeats": 16.0, "lengthBeats": 32.0}))
        self.assertIn("0 to 1.3125", self.refused("/live/song_settings/set", "root_note", 0, "groove_amount", 2.0))
        self.assertEqual(self.settings()["key"], "F#")
        self.assertIn("Unknown song setting", self.refused("/live/song_settings/set", "tempo_nudge", 1))
        self.assertIn("given twice", self.refused("/live/song_settings/set", "loop", True, "loop", False))

    def test_actions(self):
        self.assertIn("no recent MIDI", self.refused("/live/song_settings/action", "capture_midi"))
        self.song.can_capture_midi = True
        self.command("/live/song_settings/action", "capture_midi")
        self.assertEqual(self.captured, ["capture"])
        self.command("/live/song_settings/action", "back_to_arrangement")
        self.assertFalse(self.song.back_to_arranger)
        self.assertIn("nothing to re-enable", self.refused("/live/song_settings/action", "re_enable_automation"))


if __name__ == "__main__":
    unittest.main()
