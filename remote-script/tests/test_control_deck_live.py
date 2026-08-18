import os
import sys
import types
import unittest
from collections import OrderedDict


class FakeControlSurface(object):
    pass


framework_package = types.ModuleType("_Framework")
control_surface_module = types.ModuleType("_Framework.ControlSurface")
control_surface_module.ControlSurface = FakeControlSurface
sys.modules.setdefault("_Framework", framework_package)
sys.modules.setdefault("_Framework.ControlSurface", control_surface_module)

live_module = types.ModuleType("Live")


class MidiNoteSpecification(object):
    def __init__(self, **values):
        self.__dict__.update(values)


live_module.Clip = types.SimpleNamespace(MidiNoteSpecification=MidiNoteSpecification)
sys.modules.setdefault("Live", live_module)

REMOTE_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, REMOTE_ROOT)

import Control_Deck.Control_Deck as bridge_module
from Control_Deck.Control_Deck import ControlDeckBridge

TEST_TOKEN = "test-bridge-token"


class Parameter(object):
    def __init__(self, name, value, minimum=0.0, maximum=1.0):
        self.name = name
        self.value = value
        self.min = minimum
        self.max = maximum

    def str_for_value(self, value):
        return "%.2f" % value


class Clip(object):
    def __init__(self):
        self.name = "Chord"
        self.length = 4.0
        self.added = []

    def add_new_notes(self, notes):
        self.added.extend(notes)

    def get_notes_extended(self, *_args):
        return []


class Slot(object):
    def __init__(self, clip=None):
        self.clip = clip

    @property
    def has_clip(self):
        return self.clip is not None

    def create_clip(self, _length):
        self.clip = Clip()


class Device(object):
    def __init__(self):
        self.name = "Operator"
        self.class_name = "Operator"
        self.type = 1
        self.parameters = [Parameter("Device On", 1.0), Parameter("Level", 0.5)]


class Track(object):
    def __init__(self, name):
        self.name = name
        self.can_be_armed = True
        self.arm = False
        self.mute = False
        self.solo = False
        self.is_foldable = False
        self.is_grouped = False
        self.playing_slot_index = -1
        self.mixer_device = types.SimpleNamespace(volume=Parameter("Volume", 0.85), panning=Parameter("Pan", 0.0, -1.0, 1.0))
        self.clip_slots = [Slot()]
        self.devices = [Device()]


class Song(object):
    def __init__(self):
        self.tracks = [Track("Synth")]
        self.scenes = [types.SimpleNamespace(name="Scene 1")]
        self.view = types.SimpleNamespace(selected_track=self.tracks[0], selected_scene=self.scenes[0])
        self.tempo = 124.0
        self.is_playing = False
        self.current_song_time = 0.0
        self.metronome = False
        self.record_mode = False
        self.session_record = False
        self.loop = False
        self.loop_start = 0.0
        self.loop_length = 4.0
        self.signature_numerator = 4
        self.signature_denominator = 4

    def create_midi_track(self, _index):
        self.tracks.append(Track("MIDI"))

    def delete_track(self, index):
        self.tracks.pop(index)

    def start_playing(self):
        self.is_playing = True


class ControlDeckLiveTests(unittest.TestCase):
    def setUp(self):
        self.song = Song()
        self.bridge = ControlDeckBridge.__new__(ControlDeckBridge)
        self.bridge.song = lambda: self.song
        self.bridge.application = lambda: types.SimpleNamespace(get_major_version=lambda: 12, get_minor_version=lambda: 4)

    def test_reads_song_tracks_and_device_parameters(self):
        tracks = self.bridge._live_query({"address": "/live/song/get/track_names", "args": []})
        self.assertEqual(tracks["args"], ["Synth"])
        params = self.bridge._live_query({"address": "/live/device/get/parameters/value_string", "args": [0, 0]})
        self.assertEqual(params["args"], [0, 0, "1.00", "0.50"])

    def test_mutates_only_allowlisted_operations(self):
        self.bridge._live_command({"address": "/live/song/set/tempo", "args": [130.0]})
        self.assertEqual(self.song.tempo, 130.0)
        self.bridge._live_command({"address": "/live/song/create_midi_track", "args": [-1]})
        self.assertEqual(len(self.song.tracks), 2)
        with self.assertRaises(Exception):
            self.bridge._live_command({"address": "/live/song/save_as", "args": ["unsafe.als"]})

    def test_creates_clip_and_validated_note_objects(self):
        self.bridge._live_command({"address": "/live/clip_slot/create_clip", "args": [0, 0, 4.0]})
        self.bridge._live_command({"address": "/live/clip/add/notes", "args": [0, 0, 60, 0.0, 1.0, 100, False]})
        note = self.song.tracks[0].clip_slots[0].clip.added[0]
        self.assertEqual((note.pitch, note.velocity), (60, 100))

    def test_replays_completed_request_id_without_repeating_mutation(self):
        previous_token = bridge_module.TOKEN
        bridge_module.TOKEN = TEST_TOKEN
        try:
            self.bridge._responses = OrderedDict()
            sent = []
            calls = []
            self.bridge._send_response = lambda _address, response: sent.append(response)
            self.bridge._dispatch = lambda method, params: calls.append((method, params)) or {"completed": True}
            request = {"protocol": "ableton-control-deck/1", "id": "same-id", "token": TEST_TOKEN, "method": "live.command", "params": {"address": "/live/song/start_playing", "args": []}}
            self.bridge._handle_request(request, ("127.0.0.1", 12345))
            self.bridge._handle_request(request, ("127.0.0.1", 12345))
            self.assertEqual(len(calls), 1)
            self.assertEqual(len(sent), 2)
        finally:
            bridge_module.TOKEN = previous_token

    def test_rejects_requests_with_a_missing_or_wrong_token(self):
        previous_token = bridge_module.TOKEN
        bridge_module.TOKEN = TEST_TOKEN
        try:
            self.bridge._responses = OrderedDict()
            sent = []
            calls = []
            self.bridge._send_response = lambda _address, response: sent.append(response)
            self.bridge._dispatch = lambda method, params: calls.append((method, params)) or {"completed": True}
            base = {"protocol": "ableton-control-deck/1", "method": "live.command", "params": {"address": "/live/song/start_playing", "args": []}}
            self.bridge._handle_request(dict(base, id="no-token"), ("127.0.0.1", 12345))
            self.bridge._handle_request(dict(base, id="bad-token", token="wrong"), ("127.0.0.1", 12345))
            self.assertEqual(calls, [])
            self.assertEqual([response["error"]["code"] for response in sent], ["AUTH_INVALID", "AUTH_INVALID"])
        finally:
            bridge_module.TOKEN = previous_token

    def test_infers_hidden_single_plugin_family_as_vst3(self):
        vendor = types.SimpleNamespace(name="FabFilter", children=[])
        root = types.SimpleNamespace(name="Plug-ins", children=[vendor])
        browser = types.SimpleNamespace(plugins=root, vst3_plugins=None, vst_plugins=None, audio_units=None, au_plugins=None)
        self.assertFalse(self.bridge._has_format_children(root))
        self.assertEqual(self.bridge._infer_plugin_family(browser, root), "VST3")

    def test_loads_a_native_live_device_and_refuses_ambiguity(self):
        echo = types.SimpleNamespace(name="Echo", children=[], is_loadable=True)
        reverb = types.SimpleNamespace(name="Reverb", children=[], is_loadable=True)
        effects = types.SimpleNamespace(name="Audio Effects", children=[echo, reverb], is_loadable=False)
        drum_rack = types.SimpleNamespace(name="Drum Rack", children=[], is_loadable=True)
        instruments = types.SimpleNamespace(name="Instruments", children=[drum_rack], is_loadable=False)
        loaded = []
        browser = types.SimpleNamespace(
            instruments=instruments, audio_effects=effects, midi_effects=None, drums=None,
            load_item=lambda value: loaded.append(value),
        )
        self.bridge.application = lambda: types.SimpleNamespace(browser=browser)

        result = self.bridge._load_browser_item({"name": "Echo", "trackIndex": 0, "expectedTrackName": "Synth"})
        self.assertEqual(loaded, [echo])
        self.assertEqual(result["loaded"], {"name": "Echo", "path": "Audio Effects/Echo", "kind": "live-device"})
        self.assertEqual(result["deviceCountBefore"], 1)

        rack_result = self.bridge._resolve_browser_item({"name": "Drum Rack"})[0]
        self.assertEqual(rack_result["path"], "Instruments/Drum Rack")

        instruments.children.append(types.SimpleNamespace(name="Echo", children=[], is_loadable=True))
        with self.assertRaises(Exception) as raised:
            self.bridge._resolve_browser_item({"name": "Echo"})
        self.assertIn("Multiple", str(raised.exception))
        disambiguated = self.bridge._resolve_browser_item({"name": "Echo", "path": "Audio Effects/Echo"})[0]
        self.assertEqual(disambiguated["path"], "Audio Effects/Echo")

    def test_loads_an_exact_user_library_device_on_a_safeguarded_track(self):
        item = types.SimpleNamespace(name="Control Deck OmniHost", children=[], is_loadable=True)
        folder = types.SimpleNamespace(name="Control Deck", children=[item], is_loadable=False)
        root = types.SimpleNamespace(name="User Library", children=[folder], is_loadable=False)
        loaded = []
        browser = types.SimpleNamespace(user_library=root, load_item=lambda value: loaded.append(value))
        self.bridge.application = lambda: types.SimpleNamespace(browser=browser)
        result = self.bridge._load_user_device({"name": "Control Deck OmniHost", "trackIndex": 0, "expectedTrackName": "Synth"})
        self.assertEqual(loaded, [item])
        self.assertEqual(result["loaded"]["path"], "User Library/Control Deck/Control Deck OmniHost")


if __name__ == "__main__":
    unittest.main()
