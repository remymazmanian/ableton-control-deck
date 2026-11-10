import os
import tempfile
import types
import unittest

# Importing the Live test module installs the Live and _Framework stubs.
from test_control_deck_live import ArrangementClip, ArrangementNote, Clip, ControlDeckBridge, Parameter, Slot, Song, Track


class FaderParameter(Parameter):
    """A volume or send fader whose display reads in dB, like Live's."""

    def str_for_value(self, value):
        if value <= 0:
            return "-inf dB"
        return "%.1f dB" % ((value - 0.85) * 40.0)


class PanParameter(Parameter):
    def str_for_value(self, value):
        if abs(value) < 0.005:
            return "C"
        return "%d%s" % (round(abs(value) * 50), "R" if value > 0 else "L")


class Routing(object):
    def __init__(self, name):
        self.display_name = name


def mixer(sends=0):
    return types.SimpleNamespace(
        volume=FaderParameter("Volume", 0.85),
        panning=PanParameter("Pan", 0.0, -1.0, 1.0),
        sends=[FaderParameter("Send", 0.0) for _ in range(sends)],
    )


class SessionClip(Clip):
    def __init__(self, name="Loop", midi=True):
        super(SessionClip, self).__init__()
        self.name = name
        self.color = 0x000000
        self.is_midi_clip = midi
        self.is_audio_clip = not midi
        self.looping = True
        self.loop_start = 0.0
        self.loop_end = 4.0
        self.start_marker = 0.0
        self.end_marker = 4.0
        self.launch_mode = 0
        self.launch_quantization = 0
        self.legato = False
        self.muted = False
        self.is_playing = False
        if not midi:
            self.gain = 0.4
            self.gain_display_string = "0.0 dB"
            self.pitch_coarse = 0
            self.pitch_fine = 0.0
            self.warping = True
            self.warp_mode = 0
            self.available_warp_modes = [0, 1, 2, 3, 4, 6]

    def __setattr__(self, name, value):
        # Live refuses a loop start at or after the loop end, and the reverse.
        if name == "loop_start" and hasattr(self, "loop_end") and value >= self.loop_end:
            raise RuntimeError("LoopStart behind LoopEnd")
        if name == "loop_end" and hasattr(self, "loop_start") and value <= self.loop_start:
            raise RuntimeError("LoopEnd before LoopStart")
        object.__setattr__(self, name, value)


class StrictClip(SessionClip):
    """A clip whose end marker Live refuses past 6 beats, to force a failure partway through."""

    def __setattr__(self, name, value):
        if name == "end_marker" and hasattr(self, "end_marker") and value > 6:
            raise RuntimeError("EndMarker out of range")
        SessionClip.__setattr__(self, name, value)


class NoteClip(SessionClip):
    """A Session MIDI clip with Live's note API, borrowed from the Arrangement fake."""

    def __init__(self, name="Loop", notes=()):
        super(NoteClip, self).__init__(name)
        self.length = 4.0
        self._notes = [ArrangementNote(pitch, start, 0.5, 100, False, index + 1) for index, (pitch, start) in enumerate(notes)]
        self._next_id = len(self._notes) + 1
        self.last_vector = None
        self.last_applied = None

    get_notes_extended = ArrangementClip.get_notes_extended
    apply_note_modifications = ArrangementClip.apply_note_modifications
    remove_notes_extended = ArrangementClip.remove_notes_extended


class LaunchSlot(Slot):
    def __init__(self, clip=None):
        super(LaunchSlot, self).__init__(clip)
        self.is_playing = False
        self.is_triggered = False
        self.is_recording = False
        self.fired = 0

    def fire(self):
        self.fired += 1
        self.is_triggered = True

    def delete_clip(self):
        self.clip = None

    def create_audio_clip(self, path):
        self.clip = SessionClip(os.path.splitext(os.path.basename(path))[0], midi=False)
        self.clip.file_path = path

    def duplicate_clip_to(self, target):
        copy = SessionClip(self.clip.name, self.clip.is_midi_clip)
        target.clip = copy


class Scene(object):
    def __init__(self, name):
        self.name = name
        self.color = 0
        self.tempo = 120.0
        self.tempo_enabled = False
        self.time_signature_numerator = 4
        self.time_signature_denominator = 4
        self.time_signature_enabled = False
        self.is_triggered = False
        self.fired = 0

    def fire(self):
        self.fired += 1
        self.is_triggered = True


class SessionTrack(Track):
    def __init__(self, name, midi=True, sends=1, scenes=2):
        super(SessionTrack, self).__init__(name)
        self.mixer_device = mixer(sends)
        self.has_midi_input = midi
        self.clip_slots = [LaunchSlot() for _ in range(scenes)]
        self.fired_slot_index = -1
        self.stopped = 0
        self.arrangement_clips = []
        self.devices = []
        self.color = 0
        self.fold_state = 0
        self.input_routing_type = Routing("All Ins")
        self.input_routing_channel = Routing("All Channels")
        self.output_routing_type = Routing("Main")
        self.output_routing_channel = Routing("Track In")
        self.available_input_routing_types = [Routing("All Ins"), Routing("Computer Keyboard"), Routing("No Input")]
        self.available_input_routing_channels = [Routing("All Channels"), Routing("Ch. 1")]
        self.available_output_routing_types = [Routing("Main"), Routing("Sends Only"), Routing("Bus"), Routing("Bus")]
        self.available_output_routing_channels = [Routing("Track In")]

    def create_audio_clip(self, path, position):
        self.arrangement_clips.append(types.SimpleNamespace(name=os.path.basename(path), start_time=position, end_time=position + 4.0, file_path=path))

    def stop_all_clips(self):
        self.stopped += 1
        self.fired_slot_index = -2


class SessionSong(Song):
    def __init__(self):
        super(SessionSong, self).__init__()
        self.tracks = [SessionTrack("Drums"), SessionTrack("Vox", midi=False), SessionTrack("Group")]
        self.tracks[2].is_foldable = True
        self.return_tracks = [SessionTrack("A-Reverb", sends=1)]
        self.return_tracks[0].can_be_armed = False
        self.master_track = types.SimpleNamespace(name="Main", mixer_device=mixer(0))
        self.scenes = [Scene("Intro"), Scene("Drop")]
        self.view = types.SimpleNamespace(selected_track=self.tracks[0], selected_scene=self.scenes[0])
        self.can_undo = True
        self.can_redo = False
        self.undo_log = []
        self.stop_all_calls = []

    def begin_undo_step(self):
        self.undo_log.append("begin")

    def end_undo_step(self):
        self.undo_log.append("end")

    def undo(self):
        self.undo_log.append("undo")
        self.can_redo = True

    def redo(self):
        self.undo_log.append("redo")

    def stop_all_clips(self, quantized=True):
        self.stop_all_calls.append(quantized)

    def create_scene(self, index):
        scene = Scene("")
        if index == -1:
            self.scenes.append(scene)
        else:
            self.scenes.insert(index, scene)
        return scene

    def duplicate_scene(self, index):
        source = self.scenes[index]
        self.scenes.insert(index + 1, Scene(source.name))

    def delete_scene(self, index):
        self.scenes.pop(index)

    def create_return_track(self):
        self.return_tracks.append(SessionTrack("C-Return", sends=len(self.return_tracks) + 1))

    def delete_return_track(self, index):
        self.return_tracks.pop(index)

    def duplicate_track(self, index):
        self.tracks.insert(index + 1, SessionTrack(self.tracks[index].name))


class SessionOpsTests(unittest.TestCase):
    def setUp(self):
        self.song = SessionSong()
        self.bridge = ControlDeckBridge.__new__(ControlDeckBridge)
        self.bridge.song = lambda: self.song
        self.bridge.application = lambda: types.SimpleNamespace(
            get_major_version=lambda: 12, get_minor_version=lambda: 4, get_bugfix_version=lambda: 16
        )

    def query(self, address, *args):
        return self.bridge._live_query({"address": address, "args": list(args)})["args"]

    def command(self, address, *args):
        return self.bridge._live_command({"address": address, "args": list(args)})

    def refused(self, address, *args):
        with self.assertRaises(Exception) as raised:
            self.command(address, *args)
        return str(raised.exception)

    # ---------------------------------------------------------------- mixer

    def test_reads_the_mixer_with_display_values_and_send_names(self):
        values = self.query("/live/mixer/get", "track", 0)
        self.assertEqual(values[:3], ["track", 0, "Drums"])
        self.assertIn("volumeDisplay", values)
        self.assertEqual(values[values.index("volumeDisplay") + 1], "0.0 dB")
        self.assertEqual(values[-5:], ["send", 0, 0.0, "-inf dB", "A-Reverb"])
        master = self.query("/live/mixer/get", "master", 0)
        self.assertNotIn("mute", master)
        self.assertEqual(master[master.index("sendCount") + 1], 0)

    def test_sets_volume_in_db_and_pan_mute_solo_arm_in_one_undo_step(self):
        self.command("/live/mixer/set", "track", 0, "Drums",
                     "volume_db", -1, -6.0, "panning", -1, -0.5, "mute", -1, True, "solo", -1, True, "arm", -1, True, "send_db", 0, -12.0)
        track = self.song.tracks[0]
        volume = track.mixer_device.volume
        self.assertEqual(volume.str_for_value(volume.value), "-6.0 dB")
        self.assertEqual(track.mixer_device.panning.value, -0.5)
        self.assertEqual((track.mute, track.solo, track.arm), (True, True, True))
        send = track.mixer_device.sends[0]
        self.assertEqual(send.str_for_value(send.value), "-12.0 dB")
        self.assertEqual(self.song.undo_log, ["begin", "end"])

    def test_minus_infinity_and_too_loud_volume(self):
        self.command("/live/mixer/set", "track", 0, "Drums", "volume_db", -1, "-inf")
        self.assertEqual(self.song.tracks[0].mixer_device.volume.value, 0.0)
        message = self.refused("/live/mixer/set", "track", 0, "Drums", "volume_db", -1, 12.0)
        self.assertIn("above 6 dB", message)

    def test_mixer_validates_every_change_before_applying_any(self):
        message = self.refused("/live/mixer/set", "track", 0, "Drums", "mute", -1, True, "send", 3, 0.5)
        self.assertIn("Send 3 does not exist", message)
        self.assertFalse(self.song.tracks[0].mute)

    def test_mixer_refuses_a_stale_name_and_impossible_targets(self):
        self.assertIn("found 'Drums'", self.refused("/live/mixer/set", "track", 0, "Bass", "mute", -1, True))
        self.assertIn("cannot be armed", self.refused("/live/mixer/set", "return", 0, "A-Reverb", "arm", -1, True))
        self.assertIn("no mute", self.refused("/live/mixer/set", "master", 0, "Main", "mute", -1, True))
        self.assertIn("index 0", self.refused("/live/mixer/set", "master", 1, "Main", "volume", -1, 0.5))
        self.command("/live/mixer/set", "return", 0, "A-Reverb", "mute", -1, True)
        self.assertTrue(self.song.return_tracks[0].mute)

    # ---------------------------------------------------------------- launching

    def test_fires_a_named_clip_and_refuses_an_empty_or_renamed_slot(self):
        slot = self.song.tracks[0].clip_slots[1]
        slot.clip = SessionClip("Beat")
        self.command("/live/clip_slot/fire", 0, 1, "Drums", "Beat")
        self.assertEqual(slot.fired, 1)
        state = self.query("/live/clip_slot/get/state", 0, 1)
        self.assertEqual(state, [0, 1, True, "Beat", False, True, False])
        self.assertIn("found 'Beat'", self.refused("/live/clip_slot/fire", 0, 1, "Drums", "Fill"))
        self.assertIn("No clip", self.refused("/live/clip_slot/fire", 0, 0, "Drums", "Beat"))
        self.assertEqual(slot.fired, 1)

    def test_fires_a_named_scene_stops_a_track_and_stops_all(self):
        self.command("/live/scene/fire", 1, "Drop")
        self.assertEqual(self.song.scenes[1].fired, 1)
        self.assertIn("found 'Drop'", self.refused("/live/scene/fire", 1, "Intro"))
        self.command("/live/track/stop_clips", 0, "Drums")
        self.assertEqual(self.song.tracks[0].stopped, 1)
        self.command("/live/song/stop_all_clips", False)
        self.assertEqual(self.song.stop_all_calls, [False])
        playback = self.query("/live/session/get/playback")
        self.assertEqual(playback[:4], [3, "Drums", -1, -2])
        self.assertEqual(playback[-3:], [2, False, True])

    # ---------------------------------------------------------------- scenes

    def test_creates_duplicates_and_deletes_scenes(self):
        self.command("/live/song/create_scene", -1, "Outro")
        self.assertEqual([scene.name for scene in self.song.scenes], ["Intro", "Drop", "Outro"])
        self.command("/live/song/duplicate_scene", 1, "Drop")
        self.assertEqual([scene.name for scene in self.song.scenes], ["Intro", "Drop", "Drop", "Outro"])
        self.assertIn("confirm=true", self.refused("/live/song/delete_scene", 0, "Intro", False))
        self.command("/live/song/delete_scene", 0, "Intro", True)
        self.assertEqual(len(self.song.scenes), 3)
        self.song.scenes = [Scene("Only")]
        self.assertIn("at least one scene", self.refused("/live/song/delete_scene", 0, "Only", True))

    def test_sets_scene_name_color_tempo_and_signature(self):
        self.command("/live/scene/set", 0, "Intro", "name", "Verse", None, "color", 0xFF0000, None, "tempo", 128.0, None, "signature", 7, 8)
        scene = self.song.scenes[0]
        self.assertEqual((scene.name, scene.color, scene.tempo, scene.tempo_enabled), ("Verse", 0xFF0000, 128.0, True))
        self.assertEqual((scene.time_signature_numerator, scene.time_signature_denominator, scene.time_signature_enabled), (7, 8, True))
        self.command("/live/scene/set", 0, "Verse", "tempo", None, None)
        self.assertFalse(scene.tempo_enabled)
        details = self.query("/live/song/get/scenes")
        self.assertEqual(details[:9], [2, "Verse", 0xFF0000, 128.0, False, 7, 8, True, False])
        self.assertIn("Denominator", self.refused("/live/scene/set", 0, "Verse", "signature", 4, 3))

    # ---------------------------------------------------------------- clips

    def test_reads_and_sets_clip_properties_with_safe_loop_ordering(self):
        self.song.tracks[0].clip_slots[0].clip = SessionClip("Beat")
        # Moving the loop to 8-12 needs the end set before the start.
        self.command("/live/clip/set", 0, 0, "Drums", "Beat",
                     "loop_start", 8.0, "loop_end", 12.0, "name", "Beat B", "launch_mode", 2, "launch_quantization", 5, "legato", True)
        values = self.query("/live/clip/get/properties", 0, 0)
        props = dict(zip(values[3::2], values[4::2]))
        self.assertEqual(values[2], "midi")
        self.assertEqual((props["loop_start"], props["loop_end"], props["name"]), (8.0, 12.0, "Beat B"))
        self.assertEqual((props["launch_mode"], props["launch_quantization"], props["legato"]), (2, 5, True))
        self.assertEqual(self.song.undo_log, ["begin", "end"])

    def test_clip_set_refuses_audio_fields_on_midi_and_bad_values(self):
        self.song.tracks[0].clip_slots[0].clip = SessionClip("Beat")
        self.assertIn("warping applies only to audio", self.refused("/live/clip/set", 0, 0, "Drums", "Beat", "warping", False))
        self.assertIn("after its start", self.refused("/live/clip/set", 0, 0, "Drums", "Beat", "loop_start", 4.0, "loop_end", 2.0))
        self.assertIn("Unknown clip field", self.refused("/live/clip/set", 0, 0, "Drums", "Beat", "file_path", "/tmp/x.wav"))
        self.assertEqual(self.song.tracks[0].clip_slots[0].clip.loop_start, 0.0)
        self.song.tracks[1].clip_slots[0].clip = SessionClip("Take", midi=False)
        self.command("/live/clip/set", 1, 0, "Vox", "Take", "pitch_coarse", -3, "warp_mode", 4, "gain", 0.5)
        clip = self.song.tracks[1].clip_slots[0].clip
        self.assertEqual((clip.pitch_coarse, clip.warp_mode, clip.gain), (-3, 4, 0.5))
        self.assertIn("not available", self.refused("/live/clip/set", 1, 0, "Vox", "Take", "warp_mode", 5))

    def test_duplicates_a_clip_only_into_an_empty_slot_of_the_same_type(self):
        self.song.tracks[0].clip_slots[0].clip = SessionClip("Beat")
        self.command("/live/clip_slot/duplicate_to", 0, 0, "Drums", "Beat", 2, 1, "Group")
        self.assertEqual(self.song.tracks[2].clip_slots[1].clip.name, "Beat")
        self.assertIn("already holds", self.refused("/live/clip_slot/duplicate_to", 0, 0, "Drums", "Beat", 2, 1, "Group"))
        self.assertIn("cannot go on track 'Vox'", self.refused("/live/clip_slot/duplicate_to", 0, 0, "Drums", "Beat", 1, 1, "Vox"))

    def test_deletes_a_clip_only_with_confirm(self):
        self.song.tracks[0].clip_slots[0].clip = SessionClip("Beat")
        self.assertIn("confirm=true", self.refused("/live/clip_slot/delete_clip", 0, 0, "Drums", "Beat", False))
        self.command("/live/clip_slot/delete_clip", 0, 0, "Drums", "Beat", True)
        self.assertIsNone(self.song.tracks[0].clip_slots[0].clip)

    # ---------------------------------------------------------------- undo

    def test_undo_and_redo_do_not_open_their_own_undo_step(self):
        self.command("/live/song/undo")
        self.command("/live/song/redo")
        self.assertEqual(self.song.undo_log, ["undo", "redo"])
        self.assertEqual(self.query("/live/song/get/undo_state"), [True, True])
        self.song.can_undo = False
        self.assertIn("nothing to undo", self.refused("/live/song/undo"))

    def test_existing_mutations_are_grouped_and_closed_on_failure(self):
        self.command("/live/song/set/tempo", 128.0)
        self.refused("/live/track/set/name", 9, "Nope")
        self.assertEqual(self.song.undo_log, ["begin", "end", "begin", "end"])

    def test_runs_without_grouping_on_a_live_without_undo_steps(self):
        self.song.begin_undo_step = None
        self.command("/live/song/set/tempo", 99.0)
        self.assertEqual(self.song.tempo, 99.0)

    # ---------------------------------------------------------------- tracks

    def test_sets_track_color_fold_and_routing_by_exact_name(self):
        self.command("/live/track/set", "track", 2, "Group", "color", 0x00FF00, "folded", True)
        self.assertEqual((self.song.tracks[2].color, self.song.tracks[2].fold_state), (0x00FF00, 1))
        self.command("/live/track/set", "track", 0, "Drums", "input_routing_type", "Computer Keyboard", "output_routing_type", "Sends Only")
        details = self.query("/live/track/get/details", "track", 0)
        props = dict(zip(details[3::2], details[4::2]))
        self.assertEqual((props["input_routing_type"], props["output_routing_type"]), ("Computer Keyboard", "Sends Only"))

    def test_track_routing_refusals_change_nothing(self):
        message = self.refused("/live/track/set", "track", 0, "Drums", "color", 0x0000FF, "input_routing_type", "Resampling")
        self.assertIn("Options: All Ins", message)
        self.assertEqual(self.song.tracks[0].color, 0)
        self.assertIn("More than one", self.refused("/live/track/set", "track", 0, "Drums", "output_routing_type", "Bus"))
        self.assertIn("not a group", self.refused("/live/track/set", "track", 0, "Drums", "folded", True))
        self.assertIn("no input routing", self.refused("/live/track/set", "master", 0, "Main", "input_routing_type", "All Ins"))

    def test_routing_channel_refused_after_its_type_puts_everything_back(self):
        track = self.song.tracks[0]
        message = self.refused("/live/track/set", "track", 0, "Drums", "color", 0xFF0000,
                               "input_routing_type", "Computer Keyboard", "input_routing_channel", "Ch. 9")
        self.assertIn("Ch. 9", message)
        self.assertEqual((track.color, track.input_routing_type.display_name), (0, "All Ins"))
        self.assertEqual(self.song.undo_log, ["begin", "end"])

    def test_return_track_cannot_send_to_itself(self):
        self.assertIn("cannot send to itself", self.refused("/live/mixer/set", "return", 0, "A-Reverb", "send", 0, 0.5))
        self.assertEqual(self.song.return_tracks[0].mixer_device.sends[0].value, 0.0)

    def test_single_loop_or_marker_value_is_checked_against_the_other_end(self):
        self.song.tracks[0].clip_slots[0].clip = SessionClip("Beat")
        self.assertIn("before the current end 4", self.refused("/live/clip/set", 0, 0, "Drums", "Beat", "name", "X", "start_marker", 6.0))
        self.assertIn("after the current start 0", self.refused("/live/clip/set", 0, 0, "Drums", "Beat", "loop_end", 0.0))
        self.assertEqual(self.song.tracks[0].clip_slots[0].clip.name, "Beat")

    def test_clip_change_refused_partway_puts_back_what_it_changed(self):
        clip = StrictClip("Beat")
        self.song.tracks[0].clip_slots[0].clip = clip
        self.refused("/live/clip/set", 0, 0, "Drums", "Beat", "name", "X", "muted", True, "loop_start", 8.0, "loop_end", 12.0, "end_marker", 8.0)
        self.assertEqual((clip.name, clip.muted, clip.loop_start, clip.loop_end, clip.end_marker), ("Beat", False, 0.0, 4.0, 4.0))

    # ---------------------------------------------------------------- session clip notes

    def test_reads_modifies_and_removes_session_clip_notes(self):
        clip = NoteClip("Beat", [(36, 0.0), (38, 1.0), (42, 1.5)])
        self.song.tracks[0].clip_slots[0].clip = clip
        listed = self.query("/live/session_clip/get/notes", 0, 0)
        self.assertEqual(listed[:3], [0, 0, "Beat"])
        self.assertEqual(listed[3:9], [36, 0.0, 0.5, 100.0, False, 1])
        self.command("/live/session_clip/modify/notes", 0, 0, "Drums", "Beat", 2, 40, 1.0, 0.25, 90, False)
        self.assertIs(clip.last_applied, clip.last_vector)
        self.assertEqual((clip._notes[1].pitch, clip._notes[1].duration, clip._notes[1].velocity), (40, 0.25, 90.0))
        self.command("/live/session_clip/remove/notes", 0, 0, "Drums", "Beat", 40, 3, 1.0, 1.0)
        self.assertEqual([note.pitch for note in clip._notes], [36])
        self.assertEqual(self.song.undo_log, ["begin", "end", "begin", "end"])

    def test_session_note_refusals(self):
        self.song.tracks[0].clip_slots[0].clip = NoteClip("Beat", [(36, 0.0)])
        self.assertIn("found 'Beat'", self.refused("/live/session_clip/modify/notes", 0, 0, "Drums", "Fill", 1, 40, 0.0, 1.0, 90, False))
        self.assertIn("No note with id 9", self.refused("/live/session_clip/modify/notes", 0, 0, "Drums", "Beat", 9, 40, 0.0, 1.0, 90, False))
        self.assertIn("No notes start", self.refused("/live/session_clip/remove/notes", 0, 0, "Drums", "Beat", 60, 1, 0.0, 4.0))
        self.song.tracks[1].clip_slots[0].clip = SessionClip("Take", midi=False)
        with self.assertRaises(Exception) as raised:
            self.query("/live/session_clip/get/notes", 1, 0)
        self.assertIn("not MIDI", str(raised.exception))

    # ---------------------------------------------------------------- return tracks

    def test_creates_and_deletes_return_tracks(self):
        self.command("/live/song/create_return_track", "Plate")
        self.assertEqual([track.name for track in self.song.return_tracks], ["A-Reverb", "Plate"])
        self.command("/live/song/create_return_track")
        self.assertEqual(len(self.song.return_tracks), 3)
        self.assertIn("confirm", self.refused("/live/song/delete_return_track", 1, "Plate", False))
        self.assertIn("found 'Plate'", self.refused("/live/song/delete_return_track", 1, "Delay", True))
        self.command("/live/song/delete_return_track", 1, "Plate", True)
        self.assertEqual([track.name for track in self.song.return_tracks], ["A-Reverb", "C-Return"])
        while len(self.song.return_tracks) < 12:
            self.song.return_tracks.append(SessionTrack("Extra"))
        self.assertIn("at most 12", self.refused("/live/song/create_return_track"))

    # ---------------------------------------------------------------- samples

    def sample_file(self, name="kick.wav"):
        directory = tempfile.mkdtemp()
        path = os.path.join(directory, name)
        with open(path, "wb") as handle:
            handle.write(b"RIFF")
        self.addCleanup(lambda: (os.remove(path), os.rmdir(directory)))
        return path

    def test_loads_a_sample_into_an_empty_audio_slot(self):
        path = self.sample_file()
        self.command("/live/clip_slot/load_sample", 1, 0, "Vox", path, "Kick A")
        clip = self.song.tracks[1].clip_slots[0].clip
        self.assertEqual((clip.name, clip.file_path), ("Kick A", os.path.realpath(path)))
        values = self.query("/live/clip/get/properties", 1, 0)
        self.assertIn("file_path", values)
        self.assertEqual(self.song.undo_log, ["begin", "end"])

    def test_sample_loading_refusals(self):
        path = self.sample_file()
        self.assertIn("MIDI track", self.refused("/live/clip_slot/load_sample", 0, 0, "Drums", path))
        self.assertIn("group track", self.refused("/live/clip_slot/load_sample", 2, 0, "Group", path))
        self.assertIn("found 'Vox'", self.refused("/live/clip_slot/load_sample", 1, 0, "Bass", path))
        self.assertIn("absolute", self.refused("/live/clip_slot/load_sample", 1, 0, "Vox", "kick.wav"))
        self.assertIn("one of", self.refused("/live/clip_slot/load_sample", 1, 0, "Vox", self.sample_file("notes.txt")))
        self.assertIn("No file", self.refused("/live/clip_slot/load_sample", 1, 0, "Vox", path + ".missing.wav"))
        self.song.tracks[1].clip_slots[1].clip = SessionClip("Take", midi=False)
        self.assertIn("already holds", self.refused("/live/clip_slot/load_sample", 1, 1, "Vox", path))
        original = LaunchSlot.create_audio_clip
        del LaunchSlot.create_audio_clip
        try:
            self.assertIn("needs Live 12", self.refused("/live/clip_slot/load_sample", 1, 0, "Vox", path))
        finally:
            LaunchSlot.create_audio_clip = original

    def test_loads_a_sample_into_the_arrangement(self):
        path = self.sample_file()
        self.command("/live/track/load_sample_to_arrangement", 1, "Vox", path, 8.0)
        clip = self.song.tracks[1].arrangement_clips[0]
        self.assertEqual((clip.start_time, clip.file_path), (8.0, os.path.realpath(path)))
        self.assertIn("from 0 to", self.refused("/live/track/load_sample_to_arrangement", 1, "Vox", path, -1.0))
        self.assertIn("from 0 to", self.refused("/live/track/load_sample_to_arrangement", 1, "Vox", path, 1e9))

    def test_replaces_a_simpler_sample_by_name(self):
        path = self.sample_file()
        replaced = []
        simpler = types.SimpleNamespace(name="Simpler", class_name="OriginalSimpler", sample=types.SimpleNamespace(file_path="/old.wav"),
                                        replace_sample=lambda file: (replaced.append(file), setattr(simpler.sample, "file_path", file)))
        self.song.tracks[0].devices = [types.SimpleNamespace(name="EQ Eight", class_name="Eq8"), simpler]
        self.assertEqual(self.query("/live/device/get/sample", 0, "Drums", 1, "Simpler"), [0, 1, "Simpler", "/old.wav"])
        self.command("/live/device/replace_sample", 0, "Drums", 1, "Simpler", path)
        self.assertEqual(replaced, [os.path.realpath(path)])
        self.assertIn("not Simpler", self.refused("/live/device/replace_sample", 0, "Drums", 0, "EQ Eight", path))
        self.assertIn("found 'Simpler'", self.refused("/live/device/replace_sample", 0, "Drums", 1, "Sampler", path))

    # ---------------------------------------------------------------- devices

    def device(self, name, switch=True):
        parameters = [Parameter("Device On", 1.0, 0.0, 1.0)] if switch else [Parameter("Macro 1", 0.0)]
        return types.SimpleNamespace(name=name, class_name="Eq8", parameters=parameters)

    def test_reads_and_switches_devices_on_and_off(self):
        track = self.song.tracks[0]
        track.devices = [self.device("EQ Eight"), self.device("Odd", switch=False)]
        self.assertEqual(self.query("/live/devices/get/state", "track", 0), ["track", 0, "Drums", 2, "EQ Eight", "Eq8", True, "Odd", "Eq8", None])
        self.command("/live/device/set_enabled", "track", 0, "Drums", 0, "EQ Eight", False)
        self.assertEqual(track.devices[0].parameters[0].value, 0.0)
        self.assertIn("no on/off switch", self.refused("/live/device/set_enabled", "track", 0, "Drums", 1, "Odd", False))
        self.assertIn("found 'EQ Eight'", self.refused("/live/device/set_enabled", "track", 0, "Drums", 0, "Reverb", True))
        self.song.return_tracks[0].devices = [self.device("Reverb")]
        self.command("/live/device/set_enabled", "return", 0, "A-Reverb", 0, "Reverb", False)
        self.assertEqual(self.song.return_tracks[0].devices[0].parameters[0].value, 0.0)

    def test_deletes_a_device_only_with_confirm(self):
        track = self.song.tracks[0]
        track.devices = [self.device("EQ Eight"), self.device("Compressor")]
        track.delete_device = lambda index: track.devices.pop(index)
        self.assertIn("confirm", self.refused("/live/device/delete", "track", 0, "Drums", 1, "Compressor", False))
        self.assertIn("does not exist", self.refused("/live/device/delete", "track", 0, "Drums", 5, "Compressor", True))
        self.command("/live/device/delete", "track", 0, "Drums", 1, "Compressor", True)
        self.assertEqual([device.name for device in track.devices], ["EQ Eight"])

    # ---------------------------------------------------------------- selection

    def test_reads_selection_of_a_track_scene_and_clip(self):
        self.song.tracks[0].clip_slots[1].clip = SessionClip("Fill")
        self.song.view.selected_scene = self.song.scenes[1]
        self.assertEqual(self.query("/live/view/get/selection"), ["track", 0, "Drums", 1, "Drop", True, "Fill"])
        self.song.view.selected_track = self.song.return_tracks[0]
        self.assertEqual(self.query("/live/view/get/selection")[:3], ["return", 0, "A-Reverb"])
        self.song.view.selected_track = self.song.master_track
        self.assertEqual(self.query("/live/view/get/selection")[:3], ["master", 0, "Main"])

    def test_selects_a_track_a_scene_or_both_without_an_undo_step(self):
        self.command("/live/view/select", "track", 1, "Vox", 1, "Drop")
        self.assertEqual((self.song.view.selected_track.name, self.song.view.selected_scene.name), ("Vox", "Drop"))
        self.command("/live/view/select", "return", 0, "A-Reverb", -1, "")
        self.assertEqual((self.song.view.selected_track.name, self.song.view.selected_scene.name), ("A-Reverb", "Drop"))
        self.command("/live/view/select", None, 0, "", 0, "Intro")
        self.assertEqual(self.song.view.selected_scene.name, "Intro")
        self.assertEqual(self.song.undo_log, [])
        self.assertIn("found 'Vox'", self.refused("/live/view/select", "track", 1, "Bass", -1, ""))
        self.assertIn("found 'Drop'", self.refused("/live/view/select", None, 0, "", 1, "Outro"))
        self.assertIn("track, a scene", self.refused("/live/view/select", None, 0, "", -1, ""))

    # ---------------------------------------------------------------- meters

    def test_reads_every_meter_in_one_reply(self):
        self.song.is_playing = True
        drums = self.song.tracks[0]
        drums.output_meter_left, drums.output_meter_right, drums.output_meter_level = 0.921, 0.842, 0.95
        drums.mute = True
        self.song.master_track.output_meter_left = 0.5
        values = self.query("/live/meters/get")
        self.assertEqual(values[:2], [True, 5])
        self.assertEqual(values[2:10], ["track", 0, "Drums", 0.921, 0.842, 0.95, True, True])
        master = values[2 + 4 * 8:]
        self.assertEqual(master[:4], ["master", 0, "Main", 0.5])
        self.assertEqual(self.song.undo_log, [])

    def test_lists_routing_options(self):
        values = self.query("/live/track/get/routing_options", "track", 0)
        self.assertEqual(values[:6], ["track", 0, "Drums", "input_routing_type", 3, "All Ins"])

    def test_duplicates_a_named_track(self):
        self.command("/live/song/duplicate_track", 0, "Drums")
        self.assertEqual([track.name for track in self.song.tracks], ["Drums", "Drums", "Vox", "Group"])
        self.assertIn("found 'Vox'", self.refused("/live/song/duplicate_track", 2, "Drums"))


if __name__ == "__main__":
    unittest.main()
