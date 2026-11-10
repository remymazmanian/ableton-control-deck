"""Racks, drum pads, macros, variations, and devices inside racks.

A device is addressed by a path string: "0" is the first device on the track,
"0/2/1" is device 1 in chain 2 of the rack at device 0. Every write checks the
track, rack or device, and chain or pad by index and current name first.
"""

import json

from .bridge_core import BridgeError

RACK_QUERIES = (
    "/live/rack/get",
    "/live/device_path/get/parameters",
)
RACK_COMMANDS = (
    "/live/rack/set_macros",
    "/live/rack/set_chain",
    "/live/rack/set_drum_pad",
    "/live/rack/variation",
    "/live/device_path/set_parameter",
)
MAX_PATH_DEPTH = 8
VARIATION_ACTIONS = ("store", "recall", "delete", "randomize")


class RackOps(object):
    # ------------------------------------------------------------------ dispatch

    def _rack_query(self, address, args):
        if address == "/live/rack/get":
            return [json.dumps(self._rack_state(args), separators=(",", ":"))]
        if address == "/live/device_path/get/parameters":
            return [json.dumps(self._path_parameters(args), separators=(",", ":"))]
        raise BridgeError("ADDRESS_NOT_ALLOWED", "Unsupported Live query: %s" % address)

    def _rack_command(self, address, args):
        handlers = {
            "/live/rack/set_macros": self._set_macros,
            "/live/rack/set_chain": self._set_chain,
            "/live/rack/set_drum_pad": self._set_drum_pad,
            "/live/rack/variation": self._rack_variation,
            "/live/device_path/set_parameter": self._set_path_parameter,
        }
        handlers[address](args)

    # ------------------------------------------------------------------ paths

    def _parse_path(self, value):
        text = str(value).strip()
        parts = text.split("/") if text else []
        if not parts or len(parts) % 2 == 0 or len(parts) > MAX_PATH_DEPTH * 2 - 1:
            raise BridgeError("INVALID_PATH", "Device path '%s' must be a device index, or device/chain/device ... such as 0/2/1" % text)
        numbers = []
        for part in parts:
            if not part.isdigit():
                raise BridgeError("INVALID_PATH", "Device path '%s' must contain only whole numbers separated by /" % text)
            numbers.append(int(part))
        return numbers

    def _device_at_path(self, track, path_text):
        path = self._parse_path(path_text)
        devices = list(track.devices)
        device = None
        walked = []
        for step, number in enumerate(path):
            if step % 2 == 0:
                if number >= len(devices):
                    raise BridgeError("INVALID_DEVICE", "No device %d at path '%s' on '%s'" % (number, "/".join(walked) or "top level", track.name))
                device = devices[number]
            else:
                if not getattr(device, "can_have_chains", False):
                    raise BridgeError("NOT_A_RACK", "Device '%s' at path '%s' is not a rack" % (device.name, "/".join(walked)))
                chains = list(device.chains)
                if number >= len(chains):
                    raise BridgeError("INVALID_CHAIN", "Rack '%s' has no chain %d" % (device.name, number))
                devices = list(chains[number].devices)
            walked.append(str(number))
        return device

    def _named_path_device(self, args):
        # args: kind, index, trackName, path, deviceName
        self._require_args(args, 5, "device path operation")
        _kind, _index, track = self._named_any_track(args[:3])
        device = self._device_at_path(track, args[3])
        if device.name != str(args[4]):
            raise BridgeError("DEVICE_IDENTITY_MISMATCH", "Expected the device at path '%s' to be '%s', found '%s'" % (args[3], args[4], device.name))
        return track, device

    def _named_rack(self, args):
        track, rack = self._named_path_device(args)
        if not getattr(rack, "can_have_chains", False):
            raise BridgeError("NOT_A_RACK", "Device '%s' is not a rack" % rack.name)
        return track, rack

    # ------------------------------------------------------------------ reads

    def _parameter_state(self, index, parameter):
        try:
            display = str(parameter.str_for_value(parameter.value))
        except Exception:
            display = None
        return {
            "index": index, "name": str(parameter.name), "value": float(parameter.value),
            "min": float(parameter.min), "max": float(parameter.max), "display": display,
            "quantized": bool(getattr(parameter, "is_quantized", False)),
        }

    def _macros(self, rack):
        parameters = list(rack.parameters)
        count = int(getattr(rack, "visible_macro_count", 8) or 8)
        # Parameter 0 is Device On; the macros follow it.
        return count, [self._parameter_state(index, parameters[index]) for index in range(1, min(len(parameters), 17))][:count]

    def _device_summary(self, device, path):
        switch = self._device_switch(device)
        return {
            "path": path, "name": device.name, "className": str(getattr(device, "class_name", "")),
            "enabled": None if switch is None else bool(switch.value >= 0.5),
            "isRack": bool(getattr(device, "can_have_chains", False)),
        }

    def _rack_state(self, args):
        # args: kind, index, path
        self._require_args(args, 3, "/live/rack/get")
        _kind, _index, track = self._any_track(args[:2])
        rack = self._device_at_path(track, args[2])
        if not getattr(rack, "can_have_chains", False):
            raise BridgeError("NOT_A_RACK", "Device '%s' at path '%s' is not a rack" % (rack.name, args[2]))
        path = str(args[2]).strip()
        visible, macros = self._macros(rack)
        chains = []
        for chain_index, chain in enumerate(list(rack.chains)):
            chains.append({
                "index": chain_index, "name": chain.name, "mute": bool(chain.mute), "solo": bool(chain.solo),
                "devices": [self._device_summary(device, "%s/%d/%d" % (path, chain_index, device_index)) for device_index, device in enumerate(list(chain.devices))],
            })
        state = {
            "path": path, "name": rack.name, "className": str(getattr(rack, "class_name", "")),
            "isDrumRack": bool(getattr(rack, "can_have_drum_pads", False)),
            "visibleMacroCount": visible, "macros": macros, "chains": chains,
            "variations": None,
        }
        if hasattr(rack, "variation_count"):
            state["variations"] = {"count": int(rack.variation_count), "selected": int(getattr(rack, "selected_variation_index", -1))}
        if state["isDrumRack"]:
            pads = []
            for pad in list(rack.drum_pads):
                if len(list(pad.chains)):
                    pads.append({"note": int(pad.note), "name": pad.name, "mute": bool(pad.mute), "solo": bool(pad.solo), "chainCount": len(list(pad.chains))})
            state["drumPads"] = pads
        return state

    def _path_parameters(self, args):
        # args: kind, index, path
        self._require_args(args, 3, "/live/device_path/get/parameters")
        _kind, _index, track = self._any_track(args[:2])
        device = self._device_at_path(track, args[2])
        return {"path": str(args[2]).strip(), "name": device.name, "className": str(getattr(device, "class_name", "")),
                "parameters": [self._parameter_state(index, parameter) for index, parameter in enumerate(list(device.parameters))]}

    # ------------------------------------------------------------------ writes

    def _parameter_value(self, parameter, value, label):
        number = self._finite_float(value, label)
        if number < float(parameter.min) - 1e-6 or number > float(parameter.max) + 1e-6:
            raise BridgeError("INVALID_RANGE", "%s must be from %s to %s" % (label, self._beat_text(float(parameter.min)), self._beat_text(float(parameter.max))))
        if not getattr(parameter, "is_enabled", True):
            # Live disables a parameter that a rack macro (or a Max device) controls.
            raise BridgeError("PARAMETER_DISABLED", "%s is controlled by a macro in Live right now, so it cannot be set directly. Change that macro with set_rack_macros instead." % label)
        return number

    def _set_macros(self, args):
        # args: kind, index, trackName, path, rackName, then pairs of macro number (1-16) and value.
        _track, rack = self._named_rack(args)
        pairs = args[5:]
        if not pairs or len(pairs) % 2 != 0:
            raise BridgeError("INVALID_ARGUMENTS", "Macro changes must be pairs of macro number and value")
        parameters = list(rack.parameters)
        planned = []
        seen = set()
        for offset in range(0, len(pairs), 2):
            number = self._bounded_int(pairs[offset], "Macro number", 1, 16)
            if number in seen:
                raise BridgeError("INVALID_ARGUMENTS", "Macro %d was given twice" % number)
            seen.add(number)
            if number >= len(parameters):
                raise BridgeError("INVALID_ARGUMENTS", "Rack '%s' has no macro %d" % (rack.name, number))
            parameter = parameters[number]
            planned.append((parameter, self._parameter_value(parameter, pairs[offset + 1], "Macro %d (%s)" % (number, parameter.name))))
        for parameter, value in planned:
            parameter.value = value

    def _set_chain(self, args):
        # args: kind, index, trackName, path, rackName, chainIndex, chainName, then (field, value) pairs: name, mute, solo.
        self._require_args(args, 9, "/live/rack/set_chain")
        _track, rack = self._named_rack(args)
        chain_index = self._non_negative_index(args[5], "Chain index")
        chains = list(rack.chains)
        if chain_index >= len(chains):
            raise BridgeError("INVALID_CHAIN", "Rack '%s' has no chain %d" % (rack.name, chain_index))
        chain = chains[chain_index]
        if chain.name != str(args[6]):
            raise BridgeError("CHAIN_IDENTITY_MISMATCH", "Expected chain %d to be '%s', found '%s'" % (chain_index, args[6], chain.name))
        planned = []
        pairs = args[7:]
        if len(pairs) % 2 != 0:
            raise BridgeError("INVALID_ARGUMENTS", "Chain changes must be pairs of field and value")
        for offset in range(0, len(pairs), 2):
            field, value = str(pairs[offset]), pairs[offset + 1]
            if field == "name":
                planned.append(("name", self._clean_name(value, "Chain name")))
            elif field in ("mute", "solo"):
                planned.append((field, self._flag(value, field)))
            else:
                raise BridgeError("INVALID_ARGUMENTS", "Unknown chain field '%s'" % field)
        for field, value in planned:
            setattr(chain, field, value)

    def _set_drum_pad(self, args):
        # args: kind, index, trackName, path, rackName, note, padName, then (field, value) pairs: mute, solo.
        self._require_args(args, 9, "/live/rack/set_drum_pad")
        _track, rack = self._named_rack(args)
        if not getattr(rack, "can_have_drum_pads", False):
            raise BridgeError("NOT_A_DRUM_RACK", "Rack '%s' is not a Drum Rack" % rack.name)
        note = self._bounded_int(args[5], "Pad note", 0, 127)
        pad = next((pad for pad in list(rack.drum_pads) if int(pad.note) == note), None)
        if pad is None:
            raise BridgeError("INVALID_PAD", "Drum Rack '%s' has no pad for note %d" % (rack.name, note))
        if pad.name != str(args[6]):
            raise BridgeError("PAD_IDENTITY_MISMATCH", "Expected pad %d to be '%s', found '%s'" % (note, args[6], pad.name))
        planned = []
        pairs = args[7:]
        if len(pairs) % 2 != 0:
            raise BridgeError("INVALID_ARGUMENTS", "Pad changes must be pairs of field and value")
        for offset in range(0, len(pairs), 2):
            field = str(pairs[offset])
            if field not in ("mute", "solo"):
                raise BridgeError("INVALID_ARGUMENTS", "Unknown pad field '%s'" % field)
            planned.append((field, self._flag(pairs[offset + 1], field)))
        for field, value in planned:
            setattr(pad, field, value)

    def _rack_variation(self, args):
        # args: kind, index, trackName, path, rackName, action, variationIndex (-1 when unused).
        self._require_args(args, 7, "/live/rack/variation")
        _track, rack = self._named_rack(args)
        action = str(args[5])
        if action not in VARIATION_ACTIONS:
            raise BridgeError("INVALID_ARGUMENTS", "Variation action must be one of: %s" % ", ".join(VARIATION_ACTIONS))
        if not hasattr(rack, "variation_count"):
            raise BridgeError("LIVE_VERSION_UNSUPPORTED", "Macro variations need Live 11 or newer; this is Live %s" % self._live_version_text())
        if action == "store":
            rack.store_variation()
            return
        if action == "randomize":
            rack.randomize_macros()
            return
        index = self._non_negative_index(args[6], "Variation index")
        count = int(rack.variation_count)
        if index >= count:
            raise BridgeError("INVALID_VARIATION", "Rack '%s' has %d variation(s); there is no variation %d" % (rack.name, count, index))
        rack.selected_variation_index = index
        if action == "recall":
            rack.recall_selected_variation()
        else:
            rack.delete_selected_variation()

    def _set_path_parameter(self, args):
        # args: kind, index, trackName, path, deviceName, parameterIndex, expectedParameterName, value
        self._require_args(args, 8, "/live/device_path/set_parameter")
        _track, device = self._named_path_device(args)
        parameters = list(device.parameters)
        parameter_index = self._non_negative_index(args[5], "Parameter index")
        if parameter_index >= len(parameters):
            raise BridgeError("INVALID_PARAMETER", "Device '%s' has no parameter %d" % (device.name, parameter_index))
        parameter = parameters[parameter_index]
        if str(parameter.name) != str(args[6]):
            raise BridgeError("PARAMETER_IDENTITY_MISMATCH", "Expected parameter %d to be '%s', found '%s'" % (parameter_index, args[6], parameter.name))
        parameter.value = self._parameter_value(parameter, args[7], "'%s'" % parameter.name)
