#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { AbletonCommands } from "./commands.js";
import { LiveTools } from "./live-tools.js";
import { SampleIndex } from "./sample-index.js";
import { LocalCapabilities } from "./local-capabilities.js";
import { AbletonClient } from "./ableton-client.js";
import { PluginTools } from "./plugin-tools.js";
import { OmnihostClient } from "./omnihost-client.js";
import { OmnihostTools } from "./omnihost-tools.js";

const ableton = new AbletonClient();
const commands = new AbletonCommands(ableton, undefined, process.env.CONTROL_DECK_DRY_RUN === "1");
const live = new LiveTools(ableton, undefined, process.env.CONTROL_DECK_DRY_RUN === "1");
const samples = new SampleIndex();
const local = new LocalCapabilities();
const plugins = new PluginTools(ableton, ableton, undefined, process.env.CONTROL_DECK_DRY_RUN === "1");
const omnihostClient = new OmnihostClient();
const omnihost = new OmnihostTools(omnihostClient, ableton, undefined, process.env.CONTROL_DECK_DRY_RUN === "1");
const server = new McpServer({ name: "ableton-control-deck", version: "1.1.0" });
const response = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> });

server.tool("ableton_status", "Check the Control Deck Bridge connection and return Live status.", {}, async () => response(await commands.status()));
server.tool("get_tempo", "Read the current Live Set tempo.", {}, async () => response(await commands.getTempo()));
server.tool("set_tempo", "Set and verify the Live Set tempo.", { tempo: z.number().min(20).max(999), dryRun: z.boolean().default(false) }, async ({ tempo, dryRun }) => response(await commands.setTempo(tempo, dryRun)));
server.tool("list_tracks", "List tracks with stable explicit index identifiers.", {}, async () => response(await commands.listTracks()));
server.tool("create_midi_track", "Create a MIDI track at index (-1 appends).", { index: z.number().int().min(-1).default(-1), dryRun: z.boolean().default(false) }, async ({ index, dryRun }) => response(await commands.createMidiTrack(index, dryRun)));
server.tool("create_audio_track", "Create an audio track at index (-1 appends).", { index: z.number().int().min(-1).default(-1), dryRun: z.boolean().default(false) }, async ({ index, dryRun }) => response(await commands.createAudioTrack(index, dryRun)));
server.tool("rename_track", "Rename a track selected by explicit index.", { trackIndex: z.number().int().min(0), name: z.string().min(1), dryRun: z.boolean().default(false) }, async ({ trackIndex, name, dryRun }) => response(await commands.renameTrack(trackIndex, name, dryRun)));
server.tool("create_midi_clip", "Create a Session View MIDI clip.", { trackIndex: z.number().int().min(0), sceneIndex: z.number().int().min(0), lengthBeats: z.number().positive(), dryRun: z.boolean().default(false) }, async ({ trackIndex, sceneIndex, lengthBeats, dryRun }) => response(await commands.createMidiClip(trackIndex, sceneIndex, lengthBeats, dryRun)));
server.tool("add_midi_notes", "Validate and add MIDI notes to a Session View clip. Ableton note names use C3=60.", {
  trackIndex: z.number().int().min(0), sceneIndex: z.number().int().min(0),
  notes: z.array(z.object({ pitch: z.union([z.number().int(), z.string()]), startTime: z.number(), duration: z.number(), velocity: z.number().int(), mute: z.boolean().default(false) })).min(1),
  dryRun: z.boolean().default(false)
}, async ({ trackIndex, sceneIndex, notes, dryRun }) => response(await commands.addMidiNotes(trackIndex, sceneIndex, notes, dryRun)));
server.tool("delete_track", "Delete a track by explicit index. confirm=true is mandatory except in dry-run mode.", { trackIndex: z.number().int().min(0), confirm: z.boolean().default(false), dryRun: z.boolean().default(false) }, async ({ trackIndex, confirm, dryRun }) => response(await commands.deleteTrack(trackIndex, confirm, dryRun)));

server.tool("get_live_set", "Return a structured overview of the Live version, transport, signature, tracks, scenes, and selection.", {}, async () => response(await live.getLiveSet()));
server.tool("get_transport", "Read playback, position, tempo, metronome, recording, and loop state.", {}, async () => response(await live.getTransport()));
server.tool("get_time_signature", "Read the current time signature.", {}, async () => response(await live.getTimeSignature()));
server.tool("get_track", "Inspect a track by explicit current index.", { trackIndex: z.number().int().min(0) }, async ({ trackIndex }) => response(await live.getTrack(trackIndex)));
server.tool("list_scenes", "List Session View scenes with explicit indices.", {}, async () => response(await live.listScenes()));
server.tool("list_clips", "List Session View clips, optionally restricted to one track.", { trackIndex: z.number().int().min(0).optional() }, async ({ trackIndex }) => response(await live.listClips(trackIndex)));
server.tool("get_selected_track", "Return the selected regular track and explicit index.", {}, async () => response(await live.getSelectedTrack()));
server.tool("get_selected_clip", "Return the selected track/scene position and whether it contains a clip.", {}, async () => response(await live.getSelectedClip()));
server.tool("list_devices", "List top-level devices on a track.", { trackIndex: z.number().int().min(0) }, async ({ trackIndex }) => response(await live.listDevices(trackIndex)));
server.tool("get_device_parameters", "List parameters exposed by Ableton for a specific device.", { trackIndex: z.number().int().min(0), deviceIndex: z.number().int().min(0) }, async ({ trackIndex, deviceIndex }) => response(await live.getDeviceParameters(trackIndex, deviceIndex)));
server.tool("list_device_parameters", "Alias of get_device_parameters.", { trackIndex: z.number().int().min(0), deviceIndex: z.number().int().min(0) }, async ({ trackIndex, deviceIndex }) => response(await live.getDeviceParameters(trackIndex, deviceIndex)));
server.tool("set_device_parameter", "Set an exposed parameter using stable indices and a required expected device-name safeguard.", {
  trackIndex: z.number().int().min(0), deviceIndex: z.number().int().min(0), parameterIndex: z.number().int().min(0), value: z.number(), expectedDeviceName: z.string().min(1), dryRun: z.boolean().default(false)
}, async ({ trackIndex, deviceIndex, parameterIndex, value, expectedDeviceName, dryRun }) => response(await live.setDeviceParameter(trackIndex, deviceIndex, parameterIndex, value, expectedDeviceName, dryRun)));
server.tool("list_plugin_devices", "List loaded third-party plugin devices, optionally restricted to one track.", { trackIndex: z.number().int().min(0).optional() }, async ({ trackIndex }) => response(await live.listPluginDevices(trackIndex)));
server.tool("get_plugin_parameters", "List the controllable parameters for an exact loaded third-party plugin device.", {
  trackIndex: z.number().int().min(0), deviceIndex: z.number().int().min(0), expectedDeviceName: z.string().min(1)
}, async ({ trackIndex, deviceIndex, expectedDeviceName }) => response(await live.getPluginParameters(trackIndex, deviceIndex, expectedDeviceName)));
server.tool("find_plugin_parameter", "Search an exact loaded third-party plugin device for parameters by name.", {
  trackIndex: z.number().int().min(0), deviceIndex: z.number().int().min(0), expectedDeviceName: z.string().min(1), query: z.string().min(1), exact: z.boolean().default(false)
}, async ({ trackIndex, deviceIndex, expectedDeviceName, query, exact }) => response(await live.findPluginParameter(trackIndex, deviceIndex, expectedDeviceName, query, exact)));
server.tool("set_plugin_parameter", "Set a loaded third-party plugin parameter using an exact device/name safeguard, normalized 0-1 value, and Live read-back verification.", {
  trackIndex: z.number().int().min(0), deviceIndex: z.number().int().min(0), expectedDeviceName: z.string().min(1),
  parameterName: z.string().min(1), parameterIndex: z.number().int().min(0).optional(), normalizedValue: z.number().min(0).max(1), dryRun: z.boolean().default(false)
}, async input => response(await live.setPluginParameter(input)));

server.tool("omnihost_status", "Check whether Control Deck OmniHost is loaded and return its full VST3 parameter-index status.", {}, async () => response(await omnihost.status()));
server.tool("list_omnihost_parameters", "Search Mini V4 parameters indexed by Control Deck OmniHost, excluding MIDI CC helper entries by default.", {
  query: z.string().optional(), includeHelpers: z.boolean().default(false), limit: z.number().int().min(1).max(250).default(100), offset: z.number().int().min(0).default(0)
}, async input => response(await omnihost.listParameters(input)));
server.tool("get_omnihost_parameter", "Read one exact Mini V4 parameter directly through OmniHost using index and name safeguards.", {
  expectedPluginName: z.literal("Mini V4"), parameterIndex: z.number().int().min(1), expectedParameterName: z.string().min(1)
}, async input => response(await omnihost.getParameter(input)));
server.tool("set_omnihost_parameter", "Set and read back one exact Mini V4 parameter through OmniHost using normalized 0-1 control.", {
  expectedPluginName: z.literal("Mini V4"), parameterIndex: z.number().int().min(1), expectedParameterName: z.string().min(1), normalizedValue: z.number().min(0).max(1), dryRun: z.boolean().default(false)
}, async input => response(await omnihost.setParameter(input)));
server.tool("open_omnihost_plugin", "Open the native Mini V4 editor hosted by Control Deck OmniHost.", {}, async () => response(await omnihost.openEditor()));
server.tool("refresh_omnihost_parameters", "Re-index Mini V4's full VST3 parameter catalog inside Control Deck OmniHost.", {}, async () => response(await omnihost.refreshCatalog()));
server.tool("load_omnihost_on_track", "Load the installed Control Deck OmniHost device on an exact existing MIDI track.", {
  trackIndex: z.number().int().min(0), expectedTrackName: z.string().min(1), dryRun: z.boolean().default(false)
}, async input => response(await omnihost.loadOnTrack(input)));

server.tool("play", "Start Live playback and verify the transport state.", { dryRun: z.boolean().default(false) }, async ({ dryRun }) => response(await live.play(dryRun)));
server.tool("stop", "Stop Live playback and verify the transport state.", { dryRun: z.boolean().default(false) }, async ({ dryRun }) => response(await live.stop(dryRun)));
server.tool("continue_playback", "Continue playback from the current position.", { dryRun: z.boolean().default(false) }, async ({ dryRun }) => response(await live.continuePlayback(dryRun)));
server.tool("set_time_signature", "Set and read back both components of the time signature.", { numerator: z.number().int().min(1).max(99), denominator: z.union([z.literal(1), z.literal(2), z.literal(4), z.literal(8), z.literal(16)]), dryRun: z.boolean().default(false) }, async ({ numerator, denominator, dryRun }) => response(await live.setTimeSignature(numerator, denominator, dryRun)));
server.tool("set_song_position", "Set the transport position in beats and verify it.", { positionBeats: z.number().min(0), dryRun: z.boolean().default(false) }, async ({ positionBeats, dryRun }) => response(await live.setSongPosition(positionBeats, dryRun)));
server.tool("toggle_metronome", "Toggle and verify the metronome.", { dryRun: z.boolean().default(false) }, async ({ dryRun }) => response(await live.toggleMetronome(dryRun)));
server.tool("start_recording", "Enable Arrangement recording and verify it.", { dryRun: z.boolean().default(false) }, async ({ dryRun }) => response(await live.setRecording(true, dryRun)));
server.tool("stop_recording", "Disable Arrangement recording and verify it.", { dryRun: z.boolean().default(false) }, async ({ dryRun }) => response(await live.setRecording(false, dryRun)));

server.tool("list_locators", "List Arrangement locators (cue points) with their positions in beats.", {}, async () => response(await live.listLocators()));
server.tool("add_locator", "Create (or rename) an Arrangement locator at an exact beat position and verify its name. Playback must be stopped; the playhead is returned to where it was.", { timeBeats: z.number().min(0), name: z.string().min(1), dryRun: z.boolean().default(false) }, async ({ timeBeats, name, dryRun }) => response(await live.addLocator(timeBeats, name, dryRun)));
server.tool("delete_locator", "Delete the Arrangement locator at an exact beat position. Playback must be stopped; the playhead is returned to where it was.", { timeBeats: z.number().min(0), dryRun: z.boolean().default(false) }, async ({ timeBeats, dryRun }) => response(await live.deleteLocator(timeBeats, dryRun)));
server.tool("list_arrangement_clips", "List Arrangement View clips on a track with index, name, start, end, length, and MIDI or audio type.", { trackIndex: z.number().int().min(0) }, async ({ trackIndex }) => response(await live.listArrangementClips(trackIndex)));
server.tool("create_arrangement_midi_clip", "Create an empty Arrangement MIDI clip with Track.create_midi_clip(start_time, length). Needs Live 12.1.10 or newer. Requires the track index and current name, then reads the clip back.", {
  trackIndex: z.number().int().min(0), expectedTrackName: z.string().min(1), startBeats: z.number().min(0), lengthBeats: z.number().positive(), name: z.string().min(1).max(128).optional(), dryRun: z.boolean().default(false)
}, async input => response(await live.createArrangementMidiClip(input)));
const arrangementClipTarget = { trackIndex: z.number().int().min(0), expectedTrackName: z.string().min(1), clipIndex: z.number().int().min(0).optional(), startBeats: z.number().min(0).optional() };
server.tool("get_arrangement_clip_notes", "Read notes in one Arrangement MIDI clip, addressed by track plus clip index or start time. Note times are beats from the start of the clip.", arrangementClipTarget, async input => response(await live.getArrangementClipNotes(input)));
server.tool("add_arrangement_clip_notes", "Add MIDI notes to an Arrangement MIDI clip and read them back. A requested note that is missing or different fails the call. Note times are beats from the start of the clip.", {
  ...arrangementClipTarget,
  notes: z.array(z.object({ pitch: z.union([z.number().int(), z.string()]), startTime: z.number(), duration: z.number(), velocity: z.number().int(), mute: z.boolean().default(false) })).min(1),
  dryRun: z.boolean().default(false)
}, async input => response(await live.addArrangementClipNotes(input)));
server.tool("modify_arrangement_clip_notes", "Change existing Arrangement MIDI notes by note id from get_arrangement_clip_notes, then read them back. Unspecified fields stay as they are.", {
  ...arrangementClipTarget,
  notes: z.array(z.object({ noteId: z.number().int().min(0), pitch: z.union([z.number().int(), z.string()]).optional(), startTime: z.number().min(0).optional(), duration: z.number().positive().optional(), velocity: z.number().int().min(1).max(127).optional(), mute: z.boolean().optional() })).min(1),
  dryRun: z.boolean().default(false)
}, async input => response(await live.modifyArrangementClipNotes(input)));
server.tool("remove_arrangement_clip_notes", "Remove Arrangement MIDI notes whose start lies in a pitch and time range, using Clip.remove_notes_extended, then read the clip back. Times are beats from the start of the clip. The end of the time range is exclusive.", {
  ...arrangementClipTarget,
  fromPitch: z.number().int().min(0).max(127), pitchSpan: z.number().int().min(1).max(128), fromTime: z.number().min(0), timeSpan: z.number().positive(), dryRun: z.boolean().default(false)
}, async input => response(await live.removeArrangementClipNotes(input)));
server.tool("place_clip_in_arrangement", "Copy a Session View clip (MIDI or audio) into the Arrangement, tiled back-to-back from startBeats until endBeats, and verify. Each copy is the full clip, so the last one can run past endBeats. At most 512 copies.", {
  trackIndex: z.number().int().min(0), sceneIndex: z.number().int().min(0), startBeats: z.number().min(0), endBeats: z.number().positive(), dryRun: z.boolean().default(false)
}, async input => response(await live.placeClipInArrangement(input)));
server.tool("clear_arrangement_track", "Delete every Arrangement clip on one track. confirm=true is mandatory.", { trackIndex: z.number().int().min(0), confirm: z.boolean().default(false), dryRun: z.boolean().default(false) }, async ({ trackIndex, confirm, dryRun }) => response(await live.clearArrangementTrack(trackIndex, confirm, dryRun)));

server.tool("search_samples", "Search the local SQLite sample index by text and musical metadata.", {
  keywords: z.string().optional(), folder: z.string().optional(), sampleType: z.string().optional(), bpmMin: z.number().optional(), bpmMax: z.number().optional(), musicalKey: z.string().optional(), durationMin: z.number().min(0).optional(), durationMax: z.number().min(0).optional(), kind: z.enum(["one-shot", "loop", "unknown"]).optional(), favoritesOnly: z.boolean().optional(), tags: z.array(z.string()).optional(), limit: z.number().int().min(1).max(200).optional()
}, async input => response({ ok: true, dryRun: false, tool: "search_samples", data: await samples.search(input) }));
server.tool("get_sample_metadata", "Get one indexed sample by id or exact source path.", { id: z.number().int().positive().optional(), path: z.string().optional() }, async input => response({ ok: true, dryRun: false, tool: "get_sample_metadata", data: await samples.getMetadata(input) }));
server.tool("refresh_sample_index", "Refresh the sample index. Rebuild requires confirm=true.", { rebuild: z.boolean().default(false), confirm: z.boolean().default(false) }, async ({ rebuild, confirm }) => response({ ok: true, dryRun: false, tool: "refresh_sample_index", data: await samples.refresh({ rebuild, confirm }) }));

const templateCategory = z.enum(["trackTemplates", "instrumentRacks", "audioEffectRacks", "drumRacks", "defaultProjectTemplates", "favoriteSerumPresets", "favoriteDeviceChains"]);
server.tool("list_templates", "List user-configured templates, racks, presets, and device chains.", { category: templateCategory.optional() }, async ({ category }) => response(await local.listTemplates(category)));
server.tool("load_track_template", "Report verified track-template loading capability.", { path: z.string(), dryRun: z.boolean().default(false) }, async () => response(local.unsupportedLoad("load_track_template", "track templates")));
server.tool("load_device_preset", "Report verified device-preset loading capability.", { path: z.string(), trackIndex: z.number().int().min(0), dryRun: z.boolean().default(false) }, async () => response(local.unsupportedLoad("load_device_preset", "device presets")));
server.tool("load_drum_rack", "Report verified Drum Rack loading capability.", { path: z.string(), trackIndex: z.number().int().min(0), dryRun: z.boolean().default(false) }, async () => response(local.unsupportedLoad("load_drum_rack", "Drum Racks")));
server.tool("load_instrument_rack", "Report verified Instrument Rack loading capability.", { path: z.string(), trackIndex: z.number().int().min(0), dryRun: z.boolean().default(false) }, async () => response(local.unsupportedLoad("load_instrument_rack", "Instrument Racks")));
server.tool("load_effect_rack", "Report verified Audio Effect Rack loading capability.", { path: z.string(), trackIndex: z.number().int().min(0), dryRun: z.boolean().default(false) }, async () => response(local.unsupportedLoad("load_effect_rack", "Audio Effect Racks")));

server.tool("get_project_path", "Return the project path when the control layer supports it.", {}, async () => response(local.getProjectPath()));
server.tool("get_unsaved_status", "Return Live's unsaved status when the control layer supports it.", {}, async () => response(local.getUnsavedStatus()));
server.tool("save_live_set", "Save the current Live Set when supported.", {}, async () => response(local.save("save_live_set")));
server.tool("save_live_set_as", "Save the current Live Set to an explicit path when supported.", { path: z.string(), overwrite: z.boolean().default(false) }, async () => response(local.save("save_live_set_as")));
server.tool("create_project_version", "Propose a collision-safe version filename; saving remains unavailable through the current bridge API.", { projectDirectory: z.string().optional(), projectName: z.string().optional(), overwrite: z.boolean().default(false) }, async input => response(await local.createProjectVersion(input)));

const pluginFormat = z.enum(["vst3", "vst2", "au", "auv2"]);
server.tool("plugin_loader_status", "Check the Control Deck Bridge connection without changing Live.", {}, async () => response(await plugins.status()));
server.tool("list_installed_plugins", "Search Live's indexed VST3, VST2, and Audio Unit browser entries.", { query: z.string().optional(), format: pluginFormat.optional(), limit: z.number().int().min(1).max(500).default(100) }, async input => response(await plugins.listInstalledPlugins(input)));
server.tool("find_plugin", "Resolve the exact Live Browser path that would be loaded for a plugin name and format.", { name: z.string().min(1), format: pluginFormat }, async ({ name, format }) => response(await plugins.findPlugin(name, format)));
server.tool("refresh_plugin_index", "Rebuild Control Deck Bridge's plugin index from Live's current Browser state.", {}, async () => response(await plugins.refreshPluginIndex()));
const loadPluginSchema = { trackIndex: z.number().int().min(0), expectedTrackName: z.string().min(1), name: z.string().min(1), format: pluginFormat, expectedPath: z.string().optional(), dryRun: z.boolean().default(false) };
server.tool("load_plugin", "Load a resolved plugin on an explicit track and verify the device chain through Control Deck Bridge.", loadPluginSchema, async input => response(await plugins.loadPlugin(input)));
server.tool("load_plugin_on_track", "Alias of load_plugin with the same explicit track and plugin safeguards.", loadPluginSchema, async input => response(await plugins.loadPlugin(input)));
server.tool("find_live_device", "Resolve the exact Live Browser path for a native Live device from the Instruments, Audio Effects, MIDI Effects, or Drums categories.", { name: z.string().min(1), path: z.string().optional() }, async ({ name, path }) => response(await plugins.findLiveDevice(name, path)));
server.tool("load_live_device", "Load a native Live device (e.g. Drum Rack, Echo, Reverb) on an explicit track through Live's Browser, refusing ambiguous names and verifying the device chain.", {
  trackIndex: z.number().int().min(0), expectedTrackName: z.string().min(1), name: z.string().min(1), path: z.string().optional(), dryRun: z.boolean().default(false)
}, async input => response(await plugins.loadLiveDevice(input)));
server.tool("load_user_library_item", "Load a User Library item, such as a saved Instrument Rack (.adg) or device preset (.adv), onto an exact track by exact name. Ambiguous names are refused. The device chain is read back. path is a Live Browser path, not a file on disk.", {
  trackIndex: z.number().int().min(0), expectedTrackName: z.string().min(1), name: z.string().min(1), path: z.string().min(1).optional(), dryRun: z.boolean().default(false)
}, async input => response(await plugins.loadUserLibraryItem(input)));

const shutdown = () => { samples.close(); ableton.close(); omnihostClient.close(); process.exit(0); };
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
await server.connect(new StdioServerTransport());
