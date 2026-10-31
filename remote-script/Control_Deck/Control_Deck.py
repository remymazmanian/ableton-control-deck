"""Control Deck Bridge: the Ableton Control Deck remote script: a token-authenticated localhost bridge for MCP agents."""

import base64
import json
import socket
import threading
import time
from collections import OrderedDict, deque

import Live
from _Framework.ControlSurface import ControlSurface

from .bridge_core import BridgeError, filter_plugins, format_from_path, public_plugin, resolve_plugin


SCRIPT_NAME = "Control Deck Bridge"
SCRIPT_VERSION = "1.1.0"
PROTOCOL = "ableton-control-deck/1"
HOST = "127.0.0.1"
PORT = 50711
# Stamped with the per-install secret when `npm run setup` copies this script
# into Live's Remote Scripts folder. The placeholder is written split so an
# unstamped copy can detect itself.
TOKEN = "__CONTROL_DECK_TOKEN__"
MAX_REQUEST_BYTES = 32768
CHUNK_BYTES = 700
MAX_QUEUE = 256
MAX_RESPONSE_CACHE = 256
# Live rejects arrangement clip times outside this range. See Track.create_midi_clip.
MAX_ARRANGEMENT_BEATS = 1576800.0
MAX_NOTES_PER_CALL = 256


class ControlDeckBridge(ControlSurface):
    def __init__(self, c_instance):
        super(ControlDeckBridge, self).__init__(c_instance)
        self._set_suppress_rebuild_requests(True)
        self._running = True
        self._requests = deque()
        self._responses = OrderedDict()
        self._plugins = None
        self._plugins_by_path = {}
        self._cache_built_at = None
        self._socket = None
        if TOKEN == "__CONTROL_DECK" + "_TOKEN__":
            self._running = False
            self.log_message("(%s) refused to start: the auth-token placeholder was never stamped. Run `npm run setup` in the Ableton Control Deck folder, then toggle this Control Surface off and on." % SCRIPT_NAME)
            self.show_message("Control Deck Bridge has no auth token. Run `npm run setup` and reinstall the remote script.")
            return
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        self._socket.bind((HOST, PORT))
        self._thread = threading.Thread(target=self._listen, name="ControlDeckBridgeUDP", daemon=True)
        self._thread.start()
        self.log_message("(%s) %s listening on %s:%d" % (SCRIPT_NAME, SCRIPT_VERSION, HOST, PORT))

    def disconnect(self):
        self._running = False
        try:
            if self._socket is not None:
                self._socket.close()
        except Exception:
            pass
        self.log_message("(%s) disconnected" % SCRIPT_NAME)
        super(ControlDeckBridge, self).disconnect()

    def update_display(self):
        super(ControlDeckBridge, self).update_display()
        processed = 0
        while processed < 8 and self._requests:
            request, address = self._requests.popleft()
            self._handle_request(request, address)
            processed += 1

    def _listen(self):
        while self._running:
            try:
                data, address = self._socket.recvfrom(MAX_REQUEST_BYTES + 1)
            except OSError:
                break
            except Exception as error:
                if self._running:
                    self.log_message("(%s) receive error: %s" % (SCRIPT_NAME, error))
                continue
            if address[0] != HOST:
                continue
            if len(data) > MAX_REQUEST_BYTES:
                self._send_error(address, "", "REQUEST_TOO_LARGE", "Request exceeds %d bytes" % MAX_REQUEST_BYTES)
                continue
            try:
                request = json.loads(data.decode("utf-8"))
            except Exception:
                self._send_error(address, "", "INVALID_JSON", "Request must be valid UTF-8 JSON")
                continue
            if len(self._requests) >= MAX_QUEUE:
                self._send_error(address, str(request.get("id", "")), "QUEUE_FULL", "Control Deck Bridge request queue is full")
                continue
            self._requests.append((request, address))

    def _handle_request(self, request, address):
        request_id = str(request.get("id", "")).strip()
        if not request_id or len(request_id) > 128:
            self._send_error(address, request_id, "INVALID_REQUEST", "A request id of 1-128 characters is required")
            return
        if request.get("token") != TOKEN:
            self._send_error(address, request_id, "AUTH_INVALID", "Request token does not match this install's bridge secret. Run `npm run setup` so the remote script and data/bridge-token agree.")
            return
        cached = self._responses.get(request_id)
        if cached is not None:
            self._send_response(address, cached)
            return
        if request.get("protocol") != PROTOCOL:
            self._complete(address, request_id, False, error={"code": "PROTOCOL_MISMATCH", "message": "Expected %s" % PROTOCOL})
            return
        method = str(request.get("method", "")).strip()
        params = request.get("params", {})
        if not isinstance(params, dict):
            self._complete(address, request_id, False, error={"code": "INVALID_REQUEST", "message": "params must be an object"})
            return
        try:
            result = self._dispatch(method, params)
            self._complete(address, request_id, True, result=result)
        except BridgeError as error:
            payload = {"code": error.code, "message": error.message}
            if error.details is not None:
                payload["details"] = error.details
            self._complete(address, request_id, False, error=payload)
        except Exception as error:
            self.log_message("(%s) %s failed: %s" % (SCRIPT_NAME, method, error))
            self._complete(address, request_id, False, error={"code": "BRIDGE_ERROR", "message": str(error)})

    def _dispatch(self, method, params):
        if method == "bridge.status":
            return self._status()
        if method == "plugins.list":
            return filter_plugins(
                self._get_plugins(), params.get("query"), params.get("format"),
                params.get("limit", 100), params.get("offset", 0)
            )
        if method == "plugins.resolve":
            entry = resolve_plugin(self._get_plugins(), params.get("name"), params.get("format"), params.get("path"))
            return {"plugin": public_plugin(entry)}
        if method == "plugins.load":
            return self._load_plugin(params)
        if method == "plugins.refresh":
            self._refresh_plugins()
            return {"pluginCount": len(self._plugins or []), "cacheBuiltAt": self._cache_built_at}
        if method == "devices.resolve_user_item":
            return {"item": self._resolve_user_item(params)[0]}
        if method == "devices.load_user_item":
            return self._load_user_device(params)
        if method == "devices.resolve_browser_item":
            return {"device": self._resolve_browser_item(params)[0]}
        if method == "devices.load_browser_item":
            return self._load_browser_item(params)
        if method == "live.query":
            return self._live_query(params)
        if method == "live.command":
            return self._live_command(params)
        raise BridgeError("METHOD_NOT_FOUND", "Unknown bridge method '%s'" % method)

    def _status(self):
        application = self.application()
        live_version = None
        try:
            live_version = "%s.%s.%s" % (
                application.get_major_version(), application.get_minor_version(), application.get_bugfix_version()
            )
        except Exception:
            pass
        return {
            "name": SCRIPT_NAME,
            "version": SCRIPT_VERSION,
            "protocol": PROTOCOL,
            "host": HOST,
            "port": PORT,
            "liveVersion": live_version,
            "pluginCount": len(self._plugins) if self._plugins is not None else None,
            "cacheBuiltAt": self._cache_built_at,
            "liveControl": True,
            "pluginLoading": True,
            "capabilities": ["live-control", "read-back-verification", "plugin-browser", "plugin-loading", "user-device-loading"],
        }

    def _live_query(self, params):
        address, args = self._live_request(params)
        song = self.song()

        if address == "/live/song/get/cue_points":
            values = []
            for cue in song.cue_points:
                values.extend([cue.name, cue.time])
        elif address == "/live/track/get/arrangement_clips":
            track_index, track = self._track(args)
            values = [track_index]
            for clip in track.arrangement_clips:
                values.extend([clip.name, clip.start_time, clip.end_time, self._clip_kind(clip)])
        elif address == "/live/application/get/version":
            application = self.application()
            values = [application.get_major_version(), application.get_minor_version()]
        elif address == "/live/song/get/track_names":
            values = [track.name for track in song.tracks]
        elif address == "/live/song/get/scenes/name":
            values = [scene.name for scene in song.scenes]
        elif address.startswith("/live/song/get/"):
            prop = address.rsplit("/", 1)[-1]
            allowed = {
                "is_playing", "current_song_time", "tempo", "metronome", "record_mode",
                "session_record", "loop", "loop_start", "loop_length",
                "signature_numerator", "signature_denominator",
            }
            if prop not in allowed:
                raise BridgeError("ADDRESS_NOT_ALLOWED", "Unsupported song query: %s" % address)
            values = [self._json_value(getattr(song, prop))]
        elif address.startswith("/live/track/get/"):
            track_index, track = self._track(args)
            prop = address[len("/live/track/get/"):]
            if prop in {"name", "can_be_armed", "arm", "mute", "solo", "is_foldable", "is_grouped", "playing_slot_index"}:
                values = [track_index, self._json_value(getattr(track, prop))]
            elif prop in {"volume", "panning"}:
                values = [track_index, self._json_value(getattr(track.mixer_device, prop).value)]
            elif prop == "clips/name":
                values = [track_index] + [slot.clip.name if slot.clip else None for slot in track.clip_slots]
            elif prop == "clips/length":
                values = [track_index] + [slot.clip.length if slot.clip else None for slot in track.clip_slots]
            elif prop == "devices/name":
                values = [track_index] + [device.name for device in track.devices]
            elif prop == "devices/type":
                values = [track_index] + [self._json_value(device.type) for device in track.devices]
            elif prop == "devices/class_name":
                values = [track_index] + [device.class_name for device in track.devices]
            else:
                raise BridgeError("ADDRESS_NOT_ALLOWED", "Unsupported track query: %s" % address)
        elif address.startswith("/live/device/get/"):
            track_index, device_index, device = self._device(args)
            prop = address[len("/live/device/get/"):]
            prefix = [track_index, device_index]
            if prop in {"name", "class_name", "type"}:
                values = prefix + [self._json_value(getattr(device, prop))]
            elif prop == "parameters/name":
                values = prefix + [parameter.name for parameter in device.parameters]
            elif prop == "parameters/value":
                values = prefix + [parameter.value for parameter in device.parameters]
            elif prop == "parameters/min":
                values = prefix + [parameter.min for parameter in device.parameters]
            elif prop == "parameters/max":
                values = prefix + [parameter.max for parameter in device.parameters]
            elif prop == "parameters/value_string":
                values = prefix + [parameter.str_for_value(parameter.value) for parameter in device.parameters]
            elif prop in {"parameter/value", "parameter/value_string"}:
                parameter_index, parameter = self._parameter(device, args, 2)
                value = parameter.value if prop == "parameter/value" else parameter.str_for_value(parameter.value)
                values = prefix + [parameter_index, self._json_value(value)]
            else:
                raise BridgeError("ADDRESS_NOT_ALLOWED", "Unsupported device query: %s" % address)
        elif address == "/live/clip_slot/get/has_clip":
            track_index, scene_index, slot = self._clip_slot(args)
            values = [track_index, scene_index, bool(slot.has_clip)]
        elif address == "/live/clip/get/notes":
            track_index, scene_index, slot = self._clip_slot(args)
            if not slot.has_clip:
                raise BridgeError("CLIP_NOT_FOUND", "No clip exists at track %d, scene %d" % (track_index, scene_index))
            notes = slot.clip.get_notes_extended(0, 128, -8192, 16384)
            values = [track_index, scene_index]
            for note in notes:
                values.extend([note.pitch, note.start_time, note.duration, note.velocity, note.mute])
        elif address == "/live/arrangement_clip/get/notes":
            track_index, _track, clip_index, clip = self._arrangement_target(args)
            self._require_midi_clip(clip, clip_index)
            values = [track_index, clip_index, float(clip.start_time), float(clip.end_time), self._clip_kind(clip)]
            values.extend(self._note_payload(self._clip_notes(clip)))
        elif address == "/live/view/get/selected_track":
            try:
                index = list(song.tracks).index(song.view.selected_track)
            except ValueError:
                raise BridgeError("SELECTION_NOT_REGULAR_TRACK", "The selected track is not a regular track")
            values = [index]
        elif address == "/live/view/get/selected_clip":
            try:
                track_index = list(song.tracks).index(song.view.selected_track)
                scene_index = list(song.scenes).index(song.view.selected_scene)
            except ValueError:
                raise BridgeError("SELECTION_NOT_REGULAR_CLIP", "The selected location is not a regular track and scene")
            values = [track_index, scene_index]
        else:
            raise BridgeError("ADDRESS_NOT_ALLOWED", "Unsupported Live query: %s" % address)
        return {"address": address, "args": [self._json_value(value) for value in values]}

    def _live_command(self, params):
        address, args = self._live_request(params)
        song = self.song()
        if address in {"/live/song/start_playing", "/live/song/stop_playing", "/live/song/continue_playing"}:
            method = address.rsplit("/", 1)[-1]
            getattr(song, method)()
        elif address in {"/live/song/create_midi_track", "/live/song/create_audio_track"}:
            self._require_args(args, 1, address)
            method = address.rsplit("/", 1)[-1]
            getattr(song, method)(int(args[0]))
        elif address == "/live/song/delete_track":
            self._require_args(args, 1, address)
            track_index, _track = self._track(args)
            song.delete_track(track_index)
        elif address.startswith("/live/song/set/"):
            self._require_args(args, 1, address)
            prop = address.rsplit("/", 1)[-1]
            allowed = {"tempo", "signature_numerator", "signature_denominator", "current_song_time", "metronome", "record_mode"}
            if prop not in allowed:
                raise BridgeError("ADDRESS_NOT_ALLOWED", "Unsupported song mutation: %s" % address)
            setattr(song, prop, args[0])
        elif address == "/live/track/set/name":
            self._require_args(args, 2, address)
            _track_index, track = self._track(args)
            track.name = str(args[1])
        elif address == "/live/clip_slot/create_clip":
            self._require_args(args, 3, address)
            _track_index, _scene_index, slot = self._clip_slot(args)
            slot.create_clip(float(args[2]))
        elif address == "/live/clip/add/notes":
            self._require_args(args, 7, address)
            _track_index, _scene_index, slot = self._clip_slot(args)
            if not slot.has_clip:
                raise BridgeError("CLIP_NOT_FOUND", "Cannot add notes because the target clip does not exist")
            note_values = args[2:]
            if len(note_values) % 5 != 0:
                raise BridgeError("INVALID_NOTES", "MIDI note data must contain groups of five values")
            notes = []
            for offset in range(0, len(note_values), 5):
                pitch, start_time, duration, velocity, mute = note_values[offset:offset + 5]
                notes.append(Live.Clip.MidiNoteSpecification(
                    pitch=int(pitch), start_time=float(start_time), duration=float(duration),
                    velocity=int(velocity), mute=bool(mute)
                ))
            slot.clip.add_new_notes(tuple(notes))
        elif address == "/live/device/set/parameter/value":
            self._require_args(args, 4, address)
            _track_index, _device_index, device = self._device(args)
            _parameter_index, parameter = self._parameter(device, args, 2)
            parameter.value = float(args[3])
        elif address == "/live/view/set/selected_track":
            self._require_args(args, 1, address)
            _track_index, track = self._track(args)
            song.view.selected_track = track
        elif address == "/live/clip/fill_arrangement":
            # args: track, scene, start_beats, end_beats -> tile the Session clip across [start, end)
            self._require_args(args, 4, address)
            _track_index, track = self._track(args)
            _t, _s, slot = self._clip_slot(args)
            if not slot.has_clip:
                raise BridgeError("CLIP_NOT_FOUND", "No Session clip to place at that track/scene")
            start, end = float(args[2]), float(args[3])
            step = float(slot.clip.length)
            if step <= 0 or end <= start:
                raise BridgeError("INVALID_RANGE", "End must be after start and the clip must have length")
            if (end - start) / step > 512:
                raise BridgeError("INVALID_RANGE", "Range would need more than 512 clip copies")
            position = start
            while position < end - 0.0001:
                track.duplicate_clip_to_arrangement(slot.clip, position)
                position += step
        elif address == "/live/track/create_arrangement_midi_clip":
            self._create_arrangement_midi_clip(args)
        elif address == "/live/arrangement_clip/add/notes":
            self._add_arrangement_notes(args)
        elif address == "/live/arrangement_clip/modify/notes":
            self._modify_arrangement_notes(args)
        elif address == "/live/arrangement_clip/remove/notes":
            self._remove_arrangement_notes(args)
        elif address == "/live/track/clear_arrangement":
            self._require_args(args, 2, address)
            _track_index, track = self._track(args)
            if args[1] is not True:
                raise BridgeError("CONFIRM_REQUIRED", "clear_arrangement requires confirm=true")
            for clip in list(track.arrangement_clips):
                track.delete_clip(clip)
        elif address == "/live/song/create_cue_point":
            self._require_args(args, 1, address)
            time_beats = float(args[0])
            if self._cue_at(time_beats) is None:
                self._require_playhead_at(time_beats)
                song.set_or_delete_cue()
        elif address == "/live/cue_point/set_name":
            self._require_args(args, 2, address)
            cue = self._cue_at(float(args[0]))
            if cue is None:
                raise BridgeError("CUE_NOT_FOUND", "No locator at %s beats" % args[0])
            cue.name = str(args[1])
        elif address == "/live/song/delete_cue_point":
            self._require_args(args, 1, address)
            time_beats = float(args[0])
            if self._cue_at(time_beats) is not None:
                self._require_playhead_at(time_beats)
                song.set_or_delete_cue()
        else:
            raise BridgeError("ADDRESS_NOT_ALLOWED", "Unsupported Live mutation: %s" % address)
        return {"address": address, "completed": True}

    def _require_playhead_at(self, time_beats):
        # set_or_delete_cue toggles a locator wherever the playhead is, and Live
        # applies a playhead move on its next tick. Acting before the move lands,
        # or while playing, would add or remove a locator somewhere else.
        song = self.song()
        if song.is_playing:
            raise BridgeError("STOP_PLAYBACK", "Stop playback before adding or deleting a locator")
        if abs(float(song.current_song_time) - time_beats) >= 0.001:
            raise BridgeError("PLAYHEAD_NOT_READY", "Move the playhead to %s beats first" % time_beats)

    def _cue_at(self, time_beats):
        for cue in self.song().cue_points:
            if abs(float(cue.time) - time_beats) < 0.001:
                return cue
        return None

    def _live_request(self, params):
        address = str(params.get("address", "")).strip()
        args = params.get("args", [])
        if not address.startswith("/live/") or len(address) > 256:
            raise BridgeError("INVALID_ADDRESS", "A valid /live/ address is required")
        if not isinstance(args, list) or len(args) > 4096:
            raise BridgeError("INVALID_REQUEST", "args must be an array with at most 4096 values")
        return address, args

    def _require_args(self, args, minimum, address):
        if len(args) < minimum:
            raise BridgeError("INVALID_ARGUMENTS", "%s requires at least %d arguments" % (address, minimum))

    def _track(self, args):
        self._require_args(args, 1, "track operation")
        try:
            index = int(args[0])
            track = self.song().tracks[index]
        except Exception:
            raise BridgeError("INVALID_TRACK", "Track index does not exist")
        if index < 0:
            raise BridgeError("INVALID_TRACK", "Track index must be non-negative")
        return index, track

    def _clip_slot(self, args):
        self._require_args(args, 2, "clip-slot operation")
        track_index, track = self._track(args)
        try:
            scene_index = int(args[1])
            slot = track.clip_slots[scene_index]
        except Exception:
            raise BridgeError("INVALID_SCENE", "Scene index does not exist")
        if scene_index < 0:
            raise BridgeError("INVALID_SCENE", "Scene index must be non-negative")
        return track_index, scene_index, slot

    def _device(self, args):
        self._require_args(args, 2, "device operation")
        track_index, track = self._track(args)
        try:
            device_index = int(args[1])
            device = track.devices[device_index]
        except Exception:
            raise BridgeError("INVALID_DEVICE", "Device index does not exist")
        if device_index < 0:
            raise BridgeError("INVALID_DEVICE", "Device index must be non-negative")
        return track_index, device_index, device

    def _parameter(self, device, args, position):
        self._require_args(args, position + 1, "parameter operation")
        try:
            parameter_index = int(args[position])
            parameter = device.parameters[parameter_index]
        except Exception:
            raise BridgeError("INVALID_PARAMETER", "Parameter index does not exist")
        if parameter_index < 0:
            raise BridgeError("INVALID_PARAMETER", "Parameter index must be non-negative")
        return parameter_index, parameter

    def _create_arrangement_midi_clip(self, args):
        # Track.create_midi_clip(start_time, length) inserts an empty Arrangement
        # MIDI clip. The second value is the length in beats, not the end time.
        # Live 12.1.10 added the method; earlier versions do not have it.
        self._require_args(args, 4, "/live/track/create_arrangement_midi_clip")
        _track_index, track = self._named_track(args)
        start = self._finite_float(args[2], "Arrangement clip start")
        length = self._finite_float(args[3], "Arrangement clip length")
        if start < 0 or start > MAX_ARRANGEMENT_BEATS or length <= 0 or start + length > MAX_ARRANGEMENT_BEATS:
            raise BridgeError("INVALID_RANGE", "Arrangement clip start must be from 0 to %s beats and the clip must end inside that range" % MAX_ARRANGEMENT_BEATS)
        name = None
        if len(args) >= 5 and str(args[4]).strip():
            name = str(args[4]).replace("\x00", "").replace("\r", " ").replace("\n", " ").strip()
            if len(name) > 128:
                raise BridgeError("INVALID_REQUEST", "Clip name exceeds 128 characters")
        create = getattr(track, "create_midi_clip", None)
        if not callable(create):
            raise BridgeError("LIVE_VERSION_UNSUPPORTED", "Track.create_midi_clip is not available in this Live (%s). It needs Live 12.1.10 or newer." % self._live_version_text())
        try:
            created = create(start, length)
        except BridgeError:
            raise
        except Exception as error:
            message = str(error)
            if "overlap" in message.lower():
                raise BridgeError("CLIP_OVERLAP", "An arrangement clip already occupies that time range on this track")
            raise BridgeError("CLIP_NOT_CREATED", "Live did not create the arrangement MIDI clip (%s): %s" % (self._live_version_text(), message))
        clip = created if self._looks_like_clip(created) else None
        if clip is None:
            matches = self._arrangement_clips_at(track, start, length)
            if len(matches) != 1:
                code = "CLIP_NOT_CONFIRMED" if len(matches) == 0 else "CLIP_AMBIGUOUS"
                detail = "Live did not confirm the new arrangement MIDI clip" if len(matches) == 0 else "More than one arrangement clip matches that start and length"
                raise BridgeError(code, detail)
            clip = matches[0]
        if name:
            clip.name = name

    def _named_track(self, args):
        track_index, track = self._track(args)
        expected = str(args[1])
        if track.name != expected:
            raise BridgeError("TRACK_IDENTITY_MISMATCH", "Expected track '%s', found '%s'" % (expected, track.name))
        return track_index, track

    def _live_version_text(self):
        application = self.application()
        try:
            return "%s.%s.%s" % (application.get_major_version(), application.get_minor_version(), application.get_bugfix_version())
        except Exception:
            try:
                return "%s.%s" % (application.get_major_version(), application.get_minor_version())
            except Exception:
                return "unknown"

    def _finite_float(self, value, label):
        try:
            number = float(value)
        except Exception:
            raise BridgeError("INVALID_ARGUMENTS", "%s must be a number" % label)
        if number != number or number in (float("inf"), float("-inf")):
            raise BridgeError("INVALID_ARGUMENTS", "%s must be finite" % label)
        return number

    def _looks_like_clip(self, value):
        if value is None or isinstance(value, (int, float, bool, str)):
            return False
        return hasattr(value, "start_time") and hasattr(value, "name")

    def _arrangement_clips_at(self, track, start, length):
        end = start + length
        matches = []
        for clip in track.arrangement_clips:
            if abs(float(clip.start_time) - start) < 0.001 and abs(float(clip.end_time) - end) < 0.001:
                matches.append(clip)
        return matches

    def _clip_kind(self, clip):
        midi = self._clip_flag(clip, "is_midi_clip")
        audio = self._clip_flag(clip, "is_audio_clip")
        if midi and not audio:
            return "midi"
        if audio and not midi:
            return "audio"
        return "unknown"

    def _clip_flag(self, clip, name):
        try:
            return bool(getattr(clip, name))
        except Exception:
            return False

    def _arrangement_target(self, args):
        self._require_args(args, 4, "arrangement clip operation")
        track_index, track = self._named_track(args)
        clip_index = self._non_negative_index(args[2], "Arrangement clip index")
        expected_start = self._finite_float(args[3], "Arrangement clip start")
        clips = list(track.arrangement_clips)
        if clip_index >= len(clips):
            raise BridgeError("CLIP_NOT_FOUND", "Arrangement clip index %d does not exist on track %d" % (clip_index, track_index))
        clip = clips[clip_index]
        actual_start = float(clip.start_time)
        if abs(actual_start - expected_start) >= 0.001:
            raise BridgeError("CLIP_IDENTITY_MISMATCH", "Arrangement clip %d on track '%s' starts at %s beats, not %s" % (clip_index, track.name, actual_start, expected_start))
        return track_index, track, clip_index, clip

    def _require_midi_clip(self, clip, clip_index):
        kind = self._clip_kind(clip)
        if kind != "midi":
            raise BridgeError("CLIP_NOT_MIDI", "Arrangement clip %d is %s, not MIDI" % (clip_index, kind))

    def _clip_notes(self, clip):
        span = 16384.0
        try:
            span = max(span, float(clip.length) + 1.0)
        except Exception:
            pass
        notes = []
        for note in clip.get_notes_extended(0, 128, -8192.0, span):
            notes.append(note)
        return notes

    def _note_payload(self, notes):
        values = []
        for note in notes:
            values.extend([int(note.pitch), float(note.start_time), float(note.duration), float(note.velocity), bool(note.mute), int(note.note_id)])
        return values

    def _add_arrangement_notes(self, args):
        _track_index, _track, clip_index, clip = self._arrangement_target(args)
        self._require_midi_clip(clip, clip_index)
        note_values = args[4:]
        specs = self._note_specifications(note_values)
        clip.add_new_notes(tuple(specs))

    def _modify_arrangement_notes(self, args):
        _track_index, _track, clip_index, clip = self._arrangement_target(args)
        self._require_midi_clip(clip, clip_index)
        mods = args[4:]
        if not mods or len(mods) % 6 != 0:
            raise BridgeError("INVALID_NOTES", "Note modifications must contain groups of id, pitch, start, duration, velocity, and mute")
        if len(mods) // 6 > MAX_NOTES_PER_CALL:
            raise BridgeError("INVALID_NOTES", "At most %d notes can be modified at once" % MAX_NOTES_PER_CALL)
        by_id = {}
        for note in self._clip_notes(clip):
            note_id = int(note.note_id)
            if note_id in by_id:
                raise BridgeError("NOTE_ID_AMBIGUOUS", "Arrangement clip %d has more than one note with id %d" % (clip_index, note_id))
            by_id[note_id] = note
        changed = []
        seen = set()
        for offset in range(0, len(mods), 6):
            note_id = self._whole_number(mods[offset], "note id", 0, 2 ** 53)
            if note_id in seen:
                raise BridgeError("NOTE_ID_AMBIGUOUS", "Note id %d was given more than once" % note_id)
            seen.add(note_id)
            note = by_id.get(note_id)
            if note is None:
                raise BridgeError("NOTE_NOT_FOUND", "No note with id %d in arrangement clip %d" % (note_id, clip_index))
            pitch, start_time, duration, velocity = self._validated_note(mods[offset + 1], mods[offset + 2], mods[offset + 3], mods[offset + 4], 0)
            note.pitch = pitch
            note.start_time = start_time
            note.duration = duration
            note.velocity = float(velocity)
            note.mute = bool(mods[offset + 5])
            changed.append(note)
        clip.apply_note_modifications(tuple(changed))

    def _remove_arrangement_notes(self, args):
        self._require_args(args, 8, "/live/arrangement_clip/remove/notes")
        _track_index, _track, clip_index, clip = self._arrangement_target(args)
        self._require_midi_clip(clip, clip_index)
        from_pitch = self._whole_number(args[4], "fromPitch", 0, 127)
        pitch_span = self._whole_number(args[5], "pitchSpan", 1, 128)
        if from_pitch + pitch_span > 128:
            raise BridgeError("INVALID_RANGE", "Pitch range must stay inside 0-127")
        from_time = self._finite_float(args[6], "fromTime")
        time_span = self._finite_float(args[7], "timeSpan")
        if from_time < 0 or time_span <= 0:
            raise BridgeError("INVALID_RANGE", "fromTime must be >= 0 and timeSpan must be positive")
        matched = [note for note in self._clip_notes(clip) if self._note_starts_in_range(note, from_pitch, pitch_span, from_time, time_span)]
        if not matched:
            raise BridgeError("NOTE_NOT_FOUND", "No notes start in that pitch and time range on arrangement clip %d" % clip_index)
        clip.remove_notes_extended(from_pitch, pitch_span, from_time, time_span)

    def _note_specifications(self, note_values):
        if not note_values or len(note_values) % 5 != 0:
            raise BridgeError("INVALID_NOTES", "MIDI note data must contain groups of five values")
        if len(note_values) // 5 > MAX_NOTES_PER_CALL:
            raise BridgeError("INVALID_NOTES", "At most %d notes can be written at once" % MAX_NOTES_PER_CALL)
        specs = []
        for offset in range(0, len(note_values), 5):
            pitch, start_time, duration, velocity = self._validated_note(note_values[offset], note_values[offset + 1], note_values[offset + 2], note_values[offset + 3], 1)
            specs.append(Live.Clip.MidiNoteSpecification(
                pitch=pitch, start_time=start_time, duration=duration, velocity=velocity, mute=bool(note_values[offset + 4])
            ))
        return specs

    def _validated_note(self, pitch, start_time, duration, velocity, minimum_velocity):
        pitch_number = self._whole_number(pitch, "pitch", 0, 127)
        start_number = self._finite_float(start_time, "note start")
        duration_number = self._finite_float(duration, "note duration")
        if start_number < 0 or duration_number <= 0:
            raise BridgeError("INVALID_NOTES", "Note start must be >= 0 and duration must be positive")
        velocity_number = self._whole_number(velocity, "velocity", minimum_velocity, 127)
        return pitch_number, start_number, duration_number, velocity_number

    def _non_negative_index(self, value, label):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise BridgeError("INVALID_ARGUMENTS", "%s must be an integer" % label)
        number = float(value)
        if number != number or not number.is_integer() or number < 0:
            raise BridgeError("INVALID_ARGUMENTS", "%s must be a non-negative integer" % label)
        return int(number)

    def _whole_number(self, value, label, low, high):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise BridgeError("INVALID_NOTES", "%s must be a number" % label)
        number = float(value)
        if number != number or not number.is_integer():
            raise BridgeError("INVALID_NOTES", "%s must be an integer" % label)
        whole = int(number)
        if whole < low or whole > high:
            raise BridgeError("INVALID_NOTES", "%s must be from %d to %d" % (label, low, high))
        return whole

    def _note_starts_in_range(self, note, from_pitch, pitch_span, from_time, time_span):
        pitch = int(note.pitch)
        start = float(note.start_time)
        return from_pitch <= pitch < from_pitch + pitch_span and from_time <= start < from_time + time_span

    def _json_value(self, value):
        if value is None or isinstance(value, (str, int, float, bool)):
            return value
        try:
            return int(value)
        except Exception:
            return str(value)

    def _get_plugins(self):
        if self._plugins is None:
            self._refresh_plugins()
        return self._plugins or []

    def _refresh_plugins(self):
        browser = self.application().browser
        entries = []
        generic_root = getattr(browser, "plugins", None)
        generic_path = ["Plugins"]
        if generic_root is not None and not self._has_format_children(generic_root):
            generic_path.append(self._infer_plugin_family(browser, generic_root))
        roots = [(generic_root, generic_path)]
        roots.extend([
            (getattr(browser, "vst3_plugins", None), ["Plugins", "VST3"]),
            (getattr(browser, "vst_plugins", None), ["Plugins", "VST"]),
            (getattr(browser, "audio_units", None), ["Plugins", "AUv2"]),
            (getattr(browser, "au_plugins", None), ["Plugins", "AU"]),
            (getattr(browser, "plug_ins", None), ["Plugins"]),
        ])
        for root, path in roots:
            self._walk_plugins(root, path, entries, 0)

        deduplicated = {}
        for entry in entries:
            key = entry["path"].casefold()
            if key not in deduplicated:
                deduplicated[key] = entry
        self._plugins = sorted(deduplicated.values(), key=lambda item: (item["name"].casefold(), item["path"].casefold()))
        self._plugins_by_path = {entry["path"].casefold(): entry for entry in self._plugins}
        self._cache_built_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
        self.log_message("(%s) indexed %d plugins" % (SCRIPT_NAME, len(self._plugins)))

    def _has_format_children(self, node):
        try:
            names = [str(getattr(child, "name", "")).strip().lower().replace("-", " ").replace("_", " ") for child in node.children]
        except Exception:
            names = []
        labels = {"vst", "vst2", "vst 2", "vst3", "vst 3", "au", "auv2", "au v2", "audio units", "audio unit"}
        return any(name in labels or name.startswith("vst3 plug") or name.startswith("vst plug") for name in names)

    def _infer_plugin_family(self, browser, root):
        candidates = [
            ("VST3", getattr(browser, "vst3_plugins", None)),
            ("VST", getattr(browser, "vst_plugins", None)),
            ("AUv2", getattr(browser, "audio_units", None)),
            ("AU", getattr(browser, "au_plugins", None)),
        ]
        for label, candidate in candidates:
            if candidate is not None and id(candidate) == id(root):
                return label

        def uri_hint(node, depth=0):
            if node is None or depth > 6:
                return None
            try:
                uri = str(getattr(node, "uri", "") or "").lower()
            except Exception:
                uri = ""
            if "#vst3" in uri:
                return "VST3"
            if "#vst" in uri:
                return "VST"
            if "#au" in uri or "audiounit" in uri:
                return "AUv2"
            try:
                children = list(getattr(node, "children", []) or [])[:12]
            except Exception:
                children = []
            for child in children:
                hint = uri_hint(child, depth + 1)
                if hint:
                    return hint
            return None

        return uri_hint(root) or "VST3"

    def _walk_plugins(self, node, path, entries, depth):
        if node is None or depth > 12:
            return
        try:
            children = list(getattr(node, "children", []) or [])
        except Exception:
            children = []
        try:
            loadable = bool(getattr(node, "is_loadable", False))
        except Exception:
            loadable = not children
        if loadable:
            name = str(getattr(node, "name", path[-1] if path else "Unnamed"))
            full_path = "/".join(path)
            plugin_format = format_from_path(full_path)
            if plugin_format:
                entries.append({"name": name, "path": full_path, "format": plugin_format, "item": node})
        for child in children:
            child_name = str(getattr(child, "name", "Unnamed"))
            self._walk_plugins(child, path + [child_name], entries, depth + 1)

    def _load_plugin(self, params):
        path = params.get("path")
        entry = resolve_plugin(self._get_plugins(), params.get("name"), params.get("format"), path)
        try:
            track_index = int(params.get("trackIndex"))
        except Exception:
            raise BridgeError("INVALID_TRACK", "trackIndex must be an integer")
        tracks = list(self.song().tracks)
        if track_index < 0 or track_index >= len(tracks):
            raise BridgeError("INVALID_TRACK", "Track index %d does not exist" % track_index)
        track = tracks[track_index]
        expected_name = str(params.get("expectedTrackName", ""))
        if track.name != expected_name:
            raise BridgeError("TRACK_IDENTITY_MISMATCH", "Expected track '%s', found '%s'" % (expected_name, track.name))

        try:
            before_count = len(track.devices)
        except Exception:
            before_count = None
        previous_track = getattr(self.song().view, "selected_track", None)
        restored = previous_track is track
        try:
            self.song().view.selected_track = track
            self.application().browser.load_item(entry["item"])
        finally:
            if previous_track is not None and previous_track is not track:
                try:
                    self.song().view.selected_track = previous_track
                    restored = self.song().view.selected_track is previous_track
                except Exception:
                    restored = False
        return {
            "loaded": public_plugin(entry),
            "trackIndex": track_index,
            "trackName": track.name,
            "deviceCountBefore": before_count,
            "selectionRestored": restored,
        }

    def _load_user_device(self, params):
        loaded, item = self._resolve_user_item(params)
        return self._load_item_on_track(item, params, loaded)

    def _resolve_user_item(self, params):
        name = str(params.get("name", "")).strip()
        if not name:
            raise BridgeError("INVALID_DEVICE_NAME", "A User Library device name is required")
        browser = self.application().browser
        root = getattr(browser, "user_library", None)
        if root is None:
            raise BridgeError("USER_LIBRARY_UNAVAILABLE", "Ableton's User Library is unavailable")
        matches = []
        self._find_user_items(root, ["User Library"], name.casefold(), matches, 0)
        wanted = params.get("path")
        if wanted is not None and str(wanted).strip():
            wanted_text = str(wanted).strip()
            self._reject_filesystem_preset_path(wanted_text)
            normalized = wanted_text.casefold()
            matches = [entry for entry in matches if entry[0].casefold() == normalized]
        if not matches:
            raise BridgeError("USER_DEVICE_NOT_FOUND", "User Library device '%s' was not found" % name)
        if len(matches) > 1:
            paths = [item[0] for item in matches[:20]]
            raise BridgeError("USER_DEVICE_AMBIGUOUS", "Multiple User Library devices are named '%s': %s" % (name, ", ".join(paths)), {"paths": paths})
        path, item = matches[0]
        return {"name": name, "path": path, "kind": "user-device"}, item

    def _reject_filesystem_preset_path(self, path):
        # Browser.load_item only accepts a BrowserItem Live already lists.
        # A disk path, including .vstpreset and .aupreset files, is not one.
        if path.startswith("/") or path.startswith("~") or (len(path) > 2 and path[1] == ":"):
            raise BridgeError(
                "PRESET_PATH_UNSUPPORTED",
                "path must be a Live Browser path such as 'User Library/Presets/Instruments/My Rack', not a file on disk. "
                "Save the patch as an Instrument Rack (.adg) or a device preset (.adv) in the User Library and pass its exact name. "
                "Live's API cannot load a .vstpreset or .aupreset from a filesystem path."
            )

    def _browser_roots(self):
        browser = self.application().browser
        return [
            ("Instruments", getattr(browser, "instruments", None)),
            ("Audio Effects", getattr(browser, "audio_effects", None)),
            ("MIDI Effects", getattr(browser, "midi_effects", None)),
            ("Drums", getattr(browser, "drums", None)),
        ]

    def _resolve_browser_item(self, params):
        name = str(params.get("name", "")).strip()
        if not name:
            raise BridgeError("INVALID_DEVICE_NAME", "A Live device name is required")
        matches = []
        for label, root in self._browser_roots():
            if root is None:
                continue
            self._find_user_items(root, [label], name.casefold(), matches, 0)
        wanted_path = params.get("path")
        if wanted_path:
            normalized = str(wanted_path).casefold()
            matches = [entry for entry in matches if entry[0].casefold() == normalized]
        if not matches:
            raise BridgeError("LIVE_DEVICE_NOT_FOUND", "Live device '%s' was not found under Instruments, Audio Effects, MIDI Effects, or Drums" % name)
        if len(matches) > 1:
            raise BridgeError("LIVE_DEVICE_AMBIGUOUS", "Multiple Live Browser items are named '%s'; pass the exact path to disambiguate" % name, {"paths": [entry[0] for entry in matches[:20]]})
        path, item = matches[0]
        return {"name": name, "path": path, "kind": "live-device"}, item

    def _load_browser_item(self, params):
        loaded, item = self._resolve_browser_item(params)
        return self._load_item_on_track(item, params, loaded)

    def _load_item_on_track(self, item, params, loaded):
        try:
            track_index = int(params.get("trackIndex"))
        except Exception:
            raise BridgeError("INVALID_TRACK", "trackIndex must be an integer")
        tracks = list(self.song().tracks)
        if track_index < 0 or track_index >= len(tracks):
            raise BridgeError("INVALID_TRACK", "Track index %d does not exist" % track_index)
        track = tracks[track_index]
        expected_name = str(params.get("expectedTrackName", ""))
        if track.name != expected_name:
            raise BridgeError("TRACK_IDENTITY_MISMATCH", "Expected track '%s', found '%s'" % (expected_name, track.name))

        try:
            before_count = len(track.devices)
        except Exception:
            before_count = None
        previous_track = getattr(self.song().view, "selected_track", None)
        restored = previous_track is track
        try:
            self.song().view.selected_track = track
            self.application().browser.load_item(item)
        finally:
            if previous_track is not None and previous_track is not track:
                try:
                    self.song().view.selected_track = previous_track
                    restored = self.song().view.selected_track is previous_track
                except Exception:
                    restored = False
        return {
            "loaded": loaded,
            "trackIndex": track_index,
            "trackName": track.name,
            "deviceCountBefore": before_count,
            "selectionRestored": restored,
        }

    def _find_user_items(self, node, path, target_name, matches, depth):
        if node is None or depth > 18 or len(matches) > 20:
            return
        try:
            children = list(getattr(node, "children", []) or [])
        except Exception:
            children = []
        try:
            loadable = bool(getattr(node, "is_loadable", False))
        except Exception:
            loadable = not children
        node_name = str(getattr(node, "name", path[-1] if path else "Unnamed"))
        if loadable and node_name.casefold() == target_name:
            matches.append(("/".join(path), node))
        for child in children:
            child_name = str(getattr(child, "name", "Unnamed"))
            self._find_user_items(child, path + [child_name], target_name, matches, depth + 1)

    def _complete(self, address, request_id, ok, result=None, error=None):
        response = {"protocol": PROTOCOL, "id": request_id, "ok": bool(ok)}
        if ok:
            response["result"] = result
        else:
            response["error"] = error or {"code": "BRIDGE_ERROR", "message": "Unknown bridge error"}
        self._responses[request_id] = response
        self._responses.move_to_end(request_id)
        while len(self._responses) > MAX_RESPONSE_CACHE:
            self._responses.popitem(last=False)
        self._send_response(address, response)

    def _send_error(self, address, request_id, code, message):
        response = {"protocol": PROTOCOL, "id": request_id, "ok": False, "error": {"code": code, "message": message}}
        self._send_response(address, response)

    def _send_response(self, address, response):
        raw = json.dumps(response, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        if len(raw) <= 1200:
            self._socket.sendto(raw, address)
            return
        chunks = [raw[index:index + CHUNK_BYTES] for index in range(0, len(raw), CHUNK_BYTES)]
        total = len(chunks)
        for index, chunk in enumerate(chunks, 1):
            envelope = {
                "protocol": PROTOCOL,
                "id": response.get("id", ""),
                "chunk": {"index": index, "total": total, "encoding": "base64"},
                "payload": base64.b64encode(chunk).decode("ascii"),
            }
            self._socket.sendto(json.dumps(envelope, separators=(",", ":")).encode("utf-8"), address)
