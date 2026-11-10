"""Mixer, launching, scene, clip-property, undo, and track operations for the Control Deck Bridge.

ControlDeckBridge mixes this class in. Every address here is on an explicit
allowlist, and every mutation checks the target's current name first.
"""

import re

from .bridge_core import BridgeError
from .rack_ops import RACK_COMMANDS, RACK_QUERIES, RackOps


MAX_NAME = 128
TRACK_KINDS = ("track", "return", "master")
LAUNCH_MODE_MAX = 3
LAUNCH_QUANTIZATION_MAX = 14
WARP_MODE_MAX = 6
MAX_SCENES = 1000
DB_PATTERN = re.compile(r"^\s*(-?inf|[-+]?\d+(?:\.\d+)?)\s*dB\s*$", re.IGNORECASE)
NO_SEND = -1

MIXER_FIELDS = ("volume", "volume_db", "panning", "send", "send_db", "mute", "solo", "arm")
CLIP_FIELDS = (
    "name", "color", "looping", "loop_start", "loop_end", "start_marker", "end_marker",
    "launch_mode", "launch_quantization", "legato", "muted",
    "gain", "pitch_coarse", "pitch_fine", "warping", "warp_mode",
)
AUDIO_CLIP_FIELDS = ("gain", "pitch_coarse", "pitch_fine", "warping", "warp_mode")
TRACK_FIELDS = ("color", "folded", "input_routing_type", "input_routing_channel", "output_routing_type", "output_routing_channel")

SESSION_QUERIES = (
    "/live/mixer/get",
    "/live/session/get/playback",
    "/live/clip_slot/get/state",
    "/live/song/get/scenes",
    "/live/clip/get/properties",
    "/live/song/get/undo_state",
    "/live/track/get/details",
    "/live/track/get/routing_options",
    "/live/session_clip/get/notes",
    "/live/song/get/api_features",
    "/live/device/get/sample",
    "/live/devices/get/state",
    "/live/view/get/selection",
) + RACK_QUERIES
SESSION_COMMANDS = (
    "/live/mixer/set",
    "/live/clip_slot/fire",
    "/live/track/stop_clips",
    "/live/scene/fire",
    "/live/song/stop_all_clips",
    "/live/song/create_scene",
    "/live/song/duplicate_scene",
    "/live/song/delete_scene",
    "/live/scene/set",
    "/live/clip/set",
    "/live/clip_slot/duplicate_to",
    "/live/clip_slot/delete_clip",
    "/live/song/undo",
    "/live/song/redo",
    "/live/track/set",
    "/live/song/duplicate_track",
    "/live/session_clip/modify/notes",
    "/live/session_clip/remove/notes",
    "/live/song/create_return_track",
    "/live/song/delete_return_track",
    "/live/clip_slot/load_sample",
    "/live/track/load_sample_to_arrangement",
    "/live/device/replace_sample",
    "/live/device/set_enabled",
    "/live/device/delete",
    "/live/view/select",
) + RACK_COMMANDS
# Undo and redo move through Live's history, so they must not open a step of their own.
# Same limit as Control_Deck.MAX_ARRANGEMENT_BEATS (importing it here would be circular).
MAX_ARRANGEMENT_BEATS = 1576800.0
SAMPLE_EXTENSIONS = (".wav", ".aif", ".aiff", ".mp3", ".flac")
# Selecting changes Live's view, not the set, so it is not an undoable step either.
NO_UNDO_STEP = ("/live/song/undo", "/live/song/redo", "/live/view/select")


class SessionOps(RackOps):
    # ------------------------------------------------------------------ dispatch

    def _session_query(self, address, args):
        if address == "/live/mixer/get":
            return self._mixer_state(args)
        if address == "/live/session/get/playback":
            return self._session_playback()
        if address == "/live/clip_slot/get/state":
            return self._clip_slot_state(args)
        if address == "/live/song/get/scenes":
            return self._scene_details()
        if address == "/live/clip/get/properties":
            return self._clip_properties(args)
        if address == "/live/song/get/undo_state":
            song = self.song()
            return [bool(song.can_undo), bool(song.can_redo)]
        if address == "/live/track/get/details":
            return self._track_details(args)
        if address == "/live/track/get/routing_options":
            return self._routing_options(args)
        if address == "/live/session_clip/get/notes":
            return self._session_clip_notes(args)
        if address == "/live/song/get/api_features":
            return self._api_features()
        if address == "/live/device/get/sample":
            return self._device_sample(args)
        if address == "/live/devices/get/state":
            return self._devices_state(args)
        if address == "/live/view/get/selection":
            return self._selection()
        if address in RACK_QUERIES:
            return self._rack_query(address, args)
        raise BridgeError("ADDRESS_NOT_ALLOWED", "Unsupported Live query: %s" % address)

    def _session_command(self, address, args):
        handlers = {
            "/live/mixer/set": self._set_mixer,
            "/live/clip_slot/fire": self._fire_clip,
            "/live/track/stop_clips": self._stop_track_clips,
            "/live/scene/fire": self._fire_scene,
            "/live/song/stop_all_clips": self._stop_all_clips,
            "/live/song/create_scene": self._create_scene,
            "/live/song/duplicate_scene": self._duplicate_scene,
            "/live/song/delete_scene": self._delete_scene,
            "/live/scene/set": self._set_scene,
            "/live/clip/set": self._set_clip,
            "/live/clip_slot/duplicate_to": self._duplicate_clip,
            "/live/clip_slot/delete_clip": self._delete_clip,
            "/live/song/undo": self._undo,
            "/live/song/redo": self._redo,
            "/live/track/set": self._set_track,
            "/live/song/duplicate_track": self._duplicate_track,
            "/live/session_clip/modify/notes": self._modify_session_notes,
            "/live/session_clip/remove/notes": self._remove_session_notes,
            "/live/song/create_return_track": self._create_return_track,
            "/live/song/delete_return_track": self._delete_return_track,
            "/live/clip_slot/load_sample": self._load_sample_to_slot,
            "/live/track/load_sample_to_arrangement": self._load_sample_to_arrangement,
            "/live/device/replace_sample": self._replace_simpler_sample,
            "/live/device/set_enabled": self._set_device_enabled,
            "/live/device/delete": self._delete_device,
            "/live/view/select": self._select,
        }
        if address in RACK_COMMANDS:
            return self._rack_command(address, args)
        handler = handlers.get(address)
        if handler is None:
            raise BridgeError("ADDRESS_NOT_ALLOWED", "Unsupported Live mutation: %s" % address)
        handler(args)

    def _in_undo_step(self, address, run):
        # One agent action should be one Cmd-Z. Live versions without
        # begin_undo_step still run the change, just without the grouping.
        song = self.song()
        begin = getattr(song, "begin_undo_step", None)
        end = getattr(song, "end_undo_step", None)
        if address in NO_UNDO_STEP or not callable(begin) or not callable(end):
            return run()
        begin()
        try:
            return run()
        finally:
            end()

    # ------------------------------------------------------------------ targets

    def _any_track(self, args, position=0):
        # args[position] is the kind (track, return, or master), args[position + 1] the index.
        self._require_args(args, position + 2, "track operation")
        kind = str(args[position])
        if kind not in TRACK_KINDS:
            raise BridgeError("INVALID_TRACK", "Track kind must be track, return, or master")
        index = self._non_negative_index(args[position + 1], "Track index")
        song = self.song()
        if kind == "master":
            if index != 0:
                raise BridgeError("INVALID_TRACK", "The master track has index 0")
            return kind, index, song.master_track
        tracks = list(song.tracks if kind == "track" else song.return_tracks)
        if index >= len(tracks):
            raise BridgeError("INVALID_TRACK", "%s index %d does not exist" % ("Track" if kind == "track" else "Return track", index))
        return kind, index, tracks[index]

    def _named_any_track(self, args):
        self._require_args(args, 3, "track operation")
        kind, index, track = self._any_track(args)
        expected = str(args[2])
        if track.name != expected:
            raise BridgeError("TRACK_IDENTITY_MISMATCH", "Expected %s '%s', found '%s'" % (self._kind_label(kind), expected, track.name))
        return kind, index, track

    def _kind_label(self, kind):
        return {"track": "track", "return": "return track", "master": "master track"}[kind]

    def _scene(self, args, position=0):
        self._require_args(args, position + 1, "scene operation")
        index = self._non_negative_index(args[position], "Scene index")
        scenes = list(self.song().scenes)
        if index >= len(scenes):
            raise BridgeError("INVALID_SCENE", "Scene index %d does not exist" % index)
        return index, scenes[index]

    def _named_scene(self, args, position=0):
        self._require_args(args, position + 2, "scene operation")
        index, scene = self._scene(args, position)
        expected = str(args[position + 1])
        if scene.name != expected:
            raise BridgeError("SCENE_IDENTITY_MISMATCH", "Expected scene %d to be named '%s', found '%s'" % (index, expected, scene.name))
        return index, scene

    def _named_clip_slot(self, args, position=0):
        # args: track, scene, expectedTrackName, expectedClipName
        self._require_args(args, position + 4, "clip operation")
        track_index = self._non_negative_index(args[position], "Track index")
        scene_index = self._non_negative_index(args[position + 1], "Scene index")
        tracks = list(self.song().tracks)
        if track_index >= len(tracks):
            raise BridgeError("INVALID_TRACK", "Track index %d does not exist" % track_index)
        track = tracks[track_index]
        if track.name != str(args[position + 2]):
            raise BridgeError("TRACK_IDENTITY_MISMATCH", "Expected track '%s', found '%s'" % (args[position + 2], track.name))
        slots = list(track.clip_slots)
        if scene_index >= len(slots):
            raise BridgeError("INVALID_SCENE", "Scene index %d does not exist" % scene_index)
        slot = slots[scene_index]
        if not slot.has_clip:
            raise BridgeError("CLIP_NOT_FOUND", "No clip at track %d, scene %d" % (track_index, scene_index))
        if slot.clip.name != str(args[position + 3]):
            raise BridgeError("CLIP_IDENTITY_MISMATCH", "Expected clip '%s' at track %d, scene %d, found '%s'" % (args[position + 3], track_index, scene_index, slot.clip.name))
        return track_index, scene_index, track, slot

    def _clean_name(self, value, label):
        name = str(value).replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
        if len(name) > MAX_NAME:
            raise BridgeError("INVALID_ARGUMENTS", "%s exceeds %d characters" % (label, MAX_NAME))
        return name

    def _confirmed(self, value, action):
        if value is not True:
            raise BridgeError("CONFIRM_REQUIRED", "%s requires confirm=true" % action)

    def _flag(self, value, label):
        if value is True or value is False:
            return value
        if value in (0, 1) and not isinstance(value, float):
            return bool(value)
        raise BridgeError("INVALID_ARGUMENTS", "%s must be true or false" % label)

    def _color(self, value):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or float(value) != int(value):
            raise BridgeError("INVALID_ARGUMENTS", "Color must be an RGB integer")
        number = int(value)
        if number < 0 or number > 0xFFFFFF:
            raise BridgeError("INVALID_ARGUMENTS", "Color must be from 0x000000 to 0xFFFFFF")
        return number

    def _bounded_int(self, value, label, low, high):
        if isinstance(value, bool) or not isinstance(value, (int, float)) or float(value) != int(value):
            raise BridgeError("INVALID_ARGUMENTS", "%s must be an integer" % label)
        number = int(value)
        if number < low or number > high:
            raise BridgeError("INVALID_ARGUMENTS", "%s must be from %d to %d" % (label, low, high))
        return number

    def _require_feature(self, target, attribute, feature):
        if not hasattr(target, attribute):
            raise BridgeError("LIVE_VERSION_UNSUPPORTED", "%s is not available in this Live (%s)" % (feature, self._live_version_text()))

    # ------------------------------------------------------------------ mixer

    def _value_for_db(self, parameter, db, label):
        # Live does not publish its fader law, so search the parameter range for
        # the value whose display reads the requested dB. The law is monotonic.
        low, high = float(parameter.min), float(parameter.max)

        def db_at(value):
            match = DB_PATTERN.match(str(parameter.str_for_value(value)))
            if not match:
                raise BridgeError("PARAMETER_NOT_DB", "%s does not display in dB" % label)
            return float(match.group(1).lower())

        if db == "-inf":
            return low
        target = self._finite_float(db, "%s dB" % label)
        top = db_at(high)
        if target > top + 0.05:
            raise BridgeError("INVALID_RANGE", "%s cannot go above %s dB" % (label, self._beat_text(top)))
        if target >= top:
            return high
        if target <= db_at(low):
            return low
        for _ in range(48):
            middle = (low + high) / 2.0
            if db_at(middle) < target:
                low = middle
            else:
                high = middle
        return high

    def _mixer_state(self, args):
        kind, index, track = self._any_track(args)
        mixer = track.mixer_device
        values = [kind, index, track.name]
        values.extend(["volume", float(mixer.volume.value), "volumeDisplay", mixer.volume.str_for_value(mixer.volume.value)])
        values.extend(["panning", float(mixer.panning.value), "panningDisplay", mixer.panning.str_for_value(mixer.panning.value)])
        if kind != "master":
            values.extend(["mute", bool(track.mute), "solo", bool(track.solo)])
        can_arm = kind == "track" and bool(getattr(track, "can_be_armed", False))
        values.extend(["canBeArmed", can_arm])
        if can_arm:
            values.extend(["arm", bool(track.arm)])
        sends = list(getattr(mixer, "sends", []) or []) if kind != "master" else []
        returns = list(self.song().return_tracks)
        values.extend(["sendCount", len(sends)])
        for send_index, send in enumerate(sends):
            values.extend([
                "send", send_index,
                float(send.value), send.str_for_value(send.value),
                returns[send_index].name if send_index < len(returns) else None,
            ])
        return values

    def _set_mixer(self, args):
        # args: kind, index, expectedName, then groups of (field, sendIndex, value).
        kind, index, track = self._named_any_track(args)
        changes = args[3:]
        if not changes or len(changes) % 3 != 0:
            raise BridgeError("INVALID_ARGUMENTS", "Mixer changes must be groups of field, send index, and value")
        mixer = track.mixer_device
        planned = []
        for offset in range(0, len(changes), 3):
            field, send_index, value = str(changes[offset]), changes[offset + 1], changes[offset + 2]
            if field not in MIXER_FIELDS:
                raise BridgeError("INVALID_ARGUMENTS", "Unknown mixer field '%s'" % field)
            planned.append(self._plan_mixer_change(kind, index, track, mixer, field, send_index, value))
        # Validate everything first, then apply, so a bad field never leaves a half-applied mix.
        for apply in planned:
            apply()

    def _plan_mixer_change(self, kind, index, track, mixer, field, send_index, value):
        if field in ("mute", "solo"):
            if kind == "master":
                raise BridgeError("INVALID_ARGUMENTS", "The master track has no %s" % field)
            flag = self._flag(value, field)
            return lambda: setattr(track, field, flag)
        if field == "arm":
            if kind != "track" or not bool(getattr(track, "can_be_armed", False)):
                raise BridgeError("TRACK_NOT_ARMABLE", "Track '%s' cannot be armed" % track.name)
            flag = self._flag(value, field)
            return lambda: setattr(track, "arm", flag)
        if field in ("send", "send_db"):
            if kind == "master":
                raise BridgeError("INVALID_ARGUMENTS", "The master track has no sends")
            sends = list(getattr(mixer, "sends", []) or [])
            position = self._non_negative_index(send_index, "Send index")
            if position >= len(sends):
                raise BridgeError("INVALID_SEND", "Send %d does not exist; this set has %d return track(s)" % (position, len(sends)))
            if kind == "return" and position == index:
                raise BridgeError("INVALID_SEND", "Return track '%s' cannot send to itself" % track.name)
            parameter = sends[position]
            label = "Send %s" % chr(ord("A") + position) if position < 26 else "Send %d" % position
        elif field in ("volume", "volume_db"):
            parameter, label = mixer.volume, "Volume"
        else:
            parameter, label = mixer.panning, "Pan"
        if field.endswith("_db"):
            target = self._value_for_db(parameter, value, label)
        else:
            target = self._finite_float(value, label)
            if target < float(parameter.min) - 1e-9 or target > float(parameter.max) + 1e-9:
                raise BridgeError("INVALID_RANGE", "%s must be from %s to %s" % (label, parameter.min, parameter.max))
        return lambda: setattr(parameter, "value", target)

    # ------------------------------------------------------------------ launching

    def _session_playback(self):
        song = self.song()
        values = [len(list(song.tracks))]
        for track in song.tracks:
            values.extend([track.name, int(track.playing_slot_index), int(getattr(track, "fired_slot_index", -1))])
        scenes = list(song.scenes)
        values.append(len(scenes))
        for scene in scenes:
            values.append(bool(getattr(scene, "is_triggered", False)))
        return values

    def _clip_slot_state(self, args):
        track_index, scene_index, slot = self._clip_slot(args)
        has_clip = bool(slot.has_clip)
        clip = slot.clip if has_clip else None
        return [
            track_index, scene_index, has_clip,
            clip.name if clip is not None else None,
            bool(getattr(slot, "is_playing", False)),
            bool(getattr(slot, "is_triggered", False)),
            bool(getattr(slot, "is_recording", False)),
        ]

    def _fire_clip(self, args):
        _track_index, _scene_index, _track, slot = self._named_clip_slot(args)
        slot.fire()

    def _stop_track_clips(self, args):
        self._require_args(args, 2, "/live/track/stop_clips")
        _track_index, track = self._named_track(args)
        track.stop_all_clips()

    def _fire_scene(self, args):
        _index, scene = self._named_scene(args)
        scene.fire()

    def _stop_all_clips(self, args):
        quantized = True if not args else self._flag(args[0], "quantized")
        self.song().stop_all_clips(quantized)

    # ------------------------------------------------------------------ scenes

    def _scene_details(self):
        scenes = list(self.song().scenes)
        values = [len(scenes)]
        for scene in scenes:
            values.extend([
                scene.name,
                self._optional_int(scene, "color"),
                self._optional_number(scene, "tempo"),
                self._optional_bool(scene, "tempo_enabled"),
                self._optional_int(scene, "time_signature_numerator"),
                self._optional_int(scene, "time_signature_denominator"),
                self._optional_bool(scene, "time_signature_enabled"),
                bool(getattr(scene, "is_triggered", False)),
            ])
        return values

    def _optional_int(self, target, name):
        try:
            return int(getattr(target, name))
        except Exception:
            return None

    def _optional_number(self, target, name):
        try:
            return float(getattr(target, name))
        except Exception:
            return None

    def _optional_bool(self, target, name):
        try:
            return bool(getattr(target, name))
        except Exception:
            return None

    def _create_scene(self, args):
        self._require_args(args, 1, "/live/song/create_scene")
        song = self.song()
        count = len(list(song.scenes))
        if count >= MAX_SCENES:
            raise BridgeError("INVALID_SCENE", "This set already has %d scenes" % count)
        index = self._bounded_int(args[0], "Scene index", -1, count)
        name = self._clean_name(args[1], "Scene name") if len(args) >= 2 and args[1] is not None else ""
        created = song.create_scene(index)
        if name:
            target = created if hasattr(created, "name") else list(song.scenes)[count if index == -1 else index]
            target.name = name

    def _duplicate_scene(self, args):
        index, _scene = self._named_scene(args)
        self.song().duplicate_scene(index)

    def _delete_scene(self, args):
        self._require_args(args, 3, "/live/song/delete_scene")
        index, _scene = self._named_scene(args)
        self._confirmed(args[2], "delete_scene")
        if len(list(self.song().scenes)) <= 1:
            raise BridgeError("LAST_SCENE", "Live needs at least one scene, so the last scene cannot be deleted")
        self.song().delete_scene(index)

    def _set_scene(self, args):
        # args: index, expectedName, then groups of (field, value, extra).
        _index, scene = self._named_scene(args)
        changes = args[2:]
        if not changes or len(changes) % 3 != 0:
            raise BridgeError("INVALID_ARGUMENTS", "Scene changes must be groups of field, value, and extra")
        planned = []
        for offset in range(0, len(changes), 3):
            field, value, extra = str(changes[offset]), changes[offset + 1], changes[offset + 2]
            planned.append(self._plan_scene_change(scene, field, value, extra))
        for apply in planned:
            apply()

    def _plan_scene_change(self, scene, field, value, extra):
        if field == "name":
            name = self._clean_name(value, "Scene name")
            return lambda: setattr(scene, "name", name)
        if field == "color":
            color = self._color(value)
            return lambda: setattr(scene, "color", color)
        if field == "tempo":
            self._require_feature(scene, "tempo_enabled", "Scene tempo")
            if value is None:
                return lambda: setattr(scene, "tempo_enabled", False)
            tempo = self._finite_float(value, "Scene tempo")
            if tempo < 20 or tempo > 999:
                raise BridgeError("INVALID_RANGE", "Scene tempo must be from 20 to 999 BPM")

            def apply_tempo():
                scene.tempo = tempo
                scene.tempo_enabled = True
            return apply_tempo
        if field == "signature":
            self._require_feature(scene, "time_signature_enabled", "Scene time signature")
            if value is None:
                return lambda: setattr(scene, "time_signature_enabled", False)
            numerator = self._bounded_int(value, "Numerator", 1, 99)
            denominator = self._bounded_int(extra, "Denominator", 1, 16)
            if denominator not in (1, 2, 4, 8, 16):
                raise BridgeError("INVALID_ARGUMENTS", "Denominator must be 1, 2, 4, 8, or 16")

            def apply_signature():
                scene.time_signature_numerator = numerator
                scene.time_signature_denominator = denominator
                scene.time_signature_enabled = True
            return apply_signature
        raise BridgeError("INVALID_ARGUMENTS", "Unknown scene field '%s'" % field)

    # ------------------------------------------------------------------ clips

    def _clip_properties(self, args):
        track_index, scene_index, slot = self._clip_slot(args)
        if not slot.has_clip:
            raise BridgeError("CLIP_NOT_FOUND", "No clip at track %d, scene %d" % (track_index, scene_index))
        clip = slot.clip
        kind = self._clip_kind(clip)
        values = [track_index, scene_index, kind]
        pairs = [
            ("name", clip.name), ("color", self._optional_int(clip, "color")),
            ("length", self._optional_number(clip, "length")),
            ("looping", self._optional_bool(clip, "looping")),
            ("loop_start", self._optional_number(clip, "loop_start")), ("loop_end", self._optional_number(clip, "loop_end")),
            ("start_marker", self._optional_number(clip, "start_marker")), ("end_marker", self._optional_number(clip, "end_marker")),
            ("launch_mode", self._optional_int(clip, "launch_mode")),
            ("launch_quantization", self._optional_int(clip, "launch_quantization")),
            ("legato", self._optional_bool(clip, "legato")), ("muted", self._optional_bool(clip, "muted")),
            ("is_playing", self._optional_bool(clip, "is_playing")),
        ]
        if kind == "audio":
            pairs.append(("file_path", self._optional_text(clip, "file_path")))
            gain_display = None
            try:
                gain_display = str(clip.gain_display_string)
            except Exception:
                pass
            pairs.extend([
                ("gain", self._optional_number(clip, "gain")), ("gain_display", gain_display),
                ("pitch_coarse", self._optional_int(clip, "pitch_coarse")), ("pitch_fine", self._optional_number(clip, "pitch_fine")),
                ("warping", self._optional_bool(clip, "warping")), ("warp_mode", self._optional_int(clip, "warp_mode")),
            ])
        for key, value in pairs:
            values.extend([key, value])
        return values

    def _set_clip(self, args):
        # args: track, scene, expectedTrackName, expectedClipName, then (field, value) pairs.
        _track_index, _scene_index, _track, slot = self._named_clip_slot(args)
        clip = slot.clip
        changes = args[4:]
        if not changes or len(changes) % 2 != 0:
            raise BridgeError("INVALID_ARGUMENTS", "Clip changes must be pairs of field and value")
        requested = {}
        for offset in range(0, len(changes), 2):
            field = str(changes[offset])
            if field not in CLIP_FIELDS:
                raise BridgeError("INVALID_ARGUMENTS", "Unknown clip field '%s'" % field)
            if field in requested:
                raise BridgeError("INVALID_ARGUMENTS", "Clip field '%s' was given twice" % field)
            requested[field] = changes[offset + 1]
        kind = self._clip_kind(clip)
        audio_only = [field for field in requested if field in AUDIO_CLIP_FIELDS]
        if audio_only and kind != "audio":
            raise BridgeError("CLIP_NOT_AUDIO", "%s %s only to audio clips; this clip is %s" % (", ".join(audio_only), "applies" if len(audio_only) == 1 else "apply", kind))
        simple = []
        for field, value in requested.items():
            if field in ("loop_start", "loop_end", "start_marker", "end_marker"):
                continue
            simple.append(self._plan_clip_change(clip, field, value))
        loop = self._plan_range(clip, requested, "loop_start", "loop_end", "Loop")
        markers = self._plan_range(clip, requested, "start_marker", "end_marker", "Marker")
        saved = dict((field, getattr(clip, field)) for field in requested if field not in ("loop_start", "loop_end", "start_marker", "end_marker"))
        if "looping" not in saved:
            saved["looping"] = clip.looping
        ranges = [(start, end, float(getattr(clip, start)), float(getattr(clip, end))) for start, end in (("loop_start", "loop_end"), ("start_marker", "end_marker"))]
        try:
            for apply in simple:
                apply()
            # Looping changes what loop_start/loop_end mean, so set it before the range.
            loop()
            markers()
        except Exception:
            # Live refused a value partway through. Put back what this call changed.
            for field in ["looping"] + [field for field in saved if field != "looping"]:
                try:
                    setattr(clip, field, saved[field])
                except Exception:
                    pass
            for start_field, end_field, start, end in ranges:
                try:
                    self._set_range(clip, start_field, end_field, start, end)
                except Exception:
                    pass
            raise

    def _plan_clip_change(self, clip, field, value):
        if field == "name":
            name = self._clean_name(value, "Clip name")
            return lambda: setattr(clip, "name", name)
        if field == "color":
            color = self._color(value)
            return lambda: setattr(clip, "color", color)
        if field in ("looping", "legato", "muted", "warping"):
            flag = self._flag(value, field)
            return lambda: setattr(clip, field, flag)
        if field == "launch_mode":
            number = self._bounded_int(value, "Launch mode", 0, LAUNCH_MODE_MAX)
            return lambda: setattr(clip, field, number)
        if field == "launch_quantization":
            number = self._bounded_int(value, "Launch quantization", 0, LAUNCH_QUANTIZATION_MAX)
            return lambda: setattr(clip, field, number)
        if field == "warp_mode":
            number = self._bounded_int(value, "Warp mode", 0, WARP_MODE_MAX)
            available = getattr(clip, "available_warp_modes", None)
            if available is not None and number not in [int(mode) for mode in available]:
                raise BridgeError("INVALID_ARGUMENTS", "Warp mode %d is not available for this clip" % number)
            return lambda: setattr(clip, field, number)
        if field == "pitch_coarse":
            number = self._bounded_int(value, "Transpose", -48, 48)
            return lambda: setattr(clip, field, number)
        if field == "pitch_fine":
            number = self._finite_float(value, "Detune")
            if number < -50 or number > 49:
                raise BridgeError("INVALID_RANGE", "Detune must be from -50 to 49 cents")
            return lambda: setattr(clip, field, number)
        if field == "gain":
            number = self._finite_float(value, "Gain")
            if number < 0 or number > 1:
                raise BridgeError("INVALID_RANGE", "Gain must be from 0 to 1")
            return lambda: setattr(clip, field, number)
        raise BridgeError("INVALID_ARGUMENTS", "Unknown clip field '%s'" % field)

    def _plan_range(self, clip, requested, start_field, end_field, label):
        if start_field not in requested and end_field not in requested:
            return lambda: None
        start = self._finite_float(requested[start_field], "%s start" % label) if start_field in requested else None
        end = self._finite_float(requested[end_field], "%s end" % label) if end_field in requested else None
        if start is not None and end is not None and end <= start:
            raise BridgeError("INVALID_RANGE", "%s end must be after its start" % label)
        # A single value must still fit the other end as it is now. Turning looping
        # on or off in the same call moves the loop, so leave that case to Live.
        if "looping" not in requested or start_field != "loop_start":
            if start is not None and end is None and start >= float(getattr(clip, end_field)):
                raise BridgeError("INVALID_RANGE", "%s start %s must be before the current end %s" % (label, self._beat_text(start), self._beat_text(float(getattr(clip, end_field)))))
            if end is not None and start is None and end <= float(getattr(clip, start_field)):
                raise BridgeError("INVALID_RANGE", "%s end %s must be after the current start %s" % (label, self._beat_text(end), self._beat_text(float(getattr(clip, start_field)))))
        return lambda: self._set_range(clip, start_field, end_field, start, end)

    def _set_range(self, clip, start_field, end_field, start, end):
        # Live refuses a start at or after the current end, and an end at or
        # before the current start, so order the two writes around that.
        if start is not None and end is not None:
            if start >= float(getattr(clip, end_field)):
                setattr(clip, end_field, end)
                setattr(clip, start_field, start)
            else:
                setattr(clip, start_field, start)
                setattr(clip, end_field, end)
        elif start is not None:
            setattr(clip, start_field, start)
        else:
            setattr(clip, end_field, end)

    def _duplicate_clip(self, args):
        # args: source track, scene, trackName, clipName, target track, target scene, target trackName
        self._require_args(args, 7, "/live/clip_slot/duplicate_to")
        _t, _s, _track, slot = self._named_clip_slot(args)
        target_index = self._non_negative_index(args[4], "Target track index")
        target_scene = self._non_negative_index(args[5], "Target scene index")
        tracks = list(self.song().tracks)
        if target_index >= len(tracks):
            raise BridgeError("INVALID_TRACK", "Target track index %d does not exist" % target_index)
        target_track = tracks[target_index]
        if target_track.name != str(args[6]):
            raise BridgeError("TRACK_IDENTITY_MISMATCH", "Expected target track '%s', found '%s'" % (args[6], target_track.name))
        target_slots = list(target_track.clip_slots)
        if target_scene >= len(target_slots):
            raise BridgeError("INVALID_SCENE", "Target scene index %d does not exist" % target_scene)
        target = target_slots[target_scene]
        if target is slot:
            raise BridgeError("INVALID_ARGUMENTS", "Source and target are the same clip slot")
        if target.has_clip:
            raise BridgeError("SLOT_OCCUPIED", "Target slot already holds clip '%s'; delete it first" % target.clip.name)
        source_kind = self._clip_kind(slot.clip)
        target_midi = bool(getattr(target_track, "has_midi_input", source_kind == "midi"))
        if source_kind == "midi" and not target_midi or source_kind == "audio" and target_midi:
            raise BridgeError("TRACK_TYPE_MISMATCH", "A %s clip cannot go on track '%s'" % (source_kind, target_track.name))
        self._require_feature(slot, "duplicate_clip_to", "ClipSlot.duplicate_clip_to")
        slot.duplicate_clip_to(target)

    def _delete_clip(self, args):
        self._require_args(args, 5, "/live/clip_slot/delete_clip")
        _t, _s, _track, slot = self._named_clip_slot(args)
        self._confirmed(args[4], "delete_clip")
        slot.delete_clip()

    # ------------------------------------------------------------------ undo

    def _undo(self, _args):
        song = self.song()
        if not song.can_undo:
            raise BridgeError("NOTHING_TO_UNDO", "Live has nothing to undo")
        song.undo()

    def _redo(self, _args):
        song = self.song()
        if not song.can_redo:
            raise BridgeError("NOTHING_TO_REDO", "Live has nothing to redo")
        song.redo()

    # ------------------------------------------------------------------ tracks

    def _track_details(self, args):
        kind, index, track = self._any_track(args)
        values = [kind, index, track.name]
        pairs = [
            ("color", self._optional_int(track, "color")),
            ("is_foldable", self._optional_bool(track, "is_foldable")),
            ("folded", bool(getattr(track, "fold_state", 0)) if getattr(track, "is_foldable", False) else None),
            ("is_grouped", self._optional_bool(track, "is_grouped")),
            ("input_routing_type", self._routing_name(track, "input_routing_type")),
            ("input_routing_channel", self._routing_name(track, "input_routing_channel")),
            ("output_routing_type", self._routing_name(track, "output_routing_type")),
            ("output_routing_channel", self._routing_name(track, "output_routing_channel")),
        ]
        for key, value in pairs:
            values.extend([key, value])
        return values

    def _routing_name(self, track, attribute):
        try:
            return str(getattr(track, attribute).display_name)
        except Exception:
            return None

    def _routing_choices(self, track, attribute):
        try:
            return list(getattr(track, attribute))
        except Exception:
            return []

    def _routing_options(self, args):
        kind, index, track = self._any_track(args)
        values = [kind, index, track.name]
        for label in ("input_routing_type", "input_routing_channel", "output_routing_type", "output_routing_channel"):
            names = [str(choice.display_name) for choice in self._routing_choices(track, "available_%ss" % label)]
            values.extend([label, len(names)] + names)
        return values

    def _set_track(self, args):
        # args: kind, index, expectedName, then (field, value) pairs.
        kind, _index, track = self._named_any_track(args)
        changes = args[3:]
        if not changes or len(changes) % 2 != 0:
            raise BridgeError("INVALID_ARGUMENTS", "Track changes must be pairs of field and value")
        requested = {}
        for offset in range(0, len(changes), 2):
            field = str(changes[offset])
            if field not in TRACK_FIELDS:
                raise BridgeError("INVALID_ARGUMENTS", "Unknown track field '%s'" % field)
            if field in requested:
                raise BridgeError("INVALID_ARGUMENTS", "Track field '%s' was given twice" % field)
            requested[field] = changes[offset + 1]
        planned = []
        if "color" in requested:
            color = self._color(requested["color"])
            planned.append(lambda: setattr(track, "color", color))
        if "folded" in requested:
            if not getattr(track, "is_foldable", False):
                raise BridgeError("TRACK_NOT_FOLDABLE", "Track '%s' is not a group track" % track.name)
            folded = self._flag(requested["folded"], "folded")
            planned.append(lambda: setattr(track, "fold_state", 1 if folded else 0))
        if kind == "master" and ("input_routing_type" in requested or "input_routing_channel" in requested):
            raise BridgeError("INVALID_ARGUMENTS", "The master track has no input routing")
        # Resolve every routing name before changing anything. A channel list
        # depends on its type, so a channel whose type also changes is resolved
        # again after the type is set.
        routing = []
        for direction in ("input", "output"):
            type_field, channel_field = "%s_routing_type" % direction, "%s_routing_channel" % direction
            if type_field in requested:
                routing.append((type_field, self._routing_choice(track, type_field, requested[type_field])))
            if channel_field in requested:
                if type_field in requested:
                    routing.append((channel_field, None))
                else:
                    routing.append((channel_field, self._routing_choice(track, channel_field, requested[channel_field])))
        touched = [field for field in ("color", "fold_state", "input_routing_type", "input_routing_channel", "output_routing_type", "output_routing_channel")
                   if field in requested or (field == "fold_state" and "folded" in requested)]
        saved = [(field, getattr(track, field)) for field in touched]
        try:
            for apply in planned:
                apply()
            for field, choice in routing:
                if choice is None:
                    choice = self._routing_choice(track, field, requested[field])
                setattr(track, field, choice)
        except Exception:
            # A channel can only be looked up once its new type is set. If that
            # fails, put back everything this call changed before reporting it.
            for field, value in saved:
                try:
                    setattr(track, field, value)
                except Exception:
                    pass
            raise

    def _routing_choice(self, track, field, value):
        wanted = str(value).strip()
        if not wanted:
            raise BridgeError("INVALID_ARGUMENTS", "%s must not be empty" % field)
        choices = self._routing_choices(track, "available_%ss" % field)
        matches = [choice for choice in choices if str(choice.display_name) == wanted]
        if not matches:
            names = [str(choice.display_name) for choice in choices][:40]
            raise BridgeError("ROUTING_NOT_FOUND", "'%s' is not an available %s for '%s'. Options: %s" % (wanted, field.replace("_", " "), track.name, ", ".join(names)), {"options": names})
        if len(matches) > 1:
            raise BridgeError("ROUTING_AMBIGUOUS", "More than one %s is named '%s'" % (field.replace("_", " "), wanted))
        return matches[0]

    def _duplicate_track(self, args):
        self._require_args(args, 2, "/live/song/duplicate_track")
        track_index, _track = self._named_track(args)
        self.song().duplicate_track(track_index)

    # ------------------------------------------------------------------ session clip notes

    def _session_midi_clip(self, clip, track_index, scene_index):
        kind = self._clip_kind(clip)
        if kind != "midi":
            raise BridgeError("CLIP_NOT_MIDI", "The clip at track %d, scene %d is %s, not MIDI" % (track_index, scene_index, kind))
        return clip

    def _session_clip_notes(self, args):
        # args: track, scene. Reply: track, scene, name, then pitch, start, duration, velocity, mute, id per note.
        self._require_args(args, 2, "/live/session_clip/get/notes")
        track_index, scene_index, slot = self._clip_slot(args)
        if not slot.has_clip:
            raise BridgeError("CLIP_NOT_FOUND", "No clip at track %d, scene %d" % (track_index, scene_index))
        clip = self._session_midi_clip(slot.clip, track_index, scene_index)
        return [track_index, scene_index, clip.name] + self._note_payload(self._clip_notes(clip))

    def _modify_session_notes(self, args):
        # args: track, scene, trackName, clipName, then groups of id, pitch, start, duration, velocity, mute.
        track_index, scene_index, _track, slot = self._named_clip_slot(args)
        clip = self._session_midi_clip(slot.clip, track_index, scene_index)
        self._modify_clip_notes(clip, "the clip at track %d, scene %d" % (track_index, scene_index), args[4:])

    def _remove_session_notes(self, args):
        # args: track, scene, trackName, clipName, fromPitch, pitchSpan, fromTime, timeSpan.
        self._require_args(args, 8, "/live/session_clip/remove/notes")
        track_index, scene_index, _track, slot = self._named_clip_slot(args)
        clip = self._session_midi_clip(slot.clip, track_index, scene_index)
        self._remove_clip_notes(clip, "the clip at track %d, scene %d" % (track_index, scene_index), args[4:8])

    # ------------------------------------------------------------------ return tracks

    def _create_return_track(self, args):
        # args: optional name. Live always appends a return track.
        song = self.song()
        name = self._clean_name(args[0], "Return track name") if args and args[0] not in (None, "") else None
        if len(list(song.return_tracks)) >= 12:
            raise BridgeError("TOO_MANY_RETURNS", "Live allows at most 12 return tracks")
        song.create_return_track()
        if name:
            list(song.return_tracks)[-1].name = name

    def _delete_return_track(self, args):
        # args: index, expectedName, confirm. Every track loses its send to this return.
        self._require_args(args, 3, "/live/song/delete_return_track")
        _kind, index, _track = self._named_any_track(["return", args[0], args[1]])
        self._confirmed(args[2], "delete_return_track")
        self.song().delete_return_track(index)

    # ------------------------------------------------------------------ feature detection

    def _api_features(self):
        # Reports which optional Live API calls this Live version has, as name/bool pairs.
        # Read-only: it only checks for attributes on Live's classes.
        import Live
        checks = [
            ("ClipSlot.create_audio_clip", getattr(Live, "ClipSlot", None), "create_audio_clip"),
            ("Track.create_audio_clip", getattr(Live, "Track", None), "create_audio_clip"),
            ("Track.create_midi_clip", getattr(Live, "Track", None), "create_midi_clip"),
            ("SimplerDevice.replace_sample", getattr(Live, "SimplerDevice", None), "replace_sample"),
            ("Song.begin_undo_step", getattr(Live, "Song", None), "begin_undo_step"),
        ]
        values = []
        for label, module, name in checks:
            cls = getattr(module, label.split(".")[0], None) if module is not None else None
            values.extend([label, bool(cls is not None and hasattr(cls, name))])
        return values

    def _optional_text(self, obj, name):
        try:
            value = getattr(obj, name)
        except Exception:
            return None
        return None if value is None else str(value)

    # ------------------------------------------------------------------ samples

    def _sample_path(self, value):
        # Only an existing audio file, by absolute path. Live reads it; nothing is copied or changed.
        import os
        path = str(value)
        if "\x00" in path or not os.path.isabs(path):
            raise BridgeError("INVALID_SAMPLE", "Sample path must be absolute")
        real = os.path.realpath(path)
        if os.path.splitext(real)[1].lower() not in SAMPLE_EXTENSIONS:
            raise BridgeError("INVALID_SAMPLE", "Sample must be one of: %s" % ", ".join(SAMPLE_EXTENSIONS))
        if not os.path.isfile(real):
            raise BridgeError("SAMPLE_NOT_FOUND", "No file at %s" % path)
        return real

    def _audio_track(self, track, action):
        if getattr(track, "is_foldable", False):
            raise BridgeError("TRACK_NOT_AUDIO", "Track '%s' is a group track; %s needs an audio track" % (track.name, action))
        if bool(getattr(track, "has_midi_input", False)):
            raise BridgeError("TRACK_NOT_AUDIO", "Track '%s' is a MIDI track; %s needs an audio track" % (track.name, action))
        if bool(getattr(track, "is_frozen", False)):
            raise BridgeError("TRACK_FROZEN", "Track '%s' is frozen" % track.name)

    def _require_method(self, obj, name, label):
        if not callable(getattr(obj, name, None)):
            raise BridgeError("LIVE_VERSION_UNSUPPORTED", "%s needs Live 12 or newer; this is Live %s" % (label, self._live_version_text()))

    def _load_sample_to_slot(self, args):
        # args: track, scene, expectedTrackName, path, optional clipName
        self._require_args(args, 4, "/live/clip_slot/load_sample")
        track_index, track = self._named_track([args[0], args[2]])
        self._audio_track(track, "loading a sample into a clip slot")
        scene_index = self._non_negative_index(args[1], "Scene index")
        slots = list(track.clip_slots)
        if scene_index >= len(slots):
            raise BridgeError("INVALID_SCENE", "Scene index %d does not exist" % scene_index)
        slot = slots[scene_index]
        if slot.has_clip:
            raise BridgeError("SLOT_OCCUPIED", "Track %d, scene %d already holds clip '%s'" % (track_index, scene_index, slot.clip.name))
        path = self._sample_path(args[3])
        name = self._clean_name(args[4], "Clip name") if len(args) > 4 and args[4] not in (None, "") else None
        self._require_method(slot, "create_audio_clip", "Loading a sample into a clip slot")
        slot.create_audio_clip(path)
        if name:
            slot.clip.name = name

    def _load_sample_to_arrangement(self, args):
        # args: track, expectedTrackName, path, startBeats
        self._require_args(args, 4, "/live/track/load_sample_to_arrangement")
        _track_index, track = self._named_track(args)
        self._audio_track(track, "loading a sample into the Arrangement")
        path = self._sample_path(args[2])
        start = self._finite_float(args[3], "Start")
        if start < 0 or start > MAX_ARRANGEMENT_BEATS:
            raise BridgeError("INVALID_RANGE", "Start must be from 0 to %s beats" % MAX_ARRANGEMENT_BEATS)
        self._require_method(track, "create_audio_clip", "Loading a sample into the Arrangement")
        track.create_audio_clip(path, start)

    def _simpler(self, args):
        # args: track, expectedTrackName, deviceIndex, expectedDeviceName
        self._require_args(args, 4, "Simpler operation")
        track_index, track = self._named_track(args)
        device_index = self._non_negative_index(args[2], "Device index")
        devices = list(track.devices)
        if device_index >= len(devices):
            raise BridgeError("INVALID_DEVICE", "Device index %d does not exist on track '%s'" % (device_index, track.name))
        device = devices[device_index]
        if device.name != str(args[3]):
            raise BridgeError("DEVICE_IDENTITY_MISMATCH", "Expected device '%s', found '%s'" % (args[3], device.name))
        if str(getattr(device, "class_name", "")) != "OriginalSimpler":
            raise BridgeError("DEVICE_NOT_SIMPLER", "Device '%s' is %s, not Simpler" % (device.name, getattr(device, "class_name", "unknown")))
        return track_index, device_index, device

    def _device_sample(self, args):
        track_index, device_index, device = self._simpler(args)
        sample = getattr(device, "sample", None)
        return [track_index, device_index, device.name, self._optional_text(sample, "file_path") if sample is not None else None]

    def _replace_simpler_sample(self, args):
        # args: track, expectedTrackName, deviceIndex, expectedDeviceName, path
        self._require_args(args, 5, "/live/device/replace_sample")
        _track_index, _device_index, device = self._simpler(args)
        path = self._sample_path(args[4])
        self._require_method(device, "replace_sample", "Replacing a Simpler sample")
        device.replace_sample(path)

    # ------------------------------------------------------------------ device on/off and delete

    def _device_switch(self, device):
        # Every Live device's first parameter is its on/off switch, named "Device On".
        parameters = list(getattr(device, "parameters", []) or [])
        if parameters and str(parameters[0].name) == "Device On":
            return parameters[0]
        return None

    def _devices_state(self, args):
        # args: kind, index. Reply: kind, index, trackName, count, then name, class_name, enabled (None if it has no switch).
        kind, index, track = self._any_track(args)
        devices = list(track.devices)
        values = [kind, index, track.name, len(devices)]
        for device in devices:
            switch = self._device_switch(device)
            values.extend([device.name, str(getattr(device, "class_name", "")), None if switch is None else bool(switch.value >= 0.5)])
        return values

    def _named_device(self, args):
        # args: kind, index, trackName, deviceIndex, deviceName
        self._require_args(args, 5, "device operation")
        kind, index, track = self._named_any_track(args)
        device_index = self._non_negative_index(args[3], "Device index")
        devices = list(track.devices)
        if device_index >= len(devices):
            raise BridgeError("INVALID_DEVICE", "Device index %d does not exist on %s '%s'" % (device_index, self._kind_label(kind), track.name))
        device = devices[device_index]
        if device.name != str(args[4]):
            raise BridgeError("DEVICE_IDENTITY_MISMATCH", "Expected device %d to be '%s', found '%s'" % (device_index, args[4], device.name))
        return kind, track, device_index, device

    def _set_device_enabled(self, args):
        # args: kind, index, trackName, deviceIndex, deviceName, enabled
        self._require_args(args, 6, "/live/device/set_enabled")
        _kind, _track, _device_index, device = self._named_device(args)
        enabled = self._flag(args[5], "enabled")
        switch = self._device_switch(device)
        if switch is None:
            raise BridgeError("DEVICE_NO_SWITCH", "Device '%s' has no on/off switch" % device.name)
        switch.value = switch.max if enabled else switch.min

    def _delete_device(self, args):
        # args: kind, index, trackName, deviceIndex, deviceName, confirm
        self._require_args(args, 6, "/live/device/delete")
        _kind, track, device_index, _device = self._named_device(args)
        self._confirmed(args[5], "delete_device")
        self._require_method(track, "delete_device", "Deleting a device")
        track.delete_device(device_index)

    # ------------------------------------------------------------------ selection

    def _track_location(self, track):
        song = self.song()
        if track == song.master_track:
            return "master", 0
        for kind, tracks in (("track", song.tracks), ("return", song.return_tracks)):
            tracks = list(tracks)
            if track in tracks:
                return kind, tracks.index(track)
        return None, -1

    def _selection(self):
        # Reply: trackKind, trackIndex, trackName, sceneIndex, sceneName, hasClip, clipName.
        # trackKind is None and indexes are -1 when Live shows nothing selected there.
        view = self.song().view
        track = view.selected_track
        kind, index = self._track_location(track) if track is not None else (None, -1)
        scenes = list(self.song().scenes)
        scene = view.selected_scene
        scene_index = scenes.index(scene) if scene in scenes else -1
        has_clip, clip_name = False, None
        if kind == "track" and scene_index >= 0:
            slot = list(track.clip_slots)[scene_index]
            has_clip = bool(slot.has_clip)
            clip_name = slot.clip.name if has_clip else None
        return [kind, index, track.name if track is not None else None, scene_index, scene.name if scene_index >= 0 else None, has_clip, clip_name]

    def _select(self, args):
        # args: kind or None, index, expectedTrackName, sceneIndex (-1 for none), expectedSceneName.
        self._require_args(args, 5, "/live/view/select")
        view = self.song().view
        track = None
        if args[0] is not None:
            _kind, _index, track = self._named_any_track(args[:3])
        scene = None
        if args[3] is not None and args[3] != -1:
            _scene_index, scene = self._named_scene([args[3], args[4]])
        if track is None and scene is None:
            raise BridgeError("INVALID_ARGUMENTS", "Select a track, a scene, or both")
        if track is not None:
            view.selected_track = track
        if scene is not None:
            view.selected_scene = scene
