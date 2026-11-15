#!/bin/zsh
# Builds the signed Windows installer on a Windows x64 machine over SSH and copies it back:
# build/Ableton-Control-Deck-<version>-Windows-Setup.exe
#
#   npm run build:win                   build and sign
#   npm run build:win -- --no-sign      build only
#
# WIN_HOST (default remym@remydesktop) needs Node.js, Inno Setup 6, and, for signing, the Windows SDK
# signtool with Azure Artifact Signing set up as in sign.cmd. The build uses tracked files only, so
# `git add` new files first.
set -euo pipefail

ROOT="${0:A:h:h:h}"
cd "$ROOT"
WIN_HOST="${WIN_HOST:-remym@remydesktop}"
WIN_DIR="C:/rm-build/ableton-control-deck"
VERSION=$(node -p 'require("./package.json").version')
LOCAL="$ROOT/build/win"
SETUP="Ableton-Control-Deck-$VERSION-Windows-Setup.exe"

sign_flag=""
for argument in "$@"; do
  case "$argument" in
    --no-sign) sign_flag="-NoSign" ;;
    *) print -u2 "Unknown option: $argument"; exit 2 ;;
  esac
done

step() { print "\n▸ $1" }

step "Packing the source"
rm -rf "$LOCAL"
mkdir -p "$LOCAL/icon"
git ls-files -z | COPYFILE_DISABLE=1 tar --null -T - --no-xattrs -czf "$LOCAL/src.tar.gz"

step "Icon"
CONTROL_DECK_BUILD_DIR="$LOCAL/app" zsh macos/build-app.sh >/dev/null
icns="$LOCAL/app/Ableton Control Deck.app/Contents/Resources/AppIcon.icns"
sizes=(16 24 32 48 64 256)
for size in $sizes; do sips -s format png -z $size $size "$icns" --out "$LOCAL/icon/$size.png" >/dev/null; done
node installer/windows/make-ico.mjs "$LOCAL/control-deck.ico" $LOCAL/icon/${^sizes}.png

step "Building on $WIN_HOST"
ssh -o BatchMode=yes "$WIN_HOST" "powershell -NoProfile -Command \"New-Item -ItemType Directory -Force '$WIN_DIR/installer' | Out-Null\""
scp -q "$LOCAL/src.tar.gz" "$LOCAL/control-deck.ico" "$WIN_HOST:$WIN_DIR/"
scp -q installer/windows/build-installer.ps1 installer/windows/control-deck.iss installer/windows/sign.cmd "$WIN_HOST:$WIN_DIR/installer/"
ssh -o BatchMode=yes "$WIN_HOST" "powershell -NoProfile -ExecutionPolicy Bypass -File $WIN_DIR/installer/build-installer.ps1 -Source $WIN_DIR/src.tar.gz -Work $WIN_DIR -Icon $WIN_DIR/control-deck.ico $sign_flag"

step "Copying the installer back"
scp -q "$WIN_HOST:$WIN_DIR/out/$SETUP" "$ROOT/build/"
print "\n$ROOT/build/$SETUP ($(du -h "$ROOT/build/$SETUP" | cut -f1))"
