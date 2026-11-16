import json
import types
import unittest

import test_session_ops
from test_control_deck_live import Parameter
from test_session_ops import LaunchSlot, Routing, SessionClip, SessionTrack


class Wavetable(object):
    def __init__(self):
        self.name = "Wavetable"
        self.class_name = "InstrumentVector"
        self.parameters = [Parameter("Device On", 1.0), Parameter("Filter 1 Freq", 0.5), Parameter("Osc 1 Pos", 0.0), Parameter("Volume", 0.5)]
        self.oscillator_wavetable_categories = ["Basics", "Collection", "Vocal"]
        self.oscillator_1_wavetables = ["Basic Shapes", "Sine Square"]
        self.oscillator_2_wavetables = ["Basic Shapes"]
        self.oscillator_1_wavetable_category = 0
        self.oscillator_1_wavetable_index = 0
        self.oscillator_2_wavetable_category = 0
        self.oscillator_2_wavetable_index = 0
        self.oscillator_1_effect_mode = 0
        self.oscillator_2_effect_mode = 0
        self.unison_mode = 0
        self.unison_voice_count = 2
        self.mono_poly = 1
        self.poly_voices = 3
        self.filter_routing = 0
        self.visible_modulation_target_names = ["Amp", "Filter 1 Freq"]
        self.matrix = {(0, 0): 1.0}

    def get_modulation_value(self, target, source):
        if not 0 <= source < 11 or target >= len(self.visible_modulation_target_names):
            raise RuntimeError("index out of range")
        return self.matrix.get((target, source), 0.0)

    def set_modulation_value(self, target, source, value):
        self.matrix[(target, source)] = value

    def is_parameter_modulatable(self, parameter):
        return parameter.name != "Device On"

    def add_parameter_to_modulation_matrix(self, parameter):
        self.visible_modulation_target_names = self.visible_modulation_target_names + [parameter.name]


class RecordingSlot(LaunchSlot):
    def fire(self, record_length=None):
        self.fired += 1
        self.record_length = record_length
        self.is_recording = True

    def stop(self):
        self.is_recording = False


class SoundOpsTests(unittest.TestCase):
    query = test_session_ops.SessionOpsTests.query
    command = test_session_ops.SessionOpsTests.command
    refused = test_session_ops.SessionOpsTests.refused

    def setUp(self):
        test_session_ops.SessionOpsTests.setUp(self)
        self.song.tempo = 120.0
        self.song.is_playing = False
        self.song.record_mode = False
        self.song.session_record = False
        self.wavetable = Wavetable()
        self.song.tracks[0].devices = [self.wavetable]
        song = self.song

        def create_audio_track(index):
            track = SessionTrack("Audio", midi=False)
            track.clip_slots = [RecordingSlot(), RecordingSlot()]
            track.available_input_routing_types = [Routing(t.name) for t in song.tracks] + [Routing("Resampling")]
            track.available_input_routing_channels = [Routing("Pre FX"), Routing("Post FX"), Routing("Post Mixer")]
            track.current_monitoring_state = 1
            song.tracks.append(track)

        song.create_audio_track = create_audio_track
        song.stop_playing = lambda: setattr(song, "is_playing", False)

    def device(self, *extra):
        return ("track", 0, "Drums", 0, "Wavetable") + extra

    def test_reads_and_sets_wavetable_settings(self):
        state = json.loads(self.query("/live/device/get/properties", *self.device())[0])
        self.assertEqual(state["properties"]["unison_mode"], {"value": 0, "options": list(state["properties"]["unison_mode"]["options"]), "label": "None"})
        self.assertEqual(state["lists"]["oscillator_1_wavetables"], ["Basic Shapes", "Sine Square"])
        self.command("/live/device/set_property", *self.device("unison_mode", 2))
        self.assertEqual(self.wavetable.unison_mode, 2)
        self.command("/live/device/set_property", *self.device("oscillator_1_wavetable_index", 1))
        self.assertEqual(self.wavetable.oscillator_1_wavetable_index, 1)
        self.assertIn("0 to 1", self.refused("/live/device/set_property", *self.device("oscillator_1_wavetable_index", 2)))
        self.assertIn("0 to 2", self.refused("/live/device/set_property", *self.device("filter_routing", 3)))
        self.assertIn("no setting", self.refused("/live/device/set_property", *self.device("tempo", 1)))
        self.assertIn("Expected device 0", self.refused("/live/device/set_property", "track", 0, "Drums", 0, "Operator", "unison_mode", 1))

    def test_refuses_devices_without_extra_settings(self):
        self.song.tracks[0].devices = [types.SimpleNamespace(name="Drift", class_name="Drift", parameters=[])]
        with self.assertRaises(Exception) as raised:
            self.query("/live/device/get/properties", "track", 0, "Drums", 0, "Drift")
        self.assertIn("use its parameters", str(raised.exception))

    def test_modulation_matrix(self):
        state = json.loads(self.query("/live/device/get/modulation", *self.device())[0])
        self.assertEqual(state["sourceCount"], 11)
        self.assertEqual(state["targets"][0]["amounts"][0], 1.0)
        self.assertEqual(state["addableTargets"], ["Osc 1 Pos", "Volume"])
        self.command("/live/device/set_modulation", *self.device("Filter 1 Freq", 3, 0.5))
        self.assertEqual(self.wavetable.matrix[(1, 3)], 0.5)
        self.command("/live/device/set_modulation", *self.device("Osc 1 Pos", 1, -0.25))
        self.assertEqual(self.wavetable.matrix[(2, 1)], -0.25)
        self.assertIn("cannot be modulated", self.refused("/live/device/set_modulation", *self.device("Device On", 0, 0.5)))
        self.assertIn("-1 to 1", self.refused("/live/device/set_modulation", *self.device("Amp", 0, 2.0)))
        self.assertIn("0 to 10", self.refused("/live/device/set_modulation", *self.device("Amp", 11, 0.5)))

    def test_capture_records_a_track_and_cleans_up(self):
        source_slot = self.song.tracks[0].clip_slots[1]
        source_slot.clip = SessionClip("Lead", midi=True)
        self.command("/live/capture/start", "track", 0, "Drums", 8.0, "post_fx", 1, "Lead")
        capture = self.song.tracks[-1]
        self.assertEqual(capture.name, "Control Deck Capture")
        self.assertEqual((capture.input_routing_type.display_name, capture.input_routing_channel.display_name), ("Drums", "Post FX"))
        self.assertEqual((capture.arm, capture.current_monitoring_state), (True, 2))
        self.assertEqual(capture.clip_slots[0].record_length, 8.0)
        self.assertEqual(source_slot.fired, 1)
        state = json.loads(self.query("/live/capture/state")[0])
        self.assertTrue(state["recording"])
        self.assertIn("already exists", self.refused("/live/capture/start", "track", 0, "Drums", 8.0, "post_fx", -1, ""))
        # Finishing is allowed while Live records, and removes the track.
        self.song.session_record = True
        self.bridge._dispatch("live.command", {"address": "/live/capture/finish", "args": [True]})
        self.assertNotIn("Control Deck Capture", [track.name for track in self.song.tracks])
        self.assertFalse(json.loads(self.query("/live/capture/state")[0])["exists"])

    def test_capture_refuses_bad_requests(self):
        self.assertIn("0.25 to 256", self.refused("/live/capture/start", "track", 0, "Drums", 0.0, "post_fx", -1, ""))
        self.assertIn("tap must be", self.refused("/live/capture/start", "track", 0, "Drums", 4.0, "side", -1, ""))
        self.assertIn("no clip in scene", self.refused("/live/capture/start", "track", 0, "Drums", 4.0, "post_fx", 0, "Lead"))
        self.assertIn("No 'Control Deck Capture'", self.refused("/live/capture/finish", True))
        self.command("/live/capture/start", "master", 0, "Main", 4.0, "post_mixer", -1, "")
        self.assertEqual(self.song.tracks[-1].input_routing_type.display_name, "Resampling")


if __name__ == "__main__":
    unittest.main()
