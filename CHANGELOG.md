# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

The bridge secret now lives per machine, outside the install and outside Live's User Library (which is often synced): Application Support on macOS, `%LOCALAPPDATA%` on Windows. Setup moves an existing `data/bridge-token` there unchanged, and the remote script no longer has the secret written into it. After updating, run setup and restart Live.

In Live 12.4.16 view switching passed: to the Arrangement, the clip editor, the device chain with the Browser, back to Session with the Detail view hidden, refusal of an empty request, no undo step added, and the window restored afterwards.

Also in Live 12.4.16, clip automation passed on a Drift track: a volume ramp from silence to full (65 steps, all read back), A-Reverb send steps at −inf, −12, and −6 dB, an LP Freq ramp up and back down (97 steps), listing the three automated parameters, clearing one envelope and then all of them, and refusal of an out-of-range value, a point past the clip end, a stale parameter name, and clearing all without confirmation.

### Added

- A signed, notarized macOS installer package (`npm run build:pkg`) with Node.js 26.13.0 for Apple silicon and Intel, checked against nodejs.org's checksums and signature. A newer Homebrew Node.js is used when present. Settings, indexes, snapshots, and logs go in `~/Library/Application Support/Ableton Control Deck`, and the program stays read-only. **Uninstall Ableton Control Deck** removes the services, the remote script, the OmniHost device, and the program, and either keeps settings and snapshots or removes everything. Tested on macOS: install, a bridge round trip with Live 12.4.16, and both uninstall choices.
- A signed Windows installer (`npm run build:win`) for x64 and Arm64, with Node.js 26.13.0 for the PC's own architecture, checked against nodejs.org's checksums and its OpenJS Foundation signature. It installs for the signed-in user with no administrator prompt, adds a Start menu entry for the dashboard, and is listed in Installed apps, where uninstalling asks whether to keep settings and snapshots. Tested on an i7 desktop and a Snapdragon Surface: install, update over an existing install, and both uninstall choices.
- `npm run uninstall` does the same for a checkout.
- Setup on Windows also stops a service left running by another copy of Control Deck (a checkout or an older install), so the new one gets its port.
- Windows support (Windows 10 and 11, x64 and Arm64): `Install Ableton Control Deck.cmd`, plug-in folders, the User Library from Live's own settings (including Documents in OneDrive), and two Task Scheduler services that start at sign-in, run without a window, and restart if they stop. Tested on an i7 desktop and a Snapdragon Surface.

- `get_view` and `show_view` read and switch Live's main view (Session or Arrangement), show the clip editor or device chain or hide the Detail view, and show or hide the Browser. Switching is not an undo step.
- `write_clip_automation`, `get_clip_automation`, and `clear_clip_automation` draw, read, and clear automation inside a Session clip for its track's volume, pan, or sends, or any device parameter by path. Points become steps or ramps, volume and sends take dB, long ramps are split into commands that fit one datagram, and every step is read back.

## [1.4.0] - 2026-11-09

Selection, racks and drum pads, and level meters with a mix check. 118 tools, up from 107. After updating, run `npm run setup` and restart Live.

Meters were calibrated in Live 12.4.16 with 1 kHz tones at 0, −6, −12, −18, −24, and −36 dBFS. A mix check on a planted mix flagged all four problems: a 0 dBFS tone with its fader at +4 dB peaking at +4.0 dB, a MIDI track with no instrument playing a clip, a −24 dBFS tone panned hard left (reading −21 dB, from the +3 dB pan law), and the same track sitting 25 dB below the loudest. It also refused to run while Live was stopped.

In Live 12.4.16 these passed, on Strutter Kit (a Drum Rack inside an Instrument Rack) and Drum Buss Grand: muting and soloing pads in the nested Drum Rack; renaming and muting a chain; an outer macro; a parameter on a device three racks deep (path `0/0/0/0/0`); recalling, storing, deleting, and randomizing variations; refusal of a stale pad name and a non-rack path; and every rack read back exactly as it started. Also: selecting a return track, the master, and a track with a scene; refusal of a stale track name and a missing scene; `get_live_set` with a return track selected; and no undo step added by selecting.

### Added

- `get_selection` reads the selected track (including a return track or the master), scene, and clip. `select` selects a track, a scene, or both by index and current name and reads the selection back. Selecting is not an undo step.

- `get_meters` reads every track's, return track's, and the master's level in dB. `mix_check` samples the meters while Live plays and flags clipping, low master headroom, a track playing a clip with no sound, lopsided panning, and tracks buried 24 dB or more below the loudest. Meter values are converted with a calibration measured in Live 12.4.16.
- Racks: `get_rack`, `get_device_parameters_at_path`, `set_device_parameter_at_path`, `set_rack_macros`, `set_rack_chain`, `set_drum_pad`, and `rack_variation`. A device inside a rack is addressed by a path such as `0/2/1`, and every change checks the names along the way and reads the result back.

### Changed

- `set_clip` refuses `looping: true` on an unwarped audio clip unless the same call turns warping on. Live ignores looping on an unwarped clip, which used to surface as a failed read-back.
- `find_live_device` and `load_live_device` find factory presets such as kits and effect racks without their file extension (`Strutter Kit` as well as `Strutter Kit.adg`). An exact name still wins, so `Drift` is the device.

### Fixed

- `get_live_set` returned scenes nested twice (`scenes.scenes`). `scenes` is now the scene list. It also adds `selection`, which still names the selected track when it is a return track or the master. `selectedTrack` is `null` in that case instead of missing.

## [1.3.0] - 2026-11-09

Mixer control and return tracks, Session launching, scenes, clip properties and notes, undo, track routing, sample loading, device on/off and delete, and batched note writes. 107 tools, up from 75. Tested with Ableton Live 12.4.16. After updating, run `npm run setup` and restart Live so it loads the new remote script, which adds `session_ops.py`.

In Live 12.4.16 these all passed:
- dB volume at -6, -18.5, +6, and -inf, with +12 refused
- pan, mute, solo, arm, and a send
- return track mute, and master volume
- one undo reverting a three-value mix change, and redo reapplying it
- scene create, color, tempo, 7/8, rename, duplicate, and delete
- MIDI clip name, color, launch mode and quantization, legato, loop moves in both directions, markers, looping, and mute
- clip duplicate, plus refusal of an occupied slot
- clip and scene launch, stopping one track, and stopping all
- track color, input and output routing by name, and duplicate track
- refusal of stale names and missing confirmation
- play, stop, continue, and playhead moves leave no empty undo steps, so one undo after them still reverts the last real change
- audio clip gain (shown as Live's dB display), transpose from -12 to +7, detune, every warp mode tried (complex, re-pitch, texture, beats), and warping off, with out-of-range gain and transpose refused
- folding and unfolding a group track, with folding a non-group track refused
- devices: listing with on/off state on a track, a return track, and the master (including a plug-in), turning EQ Eight off with one undo turning it back on, deleting a device with the chain read back, and refusal of a stale device name and a missing confirmation
- sample loading: into a Session slot (with and without a clip name), onto the Arrangement, and into an empty and a loaded Simpler; refusal of an occupied slot, a MIDI track, a start inside a clip, and a stale device name; a sample that would cover an existing clip undone with the clip restored; and Live's renaming of the track and Simpler after the sample reported
- Session clip notes: read with ids, change by id (pitch by name, velocity, length), remove a range, one undo restoring removed notes, and refusal of an unknown id, a stale clip name, and an empty range
- return tracks: create with a name (Live reads it back with its letter, such as `C-CD Return`), a send added to every track, delete with confirmation, and the later returns moving up a letter

Still unchecked: REX and Complex Pro warp modes, and tracks nested more than one group deep.

### Added

- `get_mixer` and `set_track_mix` read and set volume, pan, mute, solo, arm, and sends on tracks, return tracks, and the master. Volume and sends take dB, which the bridge matches to Live's own display. All changes in one call are checked before any is applied.
- `fire_clip`, `stop_track_clips`, `fire_scene`, `stop_all_clips`, and `get_session_playback` launch and stop Session clips and scenes, and read back whether each is queued, playing, or stopping.
- `create_scene`, `duplicate_scene`, `delete_scene`, and `set_scene` manage scenes, including scene tempo and time signature. Deleting needs `confirm: true`, and the last scene is refused.
- `get_clip` and `set_clip` read and change Session clip loop, markers, launch mode and quantization, legato, mute, color, and audio gain, transpose, detune, and warp. `duplicate_clip` copies into an empty slot of a matching track. `delete_clip` needs `confirm: true`.
- `get_clip_notes`, `modify_clip_notes`, and `remove_clip_notes` read and edit notes in Session MIDI clips by note id, matching the Arrangement note tools.
- `load_sample_to_clip_slot`, `load_sample_to_arrangement`, and `replace_simpler_sample` load an audio file, by `sampleId` from `search_samples` or by path, into a Session slot, the Arrangement, or a Simpler device. A load that would trim an existing Arrangement clip is undone and refused. Needs Live 12.
- `get_devices`, `set_device_enabled`, and `delete_device` list a track's devices with their on/off state, switch a device on or off, and delete one with `confirm: true`. They work on tracks, return tracks, and the master.
- `get_clip` shows an audio clip's file.
- `create_return_track` and `delete_return_track`. Deleting needs `confirm: true`.
- `undo`, `redo`, and `get_undo_state`. The result warns that Live's most recent step may be a change made by hand.
- `get_track_routing`, `set_track`, and `duplicate_track` set track color, fold group tracks, set input and output routing by exact name, and duplicate a track.
- `set_clip`, `set_track`, and `set_scene` return `colorSnapped: true` when Live snaps the requested color to a different palette color.
- `set_clip` lists any setting Live changed on its own in `alsoChangedByLive`. Turning warping off makes Live turn looping off and move the loop end. It also names the valid choices when a launch mode, quantization, or warp mode is unknown.
- The local dashboard shows a quiet footer on every page with the version, “Built by Remy Mazmanian”, and a link to remymazmanian.com.
- The MCP server, the local status service, and the dashboard footer read their version from the root `package.json`. A check fails if the remote script, the macOS wrapper, the dashboard package, or the documented bridge log line disagree with that version.

### Changed

- Large note writes are split into ordered batches that each fit one UDP datagram, so `add_midi_notes`, `add_arrangement_clip_notes`, `modify_arrangement_clip_notes`, and `modify_clip_notes` accept up to 10000 notes (256 for `modify_clip_notes`). macOS refuses a datagram near 9 KB. A request that is still too large fails with `REQUEST_TOO_LARGE`, and a batch that fails partway says how many notes already landed.
- `add_midi_notes` reads the clip back and fails with `NOTE_VERIFICATION_FAILED`, naming the missing notes, unless every requested note is there. Before, it returned the raw reply without checking it.
- The bridge's status lists `sample-loading` and `device-control` among its capabilities.
- Bridge errors for a missing track, scene, device, or parameter now name the index.
- Dry runs of `set_track_mix` and `set_clip` now report what the real call would refuse: a send or field the track lacks, volume above +6 dB or a send above 0 dB, arming a track that cannot be armed, and audio-only settings on a MIDI clip.
- `set_track` and `set_clip` put back what they changed when Live refuses a value partway through, such as a routing channel that does not exist for the new routing type.
- A return track can no longer be set to send to itself.
- Every bridge mutation now runs inside one Live undo step (`Song.begin_undo_step` / `end_undo_step`), so one Cmd-Z reverts one Control Deck command. `set_time_signature` and `add_locator` send two commands and take two undos. Undo and redo themselves are not wrapped.
- `list_scenes` adds each scene's color, tempo, time signature, and triggered state. With an older installed remote script it falls back to names and says to rerun setup.

## [1.2.0] - 2026-10-31

Arrangement MIDI clips, Arrangement note editing, and User Library loading. Tested with Ableton Live 12.4.16. After updating, restart Live so it loads the new remote script.

In Live 12.4.16 these all passed: arrangement clip creation, name-mismatch and audio-track refusals, note add/get/modify/remove, overlap refusal with touching clips allowed, .vstpreset refusal, and loading a unique User Library .adv. Still unchecked: frozen tracks, recording into a track, audio-clip note refusal, a duplicate User Library name, and a Pigments or Serum 2 rack.

### Added

- `create_arrangement_midi_clip` creates an empty MIDI clip in the Arrangement with `Track.create_midi_clip(start_time, length)` on Live 12.1.10 or newer. It checks the track index and current name, then reads the clip back. Older Live versions fail with a message that names the running version.
- `get_arrangement_clip_notes`, `add_arrangement_clip_notes`, `modify_arrangement_clip_notes`, and `remove_arrangement_clip_notes` read and edit notes on an Arrangement MIDI clip. The clip is addressed by track plus clip index or start time. Every write reads the notes back.
- `load_user_library_item` loads a User Library item, such as a saved Instrument Rack (`.adg`) or device preset (`.adv`), onto an exact track by exact name. Ambiguous names are refused. The device chain is read back. A filesystem path, including `.vstpreset` and `.aupreset`, is refused.

### Fixed

- `modify_arrangement_clip_notes` passes the note vector from `get_notes_extended` to `Clip.apply_note_modifications`. Live 12.4.16 rejects a tuple.
- `create_arrangement_midi_clip` refuses an overlapping range before calling Live, and names the clip already there. Live 12.4 trims the existing clip instead of raising, so the bridge must not create in that case.

### Changed

- `list_arrangement_clips` now includes each clip's index, length, and whether it is MIDI or audio.
- Documented limits stay in place for what the API still cannot do: arrangement automation, saving the Live Set, and rendering. Arrangement MIDI clip creation is available on Live 12.1.10 and newer.

## [1.1.0] - 2026-10-11

Adds Arrangement tools: locators and clips. Tested with Ableton Live 12.4.6. After updating, restart Live so it loads the new remote script.

### Added

- `list_locators`, `add_locator` and `delete_locator` for Arrangement locators (cue points). Adding a locator at a position that already has one renames it. Live adds and removes locators at the playhead, so these need playback stopped. They move the playhead, wait until Live confirms it's there, make the change, then put the playhead back.
- `list_arrangement_clips` lists a track's Arrangement clips with start and end in beats.
- `place_clip_in_arrangement` copies a Session View clip into the Arrangement, tiled back to back over a beat range, and confirms the copies. Each copy is the full clip, so the last one can run past the end of the range. It refuses ranges that would need more than 512 copies.
- `clear_arrangement_track` deletes every Arrangement clip on one track. It needs `confirm=true`.
- Tests for the new tools, `SECURITY.md`, and CI that type-checks, checks the remote script compiles, and runs the tests on every push and pull request.

## [1.0.0] - 2026-08-18

First release of Ableton Control Deck, a local MCP bridge that lets an SI agent control Ableton Live on your Mac and checks its changes against what Live reports. It needs macOS 13 or newer, Ableton Live 11 or newer and Node.js 20 or newer.

### Added

- One-step installer, `Install Ableton Control Deck.command`, that sets up the bridge, the Live remote script and the background services, then opens a connection guide. It is safe to run again at any time.
- Transport control for play, stop, continue, tempo, time signature, song position, metronome and Arrangement recording, with each change read back from Live.
- Track tools to list, create, rename and delete MIDI and audio tracks. Deleting a track needs an explicit confirmation, and most changes can first be run as a dry run that reports what would happen without touching Live.
- Session View MIDI clips with validated note content, plus read access to the Live Set, scenes, clips, the current selection, devices and every parameter Live exposes.
- Plug-in and device loading by exact Browser name on an exact track, for VST3, VST2 and Audio Unit plug-ins and for native Live devices such as Drum Rack, Echo and Reverb. Ambiguous names are refused.
- Third-party plug-in parameters read and set with normalized values and read-back.
- Control Deck OmniHost, an optional Max for Live device that hosts a VST3 instrument and exposes its full parameter list, beyond what Live's device panel shows. The included device is set up for Arturia Mini V4.
- Sample search over an optional local index of an external sample drive, by keyword, folder, BPM, key, duration, one-shot or loop, and tags. The indexer never copies, moves or changes your audio files.
- Local dashboard at `http://127.0.0.1:50713` showing bridge health, the current Live session, the selected track's devices and a searchable inventory of installed plug-ins. Its Connect page has copy-paste setup guides for Claude Code, Codex, Cursor, VS Code, Gemini CLI, local LLM setups and other MCP clients.
- Local operation: the Live bridge, status service and dashboard listen on this Mac only, requests to the Live bridge must carry a secret generated for your install, and requests are logged locally to `logs/control-deck.jsonl`.

[Unreleased]: https://github.com/remymazmanian/ableton-control-deck/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/remymazmanian/ableton-control-deck/releases/tag/v1.4.0
[1.3.0]: https://github.com/remymazmanian/ableton-control-deck/releases/tag/v1.3.0
[1.2.0]: https://github.com/remymazmanian/ableton-control-deck/releases/tag/v1.2.0
[1.1.0]: https://github.com/remymazmanian/ableton-control-deck/releases/tag/v1.1.0
[1.0.0]: https://github.com/remymazmanian/ableton-control-deck/releases/tag/v1.0.0
