#!/bin/zsh
set -euo pipefail

PROJECT_ROOT="${0:A:h:h}"
BUILD_DIR="$PROJECT_ROOT/max-for-live/build"
TARGET_DIR="$HOME/Music/Ableton/User Library/Presets/Instruments/Max Instrument/Control Deck"

node "$PROJECT_ROOT/max-for-live/build-device.mjs"
mkdir -p "$TARGET_DIR"
cp "$BUILD_DIR/Control Deck OmniHost.amxd" "$TARGET_DIR/Control Deck OmniHost.amxd"
cp "$BUILD_DIR/omnihost-controller.js" "$TARGET_DIR/omnihost-controller.js"
print "Installed Control Deck OmniHost at: $TARGET_DIR"

