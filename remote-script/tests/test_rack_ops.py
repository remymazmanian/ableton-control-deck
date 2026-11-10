import json
import types
import unittest

from test_control_deck_live import Parameter
import test_session_ops


def device(name, class_name="Eq8", parameters=None):
    params = [Parameter("Device On", 1.0, 0.0, 1.0)] + list(parameters or [Parameter("Gain", 0.5, 0.0, 1.0)])
    return types.SimpleNamespace(name=name, class_name=class_name, parameters=params)


def chain(name, devices):
    return types.SimpleNamespace(name=name, mute=False, solo=False, devices=devices)


class Rack(object):
    def __init__(self, name, chains, drum=False):
        self.name = name
        self.class_name = "DrumGroupDevice" if drum else "InstrumentGroupDevice"
        self.can_have_chains = True
        self.can_have_drum_pads = drum
        self.chains = chains
        self.parameters = [Parameter("Device On", 1.0, 0.0, 1.0)] + [Parameter("Macro %d" % n, 0.0, 0.0, 127.0) for n in range(1, 17)]
        self.parameters[1].name = "Cutoff"
        self.visible_macro_count = 8
        self.variation_count = 0
        self.selected_variation_index = -1
        self.drum_pads = []
        self.recalled = []

    def store_variation(self):
        self.variation_count += 1

    def recall_selected_variation(self):
        self.recalled.append(self.selected_variation_index)

    def delete_selected_variation(self):
        self.variation_count -= 1

    def randomize_macros(self):
        for parameter in self.parameters[1:]:
            parameter.value = 64.0


class RackOpsTests(unittest.TestCase):
    # Reuse the session fixtures (a fake song and bridge) without re-running the session tests.
    query = test_session_ops.SessionOpsTests.query
    command = test_session_ops.SessionOpsTests.command
    refused = test_session_ops.SessionOpsTests.refused

    def setUp(self):
        test_session_ops.SessionOpsTests.setUp(self)
        inner = Rack("Bass Rack", [chain("Sub", [device("Operator", "Operator")])])
        self.rack = Rack("Keys Rack", [chain("Piano", [device("Simpler", "OriginalSimpler"), inner]), chain("Pad", [device("Drift", "Drift")])])
        self.song.tracks[0].devices = [self.rack]
        kick = types.SimpleNamespace(note=36, name="Kick", mute=False, solo=False, chains=[chain("Kick", [])])
        empty = types.SimpleNamespace(note=37, name="", mute=False, solo=False, chains=[])
        self.drums = Rack("Drum Rack", [], drum=True)
        self.drums.drum_pads = [kick, empty]
        self.song.tracks[1].devices = [self.drums]

    def rack_state(self, track, path):
        return json.loads(self.query("/live/rack/get", "track", track, path)[0])

    def test_rack_reads_chains_macros_nested_paths_and_pads(self):
        state = self.rack_state(0, "0")
        self.assertEqual((state["name"], state["isDrumRack"], state["visibleMacroCount"]), ("Keys Rack", False, 8))
        self.assertEqual([macro["name"] for macro in state["macros"]][:2], ["Cutoff", "Macro 2"])
        self.assertEqual(state["chains"][0]["devices"][1], {"path": "0/0/1", "name": "Bass Rack", "className": "InstrumentGroupDevice", "enabled": True, "isRack": True})
        self.assertEqual(self.rack_state(0, "0/0/1")["chains"][0]["devices"][0]["path"], "0/0/1/0/0")
        drums = self.rack_state(1, "0")
        self.assertEqual(drums["drumPads"], [{"note": 36, "name": "Kick", "mute": False, "solo": False, "chainCount": 1}])

    def test_rack_bad_path_messages(self):
        for path, text in (("0/0", "must be a device index"), ("0/5/0", "no chain 5"), ("3", "No device 3"), ("0/x/1", "whole numbers")):
            with self.assertRaises(Exception) as raised:
                self.query("/live/rack/get", "track", 0, path)
            self.assertIn(text, str(raised.exception))
        with self.assertRaises(Exception) as raised:
            self.query("/live/rack/get", "track", 0, "0/0/0")
        self.assertIn("is not a rack", str(raised.exception))

    def test_rack_sets_macros_after_checking_every_value(self):
        self.command("/live/rack/set_macros", "track", 0, "Drums", "0", "Keys Rack", 1, 100.0, 2, 30.0)
        self.assertEqual((self.rack.parameters[1].value, self.rack.parameters[2].value), (100.0, 30.0))
        self.assertIn("from 0 to 127", self.refused("/live/rack/set_macros", "track", 0, "Drums", "0", "Keys Rack", 3, 50.0, 4, 200.0))
        self.assertEqual(self.rack.parameters[3].value, 0.0)
        self.assertIn("found 'Keys Rack'", self.refused("/live/rack/set_macros", "track", 0, "Drums", "0", "Bass Rack", 1, 1.0))
        self.assertEqual(self.song.undo_log.count("begin"), self.song.undo_log.count("end"))

    def test_rack_chain_rename_mute_solo(self):
        self.command("/live/rack/set_chain", "track", 0, "Drums", "0", "Keys Rack", 1, "Pad", "name", "Strings", "mute", True)
        self.assertEqual((self.rack.chains[1].name, self.rack.chains[1].mute), ("Strings", True))
        self.assertIn("found 'Piano'", self.refused("/live/rack/set_chain", "track", 0, "Drums", "0", "Keys Rack", 0, "Organ", "solo", True))
        self.assertIn("Unknown chain field", self.refused("/live/rack/set_chain", "track", 0, "Drums", "0", "Keys Rack", 0, "Piano", "color", 1))

    def test_rack_drum_pad_mute_and_solo(self):
        self.command("/live/rack/set_drum_pad", "track", 1, "Vox", "0", "Drum Rack", 36, "Kick", "mute", True, "solo", True)
        self.assertEqual((self.drums.drum_pads[0].mute, self.drums.drum_pads[0].solo), (True, True))
        self.assertIn("found 'Kick'", self.refused("/live/rack/set_drum_pad", "track", 1, "Vox", "0", "Drum Rack", 36, "Snare", "mute", False))
        self.assertIn("not a Drum Rack", self.refused("/live/rack/set_drum_pad", "track", 0, "Drums", "0", "Keys Rack", 36, "Kick", "mute", True))

    def test_rack_variations(self):
        self.command("/live/rack/variation", "track", 0, "Drums", "0", "Keys Rack", "store", -1)
        self.command("/live/rack/variation", "track", 0, "Drums", "0", "Keys Rack", "store", -1)
        self.command("/live/rack/variation", "track", 0, "Drums", "0", "Keys Rack", "recall", 1)
        self.assertEqual(self.rack.recalled, [1])
        self.assertIn("no variation 5", self.refused("/live/rack/variation", "track", 0, "Drums", "0", "Keys Rack", "recall", 5))
        self.command("/live/rack/variation", "track", 0, "Drums", "0", "Keys Rack", "randomize", -1)
        self.assertEqual(self.rack.parameters[1].value, 64.0)
        self.command("/live/rack/variation", "track", 0, "Drums", "0", "Keys Rack", "delete", 0)
        self.assertEqual(self.rack.variation_count, 1)

    def test_nested_device_parameters_by_path(self):
        values = json.loads(self.query("/live/device_path/get/parameters", "track", 0, "0/1/0")[0])
        self.assertEqual((values["name"], values["parameters"][1]["name"]), ("Drift", "Gain"))
        self.command("/live/device_path/set_parameter", "track", 0, "Drums", "0/1/0", "Drift", 1, "Gain", 0.25)
        self.assertEqual(self.rack.chains[1].devices[0].parameters[1].value, 0.25)
        self.command("/live/device_path/set_parameter", "track", 0, "Drums", "0/0/1/0/0", "Operator", 0, "Device On", 0.0)
        self.assertEqual(self.rack.chains[0].devices[1].chains[0].devices[0].parameters[0].value, 0.0)
        self.assertIn("found 'Gain'", self.refused("/live/device_path/set_parameter", "track", 0, "Drums", "0/1/0", "Drift", 1, "Volume", 0.1))
        self.assertIn("from 0 to 1", self.refused("/live/device_path/set_parameter", "track", 0, "Drums", "0/1/0", "Drift", 1, "Gain", 3.0))
        self.assertIn("found 'Drift'", self.refused("/live/device_path/set_parameter", "track", 0, "Drums", "0/1/0", "Wavetable", 1, "Gain", 0.1))


if __name__ == "__main__":
    unittest.main()
