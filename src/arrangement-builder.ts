import { parseArrangementClips } from "./arrangement-clips.js";
import { LiveTools } from "./live-tools.js";
import { parseScenes } from "./session-tools.js";
import { SnapshotTools } from "./snapshot-tools.js";
import { oscFloat, oscInt, type ToolResult } from "./types.js";

export interface SectionInput { name: string; scene: number | string; bars: number }
export interface PlannedSection { name: string; sceneIndex: number; startBeats: number; endBeats: number; tracks: Array<{ trackIndex: number; trackName: string; clipName: string; kind: string; clipLength: number }> }

/** Lay sections end to end from startBar (1-based) in bars of beatsPerBar. */
export function layoutSections(sections: readonly { name: string; sceneIndex: number; bars: number }[], beatsPerBar: number, startBar: number): Array<{ name: string; sceneIndex: number; startBeats: number; endBeats: number }> {
  let position = (startBar - 1) * beatsPerBar;
  return sections.map(section => {
    const startBeats = position;
    position += section.bars * beatsPerBar;
    return { name: section.name, sceneIndex: section.sceneIndex, startBeats, endBeats: position };
  });
}

export class ArrangementBuilder extends SnapshotTools {
  private locators = new LiveTools(this.live);

  buildArrangement(input: { sections: SectionInput[]; startBar?: number; locators?: boolean; dryRun?: boolean }): Promise<ToolResult> {
    return this.read("build_arrangement", async () => {
      if (!input.sections?.length || input.sections.length > 64) throw new Error("Pass 1 to 64 sections.");
      const startBar = input.startBar ?? 1;
      if (!Number.isInteger(startBar) || startBar < 1) throw new Error("startBar is a bar number from 1.");
      const scenes = parseScenes((await this.live.query("/live/song/get/scenes")).args);
      const numerator = Number((await this.live.query("/live/song/get/signature_numerator")).args.at(-1));
      const denominator = Number((await this.live.query("/live/song/get/signature_denominator")).args.at(-1));
      const beatsPerBar = (numerator * 4) / denominator;
      const resolved = input.sections.map(section => {
        if (!section.name?.trim()) throw new Error("Every section needs a name.");
        if (!(Number.isInteger(section.bars) && section.bars >= 1 && section.bars <= 512)) throw new Error(`Section '${section.name}' needs 1 to 512 bars.`);
        const matches = typeof section.scene === "number" ? [scenes[section.scene]].filter(Boolean) : scenes.filter(scene => scene.name === section.scene);
        if (!matches.length) throw new Error(`Section '${section.name}': no scene ${typeof section.scene === "number" ? `at index ${section.scene}` : `named '${section.scene}'`}.`);
        if (matches.length > 1) throw new Error(`Section '${section.name}': more than one scene is named '${section.scene}'; use its index.`);
        return { name: section.name.trim(), sceneIndex: matches[0].index, bars: section.bars };
      });
      const laid = layoutSections(resolved, beatsPerBar, startBar);
      const trackNames = (await this.live.query("/live/song/get/track_names")).args.map(String);
      const plan: PlannedSection[] = [];
      for (const section of laid) {
        const tracks: PlannedSection["tracks"] = [];
        for (let trackIndex = 0; trackIndex < trackNames.length; trackIndex++) {
          const slot = (await this.live.query("/live/clip_slot/get/state", [oscInt(trackIndex), oscInt(section.sceneIndex)])).args;
          if (slot[2] !== true) continue;
          const clip = await this.clipProps(trackIndex, section.sceneIndex);
          tracks.push({ trackIndex, trackName: trackNames[trackIndex], clipName: String(clip.props.name ?? ""), kind: String(clip.kind), clipLength: Number(clip.props.length) });
        }
        plan.push({ ...section, tracks });
      }
      if (plan.every(section => !section.tracks.length)) throw new Error("None of those scenes has any clips.");
      // Nothing may already sit in the Arrangement where a section goes.
      const touched = new Set(plan.flatMap(section => section.tracks.map(track => track.trackIndex)));
      const end = laid[laid.length - 1].endBeats, start = laid[0].startBeats;
      for (const trackIndex of touched) {
        const clips = parseArrangementClips((await this.live.query("/live/track/get/arrangement_clips", [oscInt(trackIndex)])).args, trackIndex);
        const clash = clips.find(clip => clip.startBeats < end - 1e-6 && clip.endBeats > start + 1e-6);
        if (clash) throw new Error(`Track '${trackNames[trackIndex]}' already has Arrangement clip '${clash.name}' at ${clash.startBeats}-${clash.endBeats} beats, inside the range being built (${start}-${end}). Clear it or start later with startBar.`);
      }
      const locators = input.locators ?? true;
      if (locators && !(input.dryRun ?? false)) {
        const playing = (await this.live.query("/live/song/get/is_playing")).args.at(-1) === true;
        if (playing) throw new Error("Stop playback first: Live adds locators at the playhead. Or pass locators: false.");
      }
      const summary = (section: PlannedSection) => ({ name: section.name, scene: section.sceneIndex + 1, bars: section.endBeats - section.startBeats <= beatsPerBar + 1e-6 ? String(section.startBeats / beatsPerBar + 1) : `${section.startBeats / beatsPerBar + 1}-${section.endBeats / beatsPerBar}`, startBeats: section.startBeats, endBeats: section.endBeats, tracks: section.tracks.map(track => track.trackName) });
      if (input.dryRun ?? false) return { dryRun: true, beatsPerBar, sections: plan.map(summary) };

      const gaps: string[] = [];
      for (const section of plan) {
        for (const track of section.tracks) {
          await this.live.send("/live/arrangement/place_section", [oscInt(track.trackIndex), oscInt(section.sceneIndex), oscFloat(section.startBeats), oscFloat(section.endBeats)]);
          const length = section.endBeats - section.startBeats;
          const remainder = length - Math.floor(length / track.clipLength + 1e-6) * track.clipLength;
          if (remainder > 1e-6 && track.kind !== "midi") gaps.push(`'${track.trackName}' in ${section.name}: its ${track.clipLength}-beat audio clip does not divide the section, so the last ${Math.round(remainder * 1000) / 1000} beats are empty.`);
        }
        if (locators) {
          const added = await this.locators.addLocator(section.startBeats, section.name);
          if (!added.ok) throw new Error(`Placed the clips, but the locator for ${section.name} failed: ${added.error?.message}`);
        }
      }
      // Check every track's clips cover its sections without running past them.
      const problems: string[] = [];
      for (const trackIndex of touched) {
        const clips = parseArrangementClips((await this.live.query("/live/track/get/arrangement_clips", [oscInt(trackIndex)])).args, trackIndex);
        for (const section of plan.filter(item => item.tracks.some(track => track.trackIndex === trackIndex))) {
          const inside = clips.filter(clip => clip.startBeats >= section.startBeats - 1e-6 && clip.startBeats < section.endBeats - 1e-6);
          if (!inside.length) problems.push(`'${trackNames[trackIndex]}' has nothing in ${section.name}`);
          const over = inside.find(clip => clip.endBeats > section.endBeats + 1e-6);
          if (over) problems.push(`'${trackNames[trackIndex]}' clip '${over.name}' runs past the end of ${section.name}`);
        }
      }
      if (problems.length) throw new Error(`Built the sections, but the check found: ${problems.join("; ")}.`);
      return { beatsPerBar, sections: plan.map(summary), locators, gaps, note: "Each section on each track is its own undo step." };
    });
  }
}
