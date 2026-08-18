import os
import sys
import unittest


SCRIPT_DIR = os.path.join(os.path.dirname(__file__), "..", "Control_Deck")
sys.path.insert(0, os.path.abspath(SCRIPT_DIR))

from bridge_core import BridgeError, filter_plugins, format_from_path, resolve_plugin


PLUGINS = [
    {"name": "Pro-Q 4", "path": "Plugins/VST3/FabFilter/Pro-Q 4", "format": "vst3", "item": object()},
    {"name": "Diva", "path": "Plugins/VST3/u-he/Diva", "format": "vst3", "item": object()},
    {"name": "Diva", "path": "Plugins/AU/u-he/Diva", "format": "au", "item": object()},
]


class BridgeCoreTests(unittest.TestCase):
    def test_classifies_plugin_paths(self):
        self.assertEqual(format_from_path("Plugins/VST3/FabFilter/Pro-Q 4"), "vst3")
        self.assertEqual(format_from_path("Plugins/VST3 Plug-ins/FabFilter/Pro-Q 4"), "vst3")
        self.assertEqual(format_from_path("Plugins/VST/u-he/Diva"), "vst2")
        self.assertEqual(format_from_path("Plugins/AU/u-he/Diva"), "au")

    def test_filters_without_exposing_live_objects(self):
        result = filter_plugins(PLUGINS, "diva", "vst3", 20, 0)
        self.assertEqual(result["matched"], 1)
        self.assertNotIn("item", result["plugins"][0])

    def test_resolves_exact_name_and_format(self):
        result = resolve_plugin(PLUGINS, "Diva", "au")
        self.assertEqual(result["path"], "Plugins/AU/u-he/Diva")

    def test_exact_path_is_an_identity_safeguard(self):
        with self.assertRaises(BridgeError) as context:
            resolve_plugin(PLUGINS, "Diva", "vst3", "Plugins/VST3/FabFilter/Pro-Q 4")
        self.assertEqual(context.exception.code, "PLUGIN_IDENTITY_MISMATCH")


if __name__ == "__main__":
    unittest.main()
