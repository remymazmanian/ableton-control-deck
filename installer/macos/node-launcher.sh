#!/bin/sh
# Runs Ableton Control Deck's Node. Uses a system Node (Homebrew or the nodejs.org installer) when it is
# newer than the bundled one, so security updates installed there apply at once; otherwise the bundled
# Node for this Mac's architecture.
here=$(cd "$(dirname "$0")/.." && pwd)
case "$(uname -m)" in
  arm64) bundled="$here/node/arm64/bin/node" ;;
  *) bundled="$here/node/x64/bin/node" ;;
esac
bundled_version=$(cat "$here/node/VERSION" 2>/dev/null)
pick="$bundled"
source=bundled
for candidate in /opt/homebrew/bin/node /usr/local/bin/node; do
  [ -x "$candidate" ] || continue
  if "$candidate" -e '
    const have = process.versions.node.split(".").map(Number);
    const bundled = (process.argv[1] || "0.0.0").split(".").map(Number);
    for (let i = 0; i < 3; i++) if (have[i] !== bundled[i]) process.exit(have[i] > bundled[i] ? 0 : 1);
    process.exit(1);
  ' "$bundled_version" 2>/dev/null; then
    pick="$candidate"
    source=system
    break
  fi
done
export NEXT_TELEMETRY_DISABLED=1
export CONTROL_DECK_NODE="$here/bin/node"
export CONTROL_DECK_NODE_SOURCE="$source"
export CONTROL_DECK_NODE_BUNDLED="$bundled_version"
exec "$pick" "$@"
