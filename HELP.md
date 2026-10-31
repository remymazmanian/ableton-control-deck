# Ableton Control Deck — Help & Reference

Everything about installing, using, troubleshooting, and understanding Ableton Control Deck. For a quick start, see the [README](README.md); this file is the complete reference.

---

## Contents

1. [What Control Deck is](#what-control-deck-is)
2. [Compatibility](#compatibility)
3. [The pieces, in plain language](#the-pieces-in-plain-language)
4. [Installing](#installing)
5. [Setting up Live](#setting-up-live)
6. [Everyday use](#everyday-use)
7. [The dashboard](#the-dashboard)
8. [Connecting SI agents](#connecting-si-agents)
9. [MCP tool reference](#mcp-tool-reference)
10. [OmniHost](#omnihost)
11. [The sample index](#the-sample-index)
12. [Files and locations](#files-and-locations)
13. [Troubleshooting](#troubleshooting)
14. [Uninstalling](#uninstalling)
15. [Security model](#security-model)
16. [Known limitations](#known-limitations)
17. [FAQ](#faq)

---

## What Control Deck is

Ableton Control Deck lets an SI agent operate Ableton Live the way a careful engineer would: every action names its exact target, ambiguous requests are refused, and every change is read back from Live before being reported as done. It speaks the [Model Context Protocol](https://modelcontextprotocol.io) (MCP), the open standard used by Claude Code, Claude Desktop, Codex, Cursor, Gemini CLI, and most other SI agents — including fully local LLM setups.

It is not a remote-control surface or a cloud service. It can load a User Library rack by exact name, and it cannot load a preset file from disk. It is a precision bridge between an agent's intent and Live's remote-script API, plus a local dashboard for watching what's happening.

## Compatibility

**Supported today: macOS only.**

| Requirement | Minimum |
|---|---|
| macOS | 13 Ventura or newer (Apple silicon and Intel) |
| Ableton Live | 11 or newer (tested target: Live 12). Arrangement MIDI clip creation needs 12.1.10 or newer and fails clearly on older versions. |
| Node.js | 20 or newer |
| Max for Live | optional — only for the OmniHost device |
| Xcode Command Line Tools | optional — only for the native wrapper app |

The macOS-specific parts are the service autostart (launchd), the plug-in scanner's folder paths, and the remote-script install path. The core — the remote script, the MCP server, the UDP protocol, and the dashboard — is platform-neutral, because Live's remote-script API and Node.js both run everywhere. **Linux and Windows are not supported yet**, but the port is well understood and modestly sized; see [PORTING.md](PORTING.md) if you'd like to help.

## The pieces, in plain language

Control Deck is one folder containing five cooperating parts:

1. **The remote script** (`remote-script/Control_Deck/`) — a Live Control Surface script that runs *inside* Ableton Live. It listens on local UDP port `50711` for authenticated requests and is the only thing that actually touches your Live Set. Installed into Live's User Library by setup with your private secret stamped in.
2. **The MCP server** (`src/`, compiled to `dist/`) — the part your SI agent talks to. Each agent launches its own copy on demand (stdio; it is not a background service) and it relays requests to the remote script.
3. **The status API** (`src/dashboard-server.mjs`) — a small read-only web service on `127.0.0.1:50712` that reports bridge health, session state, and the plug-in inventory. Runs at login.
4. **The dashboard** (`dashboard/`) — the Control Deck web UI on `127.0.0.1:50713`. Runs at login.
5. **OmniHost** (`max-for-live/`) — optional. A Max for Live instrument that hosts a VST3 synth inside Max's `vst~` object and exposes its complete published parameter catalog on UDP `50714`, far beyond the parameters Live shows in its device panel. See [OmniHost](#omnihost).

The optional **wrapper app** (`Ableton Control Deck.app`, built by `npm run build:macos`) is a native window showing the dashboard — pure convenience; a browser tab is equivalent. It blocks all navigation away from the local dashboard address.

There is also an optional **sample index** (`src/sample-index.ts`) — a local SQLite catalog of an external sample drive, searchable by the `search_samples` tool. See [The sample index](#the-sample-index).

## Installing

Two equivalent paths; both are safe to re-run at any time.

**No coding required:** follow the five-step Quickstart in the [README](README.md#quickstart-no-coding-required) — install Node.js, download and move the folder somewhere permanent, right-click **Install Ableton Control Deck.command** → Open, enable the Control Surface in Live, connect your agent.

**Developers:** `npm run setup` runs the same engine: dependency installs, TypeScript + OmniHost + dashboard builds, secret generation, remote-script install, and launchd agents (written and activated). Flags: `--skip-build`, `--skip-remote-script`, `--skip-agents`. Granular scripts remain (`build`, `build:omnihost`, `install:omnihost`, `index:plugins`, `samples:index`, dashboard `dev`/`build`/`check`).

Setup guards the common traps: it refuses to run from Downloads/Desktop (services would break when you move the folder), detects a moved checkout and refreshes everything, and ends failed runs with what to fix.

## Setting up Live

Setup installs the remote script into Live's default User Library location (`~/Music/Ableton/User Library/Remote Scripts/Control_Deck/`), so Live can already see it. Then:

1. In Live, open **Settings** (Live → Settings, or `⌘,`) → **Link, Tempo & MIDI**.
2. In a free **Control Surface** slot, choose **Control Deck**. Leave the Input and Output ports set to **None** — the bridge communicates over local UDP, not MIDI.
3. If Live was already open while setup ran, restart Live once (or re-select the Control Surface) so it loads the freshly stamped script.

**Verifying and reloading.** The dashboard's Deck page flips to "Live is linked." the moment the bridge is up — that's the quickest end-to-end check. Live's own log (`Log.txt`) records `(Control Deck Bridge) 1.1.0 listening on 127.0.0.1:50711` (with the installed version). After re-running setup (which re-stamps the secret or updates the script), **restart Live** — Live caches remote-script code for the whole process lifetime, so toggling the Control Surface slot re-enables the bridge but does not load updated script code.

**If Control Deck isn't listed** in the Control Surface dropdown, the script folder is missing or in a non-default User Library. Check that `~/Music/Ableton/User Library/Remote Scripts/Control_Deck/` exists; if you've moved your User Library, copy the setup-installed `Control_Deck` folder into `<your User Library>/Remote Scripts/` — but always the setup-installed copy, never the repo folder, which has no secret stamped in.

## Everyday use

Nothing to start manually. The services launch at login; the remote script loads with Live; agents launch the MCP server themselves.

1. Open **Ableton Live**. The bridge starts with the Control Surface.
2. Ask your agent — "list my tracks", "set the tempo to 126 and confirm it", "load Pro-Q 4 on track 2".
3. Optionally watch the **dashboard** (`http://127.0.0.1:50713`) to see status and devices live.

Order never matters — every piece waits gracefully for the others.

## The dashboard

- **Deck** — bridge status, the current Live session and transport, the selected track's device chain, and a searchable inventory of every VST3, VST2, AU, and CLAP plug-in on your machine (reindex from here after installing plug-ins).
- **Connect** — copy-paste setup for every SI agent, rendered with your machine's real install path. See [Connecting SI agents](#connecting-si-agents).
- **Settings** — bridge address, refresh cadence, plug-in library defaults, density, signal color, motion. Stored in your browser; the deck itself never writes to Live.

## Connecting SI agents

The **Connect page** (`http://127.0.0.1:50713/connect`) is the canonical guide, with exact snippets for Claude Code, Claude Desktop, Codex, Cursor, VS Code, Windsurf, Gemini CLI, Grok CLI, local LLM harnesses (LM Studio, Ollama via mcphost), and any other MCP client. The universal facts:

- **Command:** `node <install-path>/dist/src/index.js`
- **Transport:** stdio — no URL, no port, no network setup
- Live must be open with the Control Surface enabled for tools to work; the agent config is one-time.

Remote cloud connectors (claude.ai, ChatGPT) are deliberately unsupported — see the [FAQ](#faq).

## MCP tool reference

All tools follow the same contract: **exact targets** (mutations require indices plus current names where identity matters; stale names are refused), **structured results** (`ok`, `dryRun`, `tool`, `data`), **dry-run support** on mutations (`dryRun: true` reports what would happen without touching Live), and **readback verification** (writes report the value Live actually shows afterward). Set `CONTROL_DECK_DRY_RUN=1` to force every mutation into dry-run mode.

### Status & connection

- **ableton_status** — Check the Control Deck Bridge connection and return Live status.
- **get_live_set** — Structured overview of the Live version, transport, signature, tracks, scenes, and selection.
- **get_transport** — Playback, position, tempo, metronome, recording, and loop state.
- **get_time_signature** — The current time signature.

### Transport

- **play / stop / continue_playback** — Start, stop, or continue playback and verify the transport state.
- **get_tempo / set_tempo** — Read, or set and verify, the Live Set tempo.
- **set_time_signature** — Set and read back both components of the time signature.
- **set_song_position** — Set the transport position in beats and verify it.
- **toggle_metronome** — Toggle and verify the metronome.
- **start_recording / stop_recording** — Enable or disable Arrangement recording and verify it.

### Tracks, scenes & clips

- **list_tracks** — List tracks with stable explicit index identifiers.
- **get_track** — Inspect one track by explicit current index.
- **create_midi_track / create_audio_track** — Create a track at an index (`-1` appends).
- **rename_track** — Rename a track selected by explicit index.
- **delete_track** — Delete a track by explicit index; `confirm: true` is mandatory except in dry-run mode.
- **list_scenes** — List Session View scenes with explicit indices.
- **list_clips** — List Session View clips, optionally restricted to one track.
- **get_selected_track / get_selected_clip** — The current selection, refused politely when it isn't a regular track/clip.
- **create_midi_clip** — Create a Session View MIDI clip with an exact beat length.
- **get_clip_notes** — Read every MIDI note in a Session View clip (pitch, start and duration in beats, velocity, mute), sorted by start time then pitch, plus the clip length. Read only.
- **add_midi_notes** — Validate and add MIDI notes to a Session View clip. Pitches accept integers or Ableton-style note names (`C3` is MIDI 60).

### Arrangement

Note times below are beats from the start of the clip. Clip `startBeats` is the position in the Arrangement. `clipIndex` is the position in that track's `arrangement_clips` list, which `list_arrangement_clips` reports. Pass `clipIndex`, `startBeats`, or both. Both must describe the same clip. A start time that matches more than one clip is refused.

- **list_locators / add_locator / delete_locator** — List, create, or delete Arrangement locators (cue points). Adding or deleting one needs playback stopped. Live changes the locator at the playhead, so the bridge moves the playhead, waits until Live reports it there, makes the change, and puts the playhead back. Adding a locator where one already exists renames it.
- **list_arrangement_clips** — List one track's Arrangement clips with `index`, `name`, `startBeats`, `endBeats`, `lengthBeats` (end minus start), and `kind` (`midi` or `audio`).
- **create_arrangement_midi_clip** — Create an empty MIDI clip in the Arrangement with `Track.create_midi_clip(start_time, length)`. Needs Live 12.1.10 or newer. Pass the track index and its current name. `startBeats` is where the clip starts and `lengthBeats` is its length, not its end time. An optional `name` is read back. A clip that would overlap an existing Arrangement clip is refused before Live creates it, and the error names the clip already there. Live 12.4 trims on overlap instead of raising, so the bridge does not call `create_midi_clip` in that case and existing clips stay as they are. Touching at an endpoint is allowed. A non-MIDI track, a frozen track, and recording into the track fail clearly. Older Live versions fail with a message that names the running version and 12.1.10.
- **place_clip_in_arrangement** — Copy a Session clip into the Arrangement, tiled back to back from `startBeats` until `endBeats`, and confirm the copies. Each copy is the full clip, so the last one can run past `endBeats`. Ranges that would need more than 512 copies are refused.
- **clear_arrangement_track** — Delete every Arrangement clip on one track. `confirm: true` is mandatory.
- **get_arrangement_clip_notes** — Read every note in one Arrangement MIDI clip, including `noteId`, pitch, start, duration, velocity, and mute.
- **add_arrangement_clip_notes** — Add notes, then read the clip back. The call fails if any requested note is missing or different. One note already in the clip can satisfy only one requested note. Pitches accept integers or note names (`C3` is MIDI 60). At most 256 notes per call.
- **modify_arrangement_clip_notes** — Change existing notes by `noteId` (`Clip.apply_note_modifications`). The bridge edits the note vector `get_notes_extended` returns and passes that same vector back. A tuple does not match Live's signature. Omit a field to leave it alone. The clip is read back and each changed note must match.
- **remove_arrangement_clip_notes** — Remove notes whose start lies in a pitch and time range (`Clip.remove_notes_extended`). `fromTime` is inclusive and `fromTime + timeSpan` is exclusive. `pitchSpan` counts pitches starting at `fromPitch`. The call fails when the range matches nothing. Notes outside the range must still be there afterward.

```json
{ "tool": "list_arrangement_clips", "arguments": { "trackIndex": 0 } }
```

```json
{ "tool": "create_arrangement_midi_clip", "arguments": { "trackIndex": 1, "expectedTrackName": "Bass", "startBeats": 8, "lengthBeats": 4, "name": "Hook" } }
```

That asks for a 4-beat MIDI clip starting at beat 8, so it ends at beat 12. A second argument of 4 is the length, not an end time of 4.

```json
{ "tool": "get_arrangement_clip_notes", "arguments": { "trackIndex": 1, "expectedTrackName": "Bass", "startBeats": 8 } }
```

```json
{ "tool": "add_arrangement_clip_notes", "arguments": { "trackIndex": 1, "expectedTrackName": "Bass", "clipIndex": 0, "startBeats": 8, "notes": [{ "pitch": "C3", "startTime": 0, "duration": 1, "velocity": 100 }, { "pitch": 67, "startTime": 1, "duration": 0.5, "velocity": 90, "mute": false }] } }
```

```json
{ "tool": "modify_arrangement_clip_notes", "arguments": { "trackIndex": 1, "expectedTrackName": "Bass", "clipIndex": 0, "notes": [{ "noteId": 1, "pitch": "G3" }] } }
```

`noteId` comes from `get_arrangement_clip_notes`. Here only the pitch changes.

```json
{ "tool": "remove_arrangement_clip_notes", "arguments": { "trackIndex": 1, "expectedTrackName": "Bass", "clipIndex": 0, "fromPitch": 60, "pitchSpan": 1, "fromTime": 0, "timeSpan": 1 } }
```

That removes notes of pitch 60 (C3) whose start is in the half-open beat range `[0, 1)`.

### Devices & parameters

- **list_devices** — List top-level devices on a track.
- **get_device_parameters / list_device_parameters** — List every parameter Live exposes for a specific device.
- **set_device_parameter** — Set an exposed parameter using stable indices and a required expected-device-name safeguard.
- **list_plugin_devices** — List loaded third-party plug-in devices, optionally restricted to one track.
- **get_plugin_parameters** — List the controllable parameters of an exact loaded third-party plug-in.
- **find_plugin_parameter** — Search an exact loaded plug-in's parameters by name.
- **set_plugin_parameter** — Set a third-party plug-in parameter with an exact device/name safeguard, a normalized 0–1 value, and Live read-back verification.

### Plug-in discovery & loading

- **plugin_loader_status** — Check the bridge connection without changing Live.
- **list_installed_plugins** — Search Live's indexed VST3, VST2, and Audio Unit browser entries.
- **find_plugin** — Resolve the exact Live Browser path that would be loaded for a plug-in name and format.
- **refresh_plugin_index** — Rebuild the bridge's plug-in index from Live's current Browser state.
- **load_plugin / load_plugin_on_track** — Load a resolved plug-in on an explicit track and verify the device chain grew. Requires the track's current name; an exact resolved path disambiguates duplicates.
- **find_live_device** — Resolve the exact Browser path for a native Live device from the Instruments, Audio Effects, MIDI Effects, or Drums categories.
- **load_live_device** — Load a native Live device (Drum Rack, Echo, Reverb, ...) on an explicit track through Live's Browser, refusing ambiguous names and verifying the device chain.
- **load_user_library_item** — Load a User Library item onto an exact track by its exact Browser name, then read the device chain back. This is how a saved Instrument Rack (`.adg`) or device preset (`.adv`) is loaded, including a rack that holds Pigments or Serum 2 with a patch. If more than one item has that name, the call fails and returns the Browser paths. Pass one of those paths as `path` to choose. `path` is a Live Browser path such as `User Library/Presets/Instruments/My Serum Rack`, not a file on disk.

```json
{ "tool": "load_user_library_item", "arguments": { "trackIndex": 1, "expectedTrackName": "Bass", "name": "Serum 2 Bass Rack" } }
```

Live's browser API loads a Browser item. It cannot load a `.vstpreset`, `.aupreset`, `.fxp`, or `.fxb` from a filesystem path, and Control Deck refuses those paths instead of copying files into the User Library. Save the patch inside an Instrument Rack (`.adg`) or as a device preset (`.adv`) in the User Library, then load that item by exact name. If Live already lists a preset file as a User Library Browser item, the same tool can load it by that item's exact name. The device chain has to change (a new device, or a device whose name or class changed). A load that leaves the chain identical fails verification. `load_device_preset`, `load_instrument_rack`, `load_drum_rack`, and `load_effect_rack` stay path-based stubs.

The recommended loading sequence: `plugin_loader_status` → `list_installed_plugins` → `find_plugin` (save the resolved path) → `list_tracks` → `load_plugin` with index, current track name, exact plug-in name/format, and the resolved path. Duplicate names are refused with candidate paths instead of guessed at.

### OmniHost

- **omnihost_status** — Check whether the OmniHost device is loaded and its parameter catalog is ready.
- **list_omnihost_parameters** — Search the hosted plug-in's full parameter catalog (MIDI CC helper entries hidden by default).
- **get_omnihost_parameter / set_omnihost_parameter** — Read or set one exact parameter by VST index and name, normalized 0–1, with readback.
- **open_omnihost_plugin** — Open the hosted plug-in's native editor.
- **refresh_omnihost_parameters** — Re-index the hosted plug-in's full VST3 parameter catalog.
- **load_omnihost_on_track** — Load the installed OmniHost device on an exact existing MIDI track.

### Samples

- **search_samples** — Search the local SQLite sample index by keywords, folder, sample type, BPM range, musical key, duration, one-shot/loop kind, favorites, and tags.
- **get_sample_metadata** — Get one indexed sample by id or exact source path.
- **refresh_sample_index** — Refresh the index; a destructive rebuild requires `confirm: true`.

### Templates & capability stubs

- **list_templates** — List user-configured templates, racks, presets, and device chains from `config/templates.json`.
- **load_track_template / load_device_preset / load_drum_rack / load_instrument_rack / load_effect_rack** — Path-based stubs. Each still returns `UNSUPPORTED_CAPABILITY`. Load a saved rack with `load_user_library_item` and its exact User Library name instead.
- **get_project_path / get_unsaved_status / save_live_set / save_live_set_as** — Stubs: Live's remote-script API does not expose document paths or save commands, and UI automation is intentionally disabled. Rendering is unavailable for the same reason.
- **create_project_version** — Proposes a collision-safe version filename; the save itself remains manual.

## OmniHost

Control Deck OmniHost is a Max for Live instrument that hosts a VST3 synth inside Max's `vst~` object and reads its VST3 parameter catalog directly, bypassing Live's automatic device-panel parameter ceiling. The shipped device is mapped for **Arturia Mini V4** (which publishes 2,663 VST3 parameters — OmniHost hides the ~2,080 "MIDI CC helper" entries by default and presents the useful remainder for search and control); adapting it to another VST3 instrument means editing the hosted plug-in name in `max-for-live/Control Deck OmniHost.maxpat` and rebuilding.

```sh
npm run install:omnihost
```

That builds the `.amxd` from source (no Max authoring license needed — Max for Live is enough to run it) and installs it at `User Library/Presets/Instruments/Max Instrument/Control Deck/`. Load it on a MIDI track from Live's browser, or call `load_omnihost_on_track`.

Details worth knowing:

- OmniHost listens only on `127.0.0.1:50714` using the versioned `control-deck-omnihost/1` UDP JSON protocol.
- Every parameter mutation requires the exact plug-in name, VST parameter index, and current parameter name, so duplicate names or catalog changes can't redirect a command.
- Live MIDI is forwarded to the hosted plug-in; its stereo output returns to the same Live track. Snapshot autosave keeps hosted state with the Live Set.
- One active OmniHost instance is supported (the device owns its port).
- Parameters the vendor does not publish through VST3 remain inaccessible.

## The sample index

The sample tools read a local SQLite catalog of an external sample drive. Point `config/sample-library.json` at your drive (setup creates the file from the example on first run):

```json
{
  "root": "/Volumes/YourSampleDrive/Sample Packs",
  "database": "data/samples.sqlite",
  "favorites": [],
  "tags": {}
}
```

Then build or refresh the index:

```sh
npm run samples:index
npm run samples:index -- --rebuild --confirm
```

WAV, AIFF/AIF, MP3, and FLAC files are cataloged. Source audio is read-only — the indexer never copies, moves, or writes samples. BPM, key, sample type, and one-shot/loop status are inferred conservatively from filenames and folders. A normal refresh upserts changed files and removes stale rows; the destructive database rebuild requires both flags. The root must be on an external volume (`/Volumes/…`) by design, so a misconfigured index can never crawl your system drive.

## Files and locations

| What | Where |
|---|---|
| The install (never move without re-running setup) | wherever you placed the folder |
| Per-install secret | `<install>/data/bridge-token` |
| Plug-in inventory | `<install>/data/plugin-index.json` |
| Sample index | `<install>/data/samples.sqlite` |
| MCP request log | `<install>/logs/control-deck.jsonl` |
| Remote script (installed copy) | `~/Music/Ableton/User Library/Remote Scripts/Control_Deck/` |
| OmniHost device (installed copy) | `~/Music/Ableton/User Library/Presets/Instruments/Max Instrument/Control Deck/` |
| Launch agents | `~/Library/LaunchAgents/com.abletondeck.{api,dashboard}.plist` |
| Service logs | `/tmp/com.abletondeck.*.log` and `.error.log` |
| Wrapper app (optional) | built to `<install>/build/`, typically copied to `/Applications` |

Ports (all loopback-only): `50711/udp` bridge, `50712/tcp` status API, `50713/tcp` dashboard, `50714/udp` OmniHost.

## Troubleshooting

**The deck says "waiting for Ableton Live."** Live isn't open, or the Control Surface isn't active. In Live: Settings → Link, Tempo & MIDI → confirm **Control Deck** is selected in a Control Surface slot. If it's missing from the dropdown, run setup again and restart Live.

**"AUTH_INVALID" / authentication failed.** The remote script and your services disagree about the secret — usually a script installed before the current `data/bridge-token`. Run setup again (it re-stamps the script), then restart Live or toggle the Control Surface off and on.

**The bridge refuses to start and mentions a missing token.** The repo copy of the remote script was copied into Live by hand instead of through setup, so the secret placeholder was never stamped. Run setup; never copy `remote-script/Control_Deck/` into Live manually.

**Dashboard won't load.** Check the services: `launchctl print gui/$(id -u)/com.abletondeck.dashboard` (and `.api`). Logs live in `/tmp/com.abletondeck.*.error.log`. `launchctl kickstart -k gui/$(id -u)/<label>` restarts one. Re-running setup fixes most states.

**Everything broke after moving or renaming the folder.** Expected — services pin absolute paths. Run setup from the new location (it detects the move and refreshes), and re-register the MCP server in your agent since its path changed too.

**Everything broke after upgrading Node.** The launch agents pin the Node binary that ran setup. Re-run setup with the new Node and they're re-pinned.

**Port 50711 already in use.** Only one Control Deck Bridge can run. Quit duplicate Live instances, or check `lsof -nP -iUDP:50711` to see what's holding it.

**macOS refuses to open the installer.** Downloaded, non-notarized scripts need a one-time right-click → **Open**. Everything after that first launch is normal.

**Plug-in list is empty or stale.** Use the reindex button on the deck, or `npm run index:plugins`.

**Sample tools error about the library config.** Edit `config/sample-library.json` so `root` points at your actual sample drive (it must be under `/Volumes/`), then `npm run samples:index`.

**An agent connects but tools time out.** Live must be open with the Control Surface enabled; requests need a live bridge. `ableton_status` is the cheapest way to check what the agent sees.

## Uninstalling

```sh
launchctl bootout gui/$(id -u)/com.abletondeck.api
launchctl bootout gui/$(id -u)/com.abletondeck.dashboard
rm ~/Library/LaunchAgents/com.abletondeck.*.plist
rm -rf ~/Music/Ableton/"User Library"/"Remote Scripts"/Control_Deck
rm -rf ~/Music/Ableton/"User Library"/Presets/Instruments/"Max Instrument"/"Control Deck"
```

Then delete the install folder, remove the wrapper app from `/Applications` if you copied it there, and remove the server from your agent (for Claude Code: `claude mcp remove ableton`). Control Deck writes nowhere else.

## Security model

- Everything binds to `127.0.0.1`. Nothing listens on, or connects to, any network.
- Every bridge request carries a per-install secret generated on your machine and never committed anywhere. The remote script refuses to run without one.
- The Live API exposed over the bridge is an explicit allowlist, not a generic method executor; mutations require exact index-plus-name targets and are refused on mismatch or ambiguity, so a confused agent fails loudly instead of editing the wrong thing.
- Completed request IDs are cached, so a duplicated datagram can never run a mutation twice.
- The wrapper app blocks all navigation away from the local dashboard.
- The MCP server logs requests locally to `logs/control-deck.jsonl` so you can audit what an agent did.

## Known limitations

- **Read-back proves the observable result, not internals.** Mutations get correlated acknowledgements plus a separate read-back query, but a read-back cannot prove every internal detail atomically.
- **Track identity is index-plus-name.** Indices shift when tracks are inserted or deleted, which is exactly why every mutation also requires the current name.
- **Device traversal covers top-level track devices**, not devices nested inside racks.
- **No proprietary plug-in UI control.** Control Deck can instantiate plug-ins and set the parameters they expose; it cannot manipulate vendor UIs or parameters kept hidden from Live (OmniHost exists to widen that surface for one hosted instrument).
- **Native device loading covers devices, not factory preset browsers.** `load_live_device` resolves items under Instruments, Audio Effects, MIDI Effects, and Drums by exact name and refuses fuzzy matches. A saved User Library rack is a separate tool, `load_user_library_item`.
- **Arrangement MIDI clips can be created on Live 12.1.10 and newer.** `create_arrangement_midi_clip` calls `Track.create_midi_clip(start_time, length)` and reads the clip back. Older Live versions fail by name. Session clips can still be copied into the Arrangement with `place_clip_in_arrangement`.
- **Arrangement automation, saving the Live Set, and rendering are not available** through the API. Control Deck does not fake them with UI automation.
- **Preset files on disk are not loaded.** `.vstpreset`, `.aupreset`, `.fxp`, and `.fxb` paths are refused. Use a User Library `.adg` or `.adv`, selected by exact name.
- **No audio preview.** The API does not preview samples, and Control Deck does not automate the UI to do it.
- **Live API coupling.** The bridge uses Live's Python remote-script API, so a future Live update could require a compatible Control Deck release.

## FAQ

**Does it work with Claude Code / Codex / Cursor / my local LLM?**
Yes — any MCP client. The Connect page has per-client snippets. For local LLMs, the harness (LM Studio, mcphost, etc.) speaks MCP; any local model with solid tool-calling can drive Live fully offline.

**Can claude.ai or ChatGPT control it from the cloud via a connector?**
Not out of the box, deliberately: connectors expect a public HTTPS endpoint, and Control Deck is loopback-only. It can be bridged with a stdio→HTTP gateway plus a tunnel, but that makes your DAW internet-reachable and the bridge secret does not protect the HTTP side — you'd need real endpoint auth, an always-awake Mac, and tolerance for cloud round-trip latency. If you need other-device access, a private overlay network (e.g. plain Tailscale) is the sane middle ground. Local agents over stdio are the supported path.

**Why won't it save or render my project?**
Saving the Live Set and rendering audio are not available through Live's remote-script API. Arrangement automation is not available either. Control Deck does not drive the UI to fake them. `save_live_set` and `save_live_set_as` return `UNSUPPORTED_CAPABILITY`.

**Can it load a Pigments or Serum 2 patch?**
Save the patch inside an Instrument Rack (`.adg`) in the User Library, then call `load_user_library_item` with that rack's exact name plus the track index and current track name. If several items share the name, the call refuses and lists their Browser paths; pass one path back to choose. A `.vstpreset` or `.aupreset` path on disk is refused, because the API accepts a Browser item and not a file path.

**Does it phone home, collect telemetry, or need an account?**
No, no, and no.

**Linux? Windows?**
Not yet — see [Compatibility](#compatibility) and [PORTING.md](PORTING.md). The core is portable; contributions welcome.
