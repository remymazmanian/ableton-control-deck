"""Clip automation: envelopes inside a Session clip.

A parameter is named by a JSON object in one argument:
  {"kind": "mixer", "field": "volume" | "panning" | "send", "sendIndex": 0}
  {"kind": "device", "path": "0/2/1", "parameterIndex": 3, "name": "Cutoff"}
It must belong to the clip's own track. Live has no API to list an envelope's
breakpoints, so reads sample Envelope.value_at_time across the clip.
"""

import json

from .bridge_core import BridgeError

AUTOMATION_QUERIES = (
    "/live/clip_automation/get",
    "/live/clip_automation/list",
)
AUTOMATION_COMMANDS = (
    "/live/clip_automation/write",
    "/live/clip_automation/clear",
)
MAX_SAMPLES = 512
MAX_STEPS_PER_COMMAND = 512
BOUNDARY_NUDGE = 0.001


class AutomationOps(object):
    def _automation_query(self, address, args):
        if address == "/live/clip_automation/get":
            return [json.dumps(self._read_automation(args), separators=(",", ":"))]
        return [json.dumps(self._list_automation(args), separators=(",", ":"))]

    def _automation_command(self, address, args):
        if address == "/live/clip_automation/write":
            self._write_automation(args)
        else:
            self._clear_automation(args)

    # ------------------------------------------------------------------ targets

    def _automation_clip(self, args, named):
        # named: args are track, scene, trackName, clipName; otherwise track, scene.
        if named:
            track_index, scene_index, track, slot = self._named_clip_slot(args)
        else:
            self._require_args(args, 2, "clip automation")
            track_index, scene_index, slot = self._clip_slot(args)
            if not slot.has_clip:
                raise BridgeError("CLIP_NOT_FOUND", "No clip at track %d, scene %d" % (track_index, scene_index))
            track = list(self.song().tracks)[track_index]
        return track, slot.clip

    def _automation_parameter(self, track, spec_text):
        try:
            spec = json.loads(str(spec_text))
        except ValueError:
            raise BridgeError("INVALID_PARAMETER", "The parameter must be a JSON object")
        kind = spec.get("kind")
        if kind == "mixer":
            mixer = track.mixer_device
            field = spec.get("field")
            if field == "volume":
                return mixer.volume, "Volume"
            if field == "panning":
                return mixer.panning, "Pan"
            if field == "send":
                sends = list(mixer.sends)
                index = self._non_negative_index(spec.get("sendIndex", -1), "Send index")
                if index >= len(sends):
                    raise BridgeError("INVALID_SEND", "Send %d does not exist; this set has %d return track(s)" % (index, len(sends)))
                return sends[index], "Send %s" % chr(ord("A") + index)
            raise BridgeError("INVALID_PARAMETER", "Mixer field must be volume, panning, or send")
        if kind == "device":
            device = self._device_at_path(track, spec.get("path", ""))
            parameters = list(device.parameters)
            index = self._non_negative_index(spec.get("parameterIndex", -1), "Parameter index")
            if index >= len(parameters):
                raise BridgeError("INVALID_PARAMETER", "Device '%s' has no parameter %d" % (device.name, index))
            parameter = parameters[index]
            if str(parameter.name) != str(spec.get("name", "")):
                raise BridgeError("PARAMETER_IDENTITY_MISMATCH", "Expected parameter %d of '%s' to be '%s', found '%s'" % (index, device.name, spec.get("name", ""), parameter.name))
            return parameter, "'%s' on '%s'" % (parameter.name, device.name)
        raise BridgeError("INVALID_PARAMETER", "Parameter kind must be mixer or device")

    def _clip_span(self, clip):
        # Times are beats from the clip start; the envelope covers the clip's length.
        return float(getattr(clip, "length", 0.0) or 0.0)

    # ------------------------------------------------------------------ reads

    def _read_automation(self, args):
        # args: track, scene, parameterJson, then a sample count or a JSON list of exact times.
        self._require_args(args, 4, "/live/clip_automation/get")
        track, clip = self._automation_clip(args[:2], named=False)
        parameter, label = self._automation_parameter(track, args[2])
        span = self._clip_span(clip)
        if isinstance(args[3], str):
            try:
                times = [float(value) for value in json.loads(args[3])]
            except (ValueError, TypeError):
                raise BridgeError("INVALID_ARGUMENTS", "Sample times must be a JSON list of beats")
            if len(times) > MAX_SAMPLES:
                raise BridgeError("INVALID_ARGUMENTS", "At most %d sample times" % MAX_SAMPLES)
        else:
            count = self._bounded_int(args[3], "Sample count", 2, MAX_SAMPLES)
            times = [span * step / (count - 1) for step in range(count)]
        envelope = clip.automation_envelope(parameter)
        state = {"parameter": label, "min": float(parameter.min), "max": float(parameter.max), "lengthBeats": span, "hasEnvelope": envelope is not None, "samples": []}
        if envelope is not None:
            for time in times:
                # value_at_time returns the earlier step's value at an exact step boundary (measured in
                # Live 12.4.16), so read a hair inside: just after each time, or just before the clip end.
                at = min(max(time + BOUNDARY_NUDGE, 0.0), max(span - BOUNDARY_NUDGE, 0.0))
                value = float(envelope.value_at_time(at))
                try:
                    display = str(parameter.str_for_value(value))
                except Exception:
                    display = None
                state["samples"].append({"time": time, "value": value, "display": display})
        return state

    def _list_automation(self, args):
        # args: track, scene. Lists every mixer and device parameter on the track with an envelope in this clip.
        track, clip = self._automation_clip(args[:2], named=False)
        found = []

        def check(parameter, ref):
            try:
                if clip.automation_envelope(parameter) is not None:
                    found.append(dict(ref, name=str(parameter.name)))
            except Exception:
                pass

        mixer = track.mixer_device
        check(mixer.volume, {"kind": "mixer", "field": "volume"})
        check(mixer.panning, {"kind": "mixer", "field": "panning"})
        for index, send in enumerate(list(mixer.sends)):
            check(send, {"kind": "mixer", "field": "send", "sendIndex": index})

        def walk(devices, prefix, depth):
            for device_index, device in enumerate(devices):
                path = "%s%d" % (prefix, device_index)
                for parameter_index, parameter in enumerate(list(device.parameters)):
                    check(parameter, {"kind": "device", "path": path, "parameterIndex": parameter_index, "device": device.name})
                if depth < 7 and getattr(device, "can_have_chains", False):
                    for chain_index, chain in enumerate(list(device.chains)):
                        walk(list(chain.devices), "%s/%d/" % (path, chain_index), depth + 1)

        walk(list(track.devices), "", 0)
        return {"lengthBeats": self._clip_span(clip), "automated": found}

    # ------------------------------------------------------------------ writes

    def _write_automation(self, args):
        # args: track, scene, trackName, clipName, parameterJson, clearFirst,
        #       then groups of (time, duration, value, isDb).
        self._require_args(args, 10, "/live/clip_automation/write")
        track, clip = self._automation_clip(args[:4], named=True)
        parameter, label = self._automation_parameter(track, args[4])
        clear_first = self._flag(args[5], "clearFirst")
        groups = args[6:]
        if not groups or len(groups) % 4 != 0:
            raise BridgeError("INVALID_ARGUMENTS", "Automation steps must be groups of time, duration, value, and isDb")
        if len(groups) // 4 > MAX_STEPS_PER_COMMAND:
            raise BridgeError("INVALID_ARGUMENTS", "At most %d steps can be written at once" % MAX_STEPS_PER_COMMAND)
        span = self._clip_span(clip)
        steps = []
        for offset in range(0, len(groups), 4):
            time = self._finite_float(groups[offset], "Step time")
            duration = self._finite_float(groups[offset + 1], "Step length")
            if time < 0 or duration <= 0 or time + duration > span + 1e-6:
                raise BridgeError("INVALID_RANGE", "Each step must lie inside the clip, 0 to %s beats" % self._beat_text(span))
            if groups[offset + 3] is True:
                value = self._value_for_db(parameter, groups[offset + 2], label)
            else:
                value = self._finite_float(groups[offset + 2], "%s value" % label)
                if value < float(parameter.min) - 1e-6 or value > float(parameter.max) + 1e-6:
                    raise BridgeError("INVALID_RANGE", "%s must be from %s to %s" % (label, self._beat_text(float(parameter.min)), self._beat_text(float(parameter.max))))
            steps.append((time, duration, value))
        if clear_first:
            clip.clear_envelope(parameter)
        envelope = clip.automation_envelope(parameter)
        if envelope is None:
            envelope = clip.create_automation_envelope(parameter)
        if envelope is None:
            raise BridgeError("AUTOMATION_UNAVAILABLE", "Live would not create an envelope for %s in this clip" % label)
        for time, duration, value in steps:
            envelope.insert_step(time, duration, value)

    def _clear_automation(self, args):
        # args: track, scene, trackName, clipName, parameterJson or "all", confirm
        self._require_args(args, 6, "/live/clip_automation/clear")
        track, clip = self._automation_clip(args[:4], named=True)
        if str(args[4]) == "all":
            self._confirmed(args[5], "Clearing all of a clip's automation")
            clip.clear_all_envelopes()
            return
        parameter, _label = self._automation_parameter(track, args[4])
        clip.clear_envelope(parameter)
