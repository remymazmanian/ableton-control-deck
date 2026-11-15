# Platforms

Control Deck runs on **macOS** and **Windows** (x64 and Arm64). Live has no Linux build, so Linux is out of scope.

## Where the platforms differ

All of it sits in `src/platform.mjs` (plain JavaScript, so setup can use it before anything is built), with small TypeScript copies in `src/external-drive.ts` and `src/machine-token.ts` that `tests/platform.test.ts` keeps in agreement.

| Piece | macOS | Windows |
|---|---|---|
| User Library | read from `~/Library/Preferences/Ableton/Live */Library.cfg`, else `~/Music/Ableton/User Library` | read from `%APPDATA%\Ableton\Live *\Preferences\Library.cfg`, else `Documents\Ableton\User Library` |
| Bridge secret | `~/Library/Application Support/Ableton Control Deck/bridge-token` | `%LOCALAPPDATA%\Ableton Control Deck\bridge-token` |
| Plug-in folders (`src/plugin-index.mjs`) | `/Library/Audio/Plug-Ins/…` and the user equivalent, with AU | `Common Files\VST3`, `CLAP`, `VST2`, `VSTPlugins`, and `%LOCALAPPDATA%\Programs\Common\…` |
| Services (`scripts/setup.mjs`) | launchd user agents | Task Scheduler tasks at sign-in, S4U, restarted on failure |
| Sample-root guard | under `/Volumes/` | a drive other than the system drive |
| Installer | `Install Ableton Control Deck.command` | `Install Ableton Control Deck.cmd` |

## Ground rules

- Keep the security posture: loopback-only binds, per-install secret, no new listening surfaces.
- Keep `npm run setup` as the single entry point, branching on `process.platform` — don't fork per-OS setup scripts.
- Keep every user-facing setup message understandable without a coding background; the double-click installer runs the same engine.
- Verify with the existing checks: `npm run check`, `npm test`, `npm run test:bridge`, and `dashboard npm run check` must pass on the target platform.

