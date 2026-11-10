"""Song-wide settings: key and scale, groove, the Arrangement loop, punch, overdub, and a few actions."""

import json

from .bridge_core import BridgeError

SONG_QUERIES = ("/live/song_settings/get",)
SONG_COMMANDS = ("/live/song_settings/set", "/live/song_settings/action")
NOTE_NAMES = ("C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B")
BOOL_FIELDS = ("loop", "punch_in", "punch_out", "arrangement_overdub", "session_automation_record", "scale_mode")
KNOWN_FIELDS = BOOL_FIELDS + ("root_note", "scale_name", "groove_amount", "midi_recording_quantization", "loop_start", "loop_length")
MAX_BEATS = 1576800.0


class SongOps(object):
    def _song_query(self, address, args):
        return [json.dumps(self._song_settings(), separators=(",", ":"))]

    def _song_command(self, address, args):
        if address == "/live/song_settings/set":
            self._set_song_settings(args)
        else:
            self._song_action(args)

    def _song_settings(self):
        song = self.song()
        get = lambda name, default=None: getattr(song, name, default)
        root = get("root_note")
        state = {
            "rootNote": None if root is None else int(root),
            "key": None if root is None else NOTE_NAMES[int(root) % 12],
            "scaleName": None if get("scale_name") is None else str(get("scale_name")),
            "scaleMode": None if get("scale_mode") is None else bool(get("scale_mode")),
            "scaleIntervals": None if get("scale_intervals") is None else [int(step) for step in get("scale_intervals")],
            "grooveAmount": None if get("groove_amount") is None else float(get("groove_amount")),
            "loop": {"enabled": bool(get("loop", False)), "startBeats": float(get("loop_start", 0.0)), "lengthBeats": float(get("loop_length", 0.0))},
            "punchIn": bool(get("punch_in", False)),
            "punchOut": bool(get("punch_out", False)),
            "arrangementOverdub": bool(get("arrangement_overdub", False)),
            "sessionAutomationRecord": bool(get("session_automation_record", False)),
            "recordQuantization": None if get("midi_recording_quantization") is None else int(get("midi_recording_quantization")),
            "canCaptureMidi": bool(get("can_capture_midi", False)),
            "reEnableAutomationEnabled": bool(get("re_enable_automation_enabled", False)),
            "backToArrangementLit": bool(get("back_to_arranger", False)),
        }
        return state

    def _set_song_settings(self, args):
        # args: pairs of field and value. Every value is checked before any is set.
        if not args or len(args) % 2 != 0:
            raise BridgeError("INVALID_ARGUMENTS", "Song settings must be pairs of field and value")
        song = self.song()
        planned = []
        seen = set()
        for offset in range(0, len(args), 2):
            field, value = str(args[offset]), args[offset + 1]
            if field in seen:
                raise BridgeError("INVALID_ARGUMENTS", "Setting '%s' was given twice" % field)
            seen.add(field)
            if field not in KNOWN_FIELDS:
                raise BridgeError("INVALID_ARGUMENTS", "Unknown song setting '%s'" % field)
            if not hasattr(song, field):
                raise BridgeError("LIVE_VERSION_UNSUPPORTED", "This Live has no song setting '%s'; it needs Live %s" % (field, "12" if field.startswith("scale") or field == "root_note" else "11"))
            if field in BOOL_FIELDS:
                planned.append((field, self._flag(value, field)))
            elif field == "root_note":
                planned.append((field, self._bounded_int(value, "Key", 0, 11)))
            elif field == "scale_name":
                name = str(value).strip()
                if not name:
                    raise BridgeError("INVALID_ARGUMENTS", "Scale name must not be empty")
                planned.append((field, name))
            elif field == "groove_amount":
                amount = self._finite_float(value, "Groove amount")
                if amount < 0 or amount > 1.3125:
                    raise BridgeError("INVALID_RANGE", "Groove amount must be from 0 to 1.3125 (0 to 131%)")
                planned.append((field, amount))
            elif field == "midi_recording_quantization":
                planned.append((field, self._bounded_int(value, "Record quantization", 0, 8)))
            elif field in ("loop_start", "loop_length"):
                beats = self._finite_float(value, field.replace("_", " "))
                if beats < 0 or beats > MAX_BEATS or (field == "loop_length" and beats <= 0):
                    raise BridgeError("INVALID_RANGE", "Loop start must be 0 or later and loop length above 0")
                planned.append((field, beats))
            else:
                raise BridgeError("INVALID_ARGUMENTS", "Unknown song setting '%s'" % field)
        # Live keeps the loop inside the song, so set the start before the length.
        order = {"loop_start": 0, "loop_length": 1}
        for field, value in sorted(planned, key=lambda item: order.get(item[0], -1)):
            setattr(song, field, value)

    def _song_action(self, args):
        # args: action name. capture_midi, re_enable_automation, or back_to_arrangement.
        self._require_args(args, 1, "/live/song_settings/action")
        song = self.song()
        action = str(args[0])
        if action == "capture_midi":
            if not getattr(song, "can_capture_midi", False):
                raise BridgeError("NOTHING_TO_CAPTURE", "Live has no recent MIDI to capture. Play something on an armed or monitored MIDI track first.")
            song.capture_midi()
        elif action == "re_enable_automation":
            if not getattr(song, "re_enable_automation_enabled", False):
                raise BridgeError("NOTHING_TO_RE_ENABLE", "No automation is overridden, so there is nothing to re-enable")
            song.re_enable_automation()
        elif action == "back_to_arrangement":
            song.back_to_arranger = False
        else:
            raise BridgeError("INVALID_ARGUMENTS", "Action must be capture_midi, re_enable_automation, or back_to_arrangement")
