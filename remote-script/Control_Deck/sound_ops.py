"""Sound design: device settings Live keeps outside the parameter list (Wavetable's oscillators,
unison, voicing and filter routing, Simpler's modes), Wavetable's modulation matrix, and capturing a
track's audio to a file so an agent can measure what it made.
"""

import json

from .bridge_core import BridgeError

SOUND_QUERIES = ("/live/device/get/properties", "/live/device/get/modulation", "/live/capture/state")
SOUND_COMMANDS = ("/live/device/set_property", "/live/device/set_modulation", "/live/capture/start", "/live/capture/finish")

CAPTURE_TRACK_NAME = "Control Deck Capture"
CAPTURE_TAPS = {"pre_fx": "Pre FX", "post_fx": "Post FX", "post_mixer": "Post Mixer"}
MONITOR_OFF = 2
MAX_CAPTURE_BEATS = 256.0
MAX_MODULATION_SOURCES = 32

# Wavetable's own option lists, in Live's order.
UNISON_MODES = ("None", "Classic", "Shimmer", "Noise", "Phase Sync", "Position Spread", "Random Note")
EFFECT_MODES = ("None", "FM", "Classic", "Modern")
FILTER_ROUTINGS = ("Serial", "Parallel", "Split")
MONO_POLY = ("Mono", "Poly")

# For each device class: settable properties, with their option labels (None means a plain number).
# Lists that name the options (the wavetables of a category) are read-only and reported alongside.
DEVICE_PROPERTIES = {
    "InstrumentVector": {
        "oscillator_1_wavetable_category": None,
        "oscillator_1_wavetable_index": None,
        "oscillator_2_wavetable_category": None,
        "oscillator_2_wavetable_index": None,
        "oscillator_1_effect_mode": EFFECT_MODES,
        "oscillator_2_effect_mode": EFFECT_MODES,
        "unison_mode": UNISON_MODES,
        "unison_voice_count": None,
        "mono_poly": MONO_POLY,
        "poly_voices": None,
        "filter_routing": FILTER_ROUTINGS,
    },
    "OriginalSimpler": {
        "playback_mode": ("Classic", "One-Shot", "Slicing"),
        "voices": None,
        "retrigger": None,
        "slicing_playback_mode": ("Mono", "Poly", "Thru"),
        "sample.start_marker": None,
        "sample.end_marker": None,
        "sample.warping": None,
        "sample.warp_mode": ("Beats", "Tones", "Texture", "Re-Pitch", "Complex", "REX", "Complex Pro"),
        "sample.gain": None,
    },
}
DEVICE_LISTS = {
    "InstrumentVector": ("oscillator_wavetable_categories", "oscillator_1_wavetables", "oscillator_2_wavetables"),
}


class SoundOps(object):
    def _sound_query(self, address, args):
        if address == "/live/device/get/properties":
            return [json.dumps(self._device_properties(args), separators=(",", ":"))]
        if address == "/live/device/get/modulation":
            return [json.dumps(self._modulation_state(args), separators=(",", ":"))]
        return [json.dumps(self._capture_state(), separators=(",", ":"))]

    def _sound_command(self, address, args):
        if address == "/live/device/set_property":
            self._set_device_property(args)
        elif address == "/live/device/set_modulation":
            self._set_modulation(args)
        elif address == "/live/capture/start":
            self._start_capture(args)
        else:
            self._finish_capture(args)

    # ------------------------------------------------------------------ device properties

    def _resolve_property(self, device, name):
        owner = device
        attribute = name
        if name.startswith("sample."):
            owner = getattr(device, "sample", None)
            attribute = name[len("sample."):]
            if owner is None:
                raise BridgeError("NO_SAMPLE", "'%s' has no sample loaded" % device.name)
        return owner, attribute

    def _property_table(self, device):
        table = DEVICE_PROPERTIES.get(str(getattr(device, "class_name", "")))
        if table is None:
            raise BridgeError("NO_DEVICE_PROPERTIES", "'%s' (%s) has no settings outside its parameters; use its parameters instead" % (device.name, getattr(device, "class_name", "")))
        return table

    def _device_properties(self, args):
        # args: kind, index, trackName, deviceIndex, deviceName
        self._require_args(args, 5, "/live/device/get/properties")
        _kind, _track, _index, device = self._named_device(args)
        table = self._property_table(device)
        properties = {}
        for name, labels in table.items():
            try:
                owner, attribute = self._resolve_property(device, name)
                value = getattr(owner, attribute)
            except Exception:
                continue
            value = self._json_value(value) if not isinstance(value, float) else float(value)
            entry = {"value": value}
            if labels is not None:
                entry["options"] = list(labels)
                if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < len(labels):
                    entry["label"] = labels[value]
            properties[name] = entry
        lists = {}
        for name in DEVICE_LISTS.get(str(device.class_name), ()):
            try:
                lists[name] = [str(item) for item in list(getattr(device, name))]
            except Exception:
                pass
        return {"device": device.name, "className": str(device.class_name), "properties": properties, "lists": lists}

    def _set_device_property(self, args):
        # args: kind, index, trackName, deviceIndex, deviceName, property, value
        self._require_args(args, 7, "/live/device/set_property")
        _kind, _track, _index, device = self._named_device(args)
        table = self._property_table(device)
        name = str(args[5])
        if name not in table:
            raise BridgeError("UNKNOWN_PROPERTY", "'%s' has no setting '%s'. Settings: %s" % (device.name, name, ", ".join(sorted(table))))
        owner, attribute = self._resolve_property(device, name)
        current = getattr(owner, attribute)
        value = args[6]
        if isinstance(current, bool):
            value = self._flag(value, name)
        elif isinstance(current, int):
            if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
                raise BridgeError("INVALID_ARGUMENTS", "%s must be a whole number" % name)
            value = int(value)
            labels = table[name]
            if labels is not None and not 0 <= value < len(labels):
                raise BridgeError("INVALID_ARGUMENTS", "%s must be 0 to %d (%s)" % (name, len(labels) - 1, ", ".join(labels)))
            limit = self._index_limit(device, name)
            if limit is not None and not 0 <= value < limit:
                raise BridgeError("INVALID_ARGUMENTS", "%s must be 0 to %d" % (name, limit - 1))
        else:
            value = self._finite_float(value, name)
        try:
            setattr(owner, attribute, value)
        except Exception as error:
            raise BridgeError("PROPERTY_REFUSED", "Live refused %s = %s on '%s': %s" % (name, value, device.name, error))

    def _index_limit(self, device, name):
        # A wavetable category or table index must point into the list Live gives for it.
        if name.endswith("_wavetable_category"):
            return len(list(getattr(device, "oscillator_wavetable_categories", []) or [])) or None
        if name.endswith("_wavetable_index"):
            oscillator = name.split("_")[1]
            return len(list(getattr(device, "oscillator_%s_wavetables" % oscillator, []) or [])) or None
        return None

    # ------------------------------------------------------------------ modulation matrix

    def _modulation_device(self, args, address):
        self._require_args(args, 5, address)
        _kind, _track, _index, device = self._named_device(args)
        if not callable(getattr(device, "get_modulation_value", None)):
            raise BridgeError("NO_MODULATION_MATRIX", "'%s' has no modulation matrix Live lets scripts reach (Wavetable does)" % device.name)
        return device

    def _modulation_targets(self, device):
        return [str(name) for name in list(getattr(device, "visible_modulation_target_names", []) or [])]

    def _source_count(self, device, targets):
        if not targets:
            return 0
        count = 0
        for source in range(MAX_MODULATION_SOURCES):
            try:
                device.get_modulation_value(0, source)
            except Exception:
                break
            count = source + 1
        return count

    def _modulation_state(self, args):
        # args: kind, index, trackName, deviceIndex, deviceName
        device = self._modulation_device(args, "/live/device/get/modulation")
        targets = self._modulation_targets(device)
        sources = self._source_count(device, targets)
        rows = []
        for target_index, name in enumerate(targets):
            values = []
            for source in range(sources):
                try:
                    values.append(round(float(device.get_modulation_value(target_index, source)), 4))
                except Exception:
                    values.append(None)
            rows.append({"target": name, "amounts": values})
        modulatable = []
        for parameter in list(getattr(device, "parameters", []) or []):
            try:
                if device.is_parameter_modulatable(parameter) and str(parameter.name) not in targets:
                    modulatable.append(str(parameter.name))
            except Exception:
                pass
        return {"device": device.name, "sourceCount": sources, "targets": rows, "addableTargets": modulatable}

    def _set_modulation(self, args):
        # args: kind, index, trackName, deviceIndex, deviceName, targetName, sourceIndex, amount
        self._require_args(args, 8, "/live/device/set_modulation")
        device = self._modulation_device(args, "/live/device/set_modulation")
        target_name = str(args[5])
        source = self._non_negative_index(args[6], "Source index")
        amount = self._finite_float(args[7], "amount")
        if not -1.0 <= amount <= 1.0:
            raise BridgeError("INVALID_ARGUMENTS", "amount must be from -1 to 1")
        targets = self._modulation_targets(device)
        if target_name not in targets:
            matches = [parameter for parameter in list(device.parameters) if str(parameter.name) == target_name]
            if not matches:
                raise BridgeError("UNKNOWN_TARGET", "'%s' has no modulation target or parameter named '%s'" % (device.name, target_name))
            if not device.is_parameter_modulatable(matches[0]):
                raise BridgeError("NOT_MODULATABLE", "'%s' cannot be modulated in '%s'" % (target_name, device.name))
            device.add_parameter_to_modulation_matrix(matches[0])
            targets = self._modulation_targets(device)
            if target_name not in targets:
                raise BridgeError("TARGET_NOT_ADDED", "Live did not add '%s' to the modulation matrix" % target_name)
        sources = self._source_count(device, targets)
        if source >= sources:
            raise BridgeError("INVALID_ARGUMENTS", "Source index must be 0 to %d" % (sources - 1))
        device.set_modulation_value(targets.index(target_name), source, amount)

    # ------------------------------------------------------------------ audio capture

    def _capture_track(self):
        tracks = list(self.song().tracks)
        for index in range(len(tracks) - 1, -1, -1):
            if tracks[index].name == CAPTURE_TRACK_NAME:
                return index, tracks[index]
        return None, None

    def _capture_state(self):
        song = self.song()
        index, track = self._capture_track()
        state = {"exists": track is not None, "tempo": float(song.tempo), "playing": bool(song.is_playing)}
        if track is None:
            return state
        slot = list(track.clip_slots)[0]
        clip = slot.clip if slot.has_clip else None
        state.update({
            "trackIndex": index,
            "triggered": bool(getattr(slot, "is_triggered", False)),
            "recording": bool(getattr(slot, "is_recording", False)) or bool(clip is not None and getattr(clip, "is_recording", False)),
            "hasClip": clip is not None,
            "filePath": None if clip is None else str(getattr(clip, "file_path", "") or "") or None,
            "lengthBeats": None if clip is None else float(getattr(clip, "length", 0.0)),
        })
        return state

    def _route_input(self, capture, source_kind, source):
        # Live lists each track (and the main output, as Resampling) as an input for an audio track.
        wanted = "Resampling" if source_kind == "master" else source.name
        options = [option for option in list(capture.available_input_routing_types) if str(option.display_name) == wanted]
        if not options:
            raise BridgeError("CANNOT_ROUTE", "Live does not offer '%s' as an input for a new audio track" % wanted)
        if len(options) > 1:
            raise BridgeError("CANNOT_ROUTE", "More than one input is named '%s'; rename the track so it is unique" % wanted)
        capture.input_routing_type = options[0]

    def _route_tap(self, capture, tap, source_kind):
        if source_kind == "master":
            return
        wanted = CAPTURE_TAPS[tap]
        for channel in list(capture.available_input_routing_channels):
            if str(channel.display_name) == wanted:
                capture.input_routing_channel = channel
                return
        raise BridgeError("CANNOT_ROUTE", "Live does not offer the %s tap for this track" % wanted)

    def _start_capture(self, args):
        # args: kind, index, trackName, beats, tap, sourceScene (-1 for none), sourceClipName
        self._require_args(args, 7, "/live/capture/start")
        source_kind, _source_index, source = self._named_any_track(args)
        beats = self._finite_float(args[3], "beats")
        if not 0.25 <= beats <= MAX_CAPTURE_BEATS:
            raise BridgeError("INVALID_ARGUMENTS", "Capture length must be 0.25 to %d beats" % MAX_CAPTURE_BEATS)
        tap = str(args[4])
        if tap not in CAPTURE_TAPS:
            raise BridgeError("INVALID_ARGUMENTS", "tap must be one of %s" % ", ".join(CAPTURE_TAPS))
        song = self.song()
        if self._capture_track()[1] is not None:
            raise BridgeError("CAPTURE_IN_PROGRESS", "A '%s' track already exists. Finish or delete it first." % CAPTURE_TRACK_NAME)
        if not list(song.scenes):
            raise BridgeError("NO_SCENES", "The set has no scenes to record into")
        source_slot = None
        scene = int(args[5]) if not isinstance(args[5], bool) else -1
        if scene >= 0:
            if source_kind != "track":
                raise BridgeError("INVALID_ARGUMENTS", "Only a regular track has clips to launch")
            slots = list(source.clip_slots)
            if scene >= len(slots) or not slots[scene].has_clip:
                raise BridgeError("CLIP_NOT_FOUND", "'%s' has no clip in scene %d" % (source.name, scene))
            if str(slots[scene].clip.name) != str(args[6]):
                raise BridgeError("CLIP_IDENTITY_MISMATCH", "Expected clip '%s', found '%s'" % (args[6], slots[scene].clip.name))
            source_slot = slots[scene]
        song.create_audio_track(-1)
        capture = list(song.tracks)[-1]
        try:
            capture.name = CAPTURE_TRACK_NAME
            self._route_input(capture, source_kind, source)
            self._route_tap(capture, tap, source_kind)
            capture.current_monitoring_state = MONITOR_OFF
            capture.arm = True
            self._capture_was_playing = bool(song.is_playing)
            self._capture_source_slot = source_slot
            if source_slot is not None:
                source_slot.fire()
            list(capture.clip_slots)[0].fire(record_length=beats)
        except Exception:
            song.delete_track(len(list(song.tracks)) - 1)
            raise

    def _finish_capture(self, args):
        # args: stopTransport. Stops a capture still running, the clip it launched, and removes the track.
        self._require_args(args, 1, "/live/capture/finish")
        song = self.song()
        index, track = self._capture_track()
        if track is None:
            raise BridgeError("NO_CAPTURE", "No '%s' track exists" % CAPTURE_TRACK_NAME)
        slot = list(track.clip_slots)[0]
        if getattr(slot, "is_recording", False) or getattr(slot, "is_triggered", False):
            slot.stop()
        source_slot = getattr(self, "_capture_source_slot", None)
        if source_slot is not None:
            try:
                source_slot.stop()
            except Exception:
                pass
        track.arm = False
        song.delete_track(index)
        if self._flag(args[0], "stopTransport") and not getattr(self, "_capture_was_playing", True):
            song.stop_playing()
        self._capture_source_slot = None
