# Porting Ableton Control Deck to Linux and Windows

Control Deck currently supports **macOS only**, but that's an implementation detail, not an architectural one. The two foundations — Live's remote-script API and Node.js — are fully cross-platform, so the remote script, the MCP server, the UDP protocol, and the dashboard all run unchanged on Linux (Live itself permitting) and Windows today. What's missing is the platform plumbing around them. Contributions are very welcome; this file is the map.

## What already works everywhere

| Component | Why it's portable |
|---|---|
| `remote-script/Control_Deck/` | Runs inside Live's own Python runtime; the UDP listener is stdlib, not OS API |
| `src/` (MCP server) | Pure Node + TypeScript, stdio transport, zero native dependencies |
| `src/ableton-client.ts` + `src/dashboard-server.mjs` | Pure Node, loopback sockets |
| `max-for-live/` | Max for Live devices are platform-neutral where Live + Max run |
| `dashboard/` | Plain Next.js |

## What needs porting

| Piece | macOS implementation | Windows |
|---|---|---|
| Plug-in scanner paths (`src/plugin-index.mjs`) | `/Library/Audio/Plug-Ins/…` and the user equivalent; AU is macOS-only | `%COMMONPROGRAMFILES%\VST3`, `%COMMONPROGRAMFILES%\CLAP`, common VST2 dirs |
| Remote-script install path (`scripts/setup.mjs`) | `~/Music/Ableton/User Library/Remote Scripts` | `%USERPROFILE%\Documents\Ableton\User Library\Remote Scripts` |
| Service autostart (`scripts/setup.mjs`) | launchd user agents + `launchctl` | Task Scheduler entries or Startup shortcuts |
| Sample-root guard (`src/sample-index.ts`) | requires the root under `/Volumes/` | equivalent removable/secondary-drive check |
| Installer entry point | `Install Ableton Control Deck.command` | `.cmd`/PowerShell script |
| Small portability nits | — | `process.getuid()` guard in setup; path separators are already handled by `node:path` |

(Linux is listed for completeness of the code's portability, but Ableton Live itself does not ship a Linux build — a Linux column only matters for people running Live under a compatibility layer.)

A minimum viable Windows port is: plugin paths, remote-script path, autostart, the sample-root guard, an installer script, and docs.

## Ground rules for a port

- Keep the security posture: loopback-only binds, per-install secret, no new listening surfaces.
- Keep `npm run setup` as the single entry point, branching on `process.platform` — don't fork per-OS setup scripts.
- Keep every user-facing setup message understandable without a coding background; the double-click installer runs the same engine.
- Verify with the existing checks: `npm run check`, `npm test`, `npm run test:bridge`, and `dashboard npm run check` must pass on the target platform.

If you start a port, open an issue so effort doesn't get duplicated.
