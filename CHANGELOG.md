# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/remymazmanian/ableton-control-deck/compare/v1.2.0...HEAD
[1.2.0]: https://github.com/remymazmanian/ableton-control-deck/releases/tag/v1.2.0
[1.1.0]: https://github.com/remymazmanian/ableton-control-deck/releases/tag/v1.1.0
[1.0.0]: https://github.com/remymazmanian/ableton-control-deck/releases/tag/v1.0.0
