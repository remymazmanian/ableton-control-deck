#!/bin/zsh
# Builds the signed, notarized macOS installer: build/Ableton Control Deck <version>.pkg
#
#   npm run build:pkg                   build, sign, notarize, staple
#   npm run build:pkg -- --no-notarize  build and sign only
#   npm run build:pkg -- --notarize-only  notarize and staple the last build
#
# What it installs:
#   /Library/Application Support/Ableton Control Deck   the built runtime (read-only) with Node for
#                                                       Apple silicon and Intel, from nodejs.org
#   /Applications/Ableton Control Deck/                 the app and its uninstaller
# Postinstall then runs setup for the signed-in user. Their settings and data go in
# ~/Library/Application Support/Ableton Control Deck.
#
# Signing uses the Developer ID certificates by fingerprint (two Application certificates share a name)
# and the notarytool keychain profile "rm-notary". Override with APP_IDENTITY, INSTALLER_IDENTITY, and
# NOTARY_PROFILE.
set -euo pipefail

ROOT="${0:A:h:h:h}"
cd "$ROOT"
VERSION=$(node -p 'require("./package.json").version')
NODE_VERSION=$(node -p 'require("./installer/node-version.json").version')
APP_IDENTITY="${APP_IDENTITY:-A00A2DE44694E3A2E34E87A22142E603D2AC5E66}"
INSTALLER_IDENTITY="${INSTALLER_IDENTITY:-2D3C45C1351FD90045A0267DF1D0AE102EB38F7C}"
NOTARY_PROFILE="${NOTARY_PROFILE:-rm-notary}"
NODE_TEAM="HX7739G8FX"   # Node.js Foundation's Apple team, which signs the official macOS binaries
PKG_ID="com.abletondeck.controldeck"

BUILD="$ROOT/build/pkg"
CACHE="$ROOT/build/node-cache"
FS="$BUILD/root"
RUNTIME="$FS/Library/Application Support/Ableton Control Deck"
APPS="$FS/Applications/Ableton Control Deck"
OUTPUT="$ROOT/build/Ableton Control Deck $VERSION.pkg"

notarize=1
only_notarize=0
for argument in "$@"; do
  case "$argument" in
    --no-notarize) notarize=0 ;;
    --notarize-only) only_notarize=1 ;;
    *) print -u2 "Unknown option: $argument"; exit 2 ;;
  esac
done

step() { print "\n▸ $1" }

notarize_package() {
  step "Notarizing (this can take a while)"
  xcrun notarytool submit "$OUTPUT" --keychain-profile "$NOTARY_PROFILE" --wait --timeout 2h
  xcrun stapler staple "$OUTPUT"
  spctl --assess --type install -vv "$OUTPUT"
}

if (( only_notarize )); then
  notarize_package
  exit 0
fi

# ------------------------------------------------------------------ runtime
step "Staging the runtime"
rm -rf "$BUILD"
mkdir -p "$RUNTIME" "$APPS" "$CACHE"
git ls-files -z | rsync -a --from0 --files-from=- ./ "$RUNTIME/"
rm -rf "$RUNTIME"/{tests,docs,macos,installer,.github} "$RUNTIME/remote-script/tests" "$RUNTIME/dashboard/tests" \
  "$RUNTIME"/Install\ Ableton\ Control\ Deck.* "$RUNTIME/.gitattributes" "$RUNTIME/.gitignore"

step "Building"
(
  cd "$RUNTIME"
  npm ci --no-fund --no-audit --loglevel=error
  npm run --silent build
  node max-for-live/build-device.mjs >/dev/null
  cd dashboard
  npm ci --no-fund --no-audit --loglevel=error
  npm run --silent build >/dev/null
)

step "Removing build-only files"
(
  cd "$RUNTIME"
  npm prune --omit=dev --no-fund --no-audit --loglevel=error
  cd dashboard
  npm prune --omit=dev --no-fund --no-audit --loglevel=error
  # Compilers and image tools Next.js only needs while building, all native code for one architecture.
  rm -rf .next/cache node_modules/@next/swc-* node_modules/@img node_modules/sharp
)
rm -rf "$RUNTIME/max-for-live/build/"*.tmp(N) "$RUNTIME/tsconfig.json" "$RUNTIME/vitest.config.ts"
print -r -- "{ \"version\": \"$VERSION\", \"node\": \"$NODE_VERSION\" }" > "$RUNTIME/packaged.json"

native=$(find "$RUNTIME" -type f \( -perm -u+x -o -name '*.node' -o -name '*.dylib' -o -name '*.so' \) -exec file {} + | grep -E "Mach-O" || true)
if [[ -n "$native" ]]; then
  print -u2 "Unexpected native code in the runtime (it would need signing for both architectures):"
  print -u2 -- "$native"
  exit 1
fi

# --------------------------------------------------------------------- Node
step "Node.js $NODE_VERSION from nodejs.org"
base="https://nodejs.org/dist/v$NODE_VERSION"
curl -fsSL "$base/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
for arch in arm64 x64; do
  archive="node-v$NODE_VERSION-darwin-$arch.tar.gz"
  [[ -f "$CACHE/$archive" ]] || curl -fsSL "$base/$archive" -o "$CACHE/$archive"
  expected=$(awk -v name="$archive" '$2 == name { print $1 }' "$CACHE/SHASUMS256-$NODE_VERSION.txt")
  actual=$(shasum -a 256 "$CACHE/$archive" | awk '{ print $1 }')
  if [[ -z "$expected" || "$expected" != "$actual" ]]; then
    rm -f "$CACHE/$archive"
    print -u2 "Checksum mismatch for $archive; deleted it. Run the build again."
    exit 1
  fi
  mkdir -p "$RUNTIME/node/$arch/bin"
  tar -xzf "$CACHE/$archive" -C "$RUNTIME/node/$arch" --strip-components 1 "node-v$NODE_VERSION-darwin-$arch/bin/node" "node-v$NODE_VERSION-darwin-$arch/LICENSE"
  codesign --verify --strict "$RUNTIME/node/$arch/bin/node"
  team=$(codesign -dv "$RUNTIME/node/$arch/bin/node" 2>&1 | awk -F= '/^TeamIdentifier/ { print $2 }')
  if [[ "$team" != "$NODE_TEAM" ]]; then
    print -u2 "The $arch Node binary is signed by team $team, not the Node.js Foundation ($NODE_TEAM)."
    exit 1
  fi
  print "  $arch: checksum matches, signed by the Node.js Foundation"
done
print -r -- "$NODE_VERSION" > "$RUNTIME/node/VERSION"
mkdir -p "$RUNTIME/bin"
cp installer/macos/node-launcher.sh "$RUNTIME/bin/node"
chmod 755 "$RUNTIME/bin/node"

# --------------------------------------------------------------------- apps
step "App and uninstaller"
CONTROL_DECK_BUILD_DIR="$BUILD/app" zsh macos/build-app.sh >/dev/null
ditto "$BUILD/app/Ableton Control Deck.app" "$APPS/Ableton Control Deck.app"
osacompile -o "$APPS/Uninstall Ableton Control Deck.app" installer/macos/uninstall.applescript
plutil -replace CFBundleIdentifier -string "com.abletondeck.uninstall" "$APPS/Uninstall Ableton Control Deck.app/Contents/Info.plist"
plutil -replace CFBundleShortVersionString -string "$VERSION" "$APPS/Uninstall Ableton Control Deck.app/Contents/Info.plist"
cp "$APPS/Ableton Control Deck.app/Contents/Resources/AppIcon.icns" "$APPS/Uninstall Ableton Control Deck.app/Contents/Resources/applet.icns"
xattr -cr "$APPS"
for app in "$APPS/Ableton Control Deck.app" "$APPS/Uninstall Ableton Control Deck.app"; do
  codesign --force --options runtime --timestamp --sign "$APP_IDENTITY" "$app"
  codesign --verify --strict --deep "$app"
done

# ------------------------------------------------------------------ package
step "Packaging"
find "$FS" -name .DS_Store -delete
pkgbuild --analyze --root "$FS" "$BUILD/components.plist" >/dev/null
# Install the apps where they belong even if a copy exists elsewhere on the disk.
index=0
while /usr/libexec/PlistBuddy -c "Print :$index" "$BUILD/components.plist" >/dev/null 2>&1; do
  /usr/libexec/PlistBuddy -c "Add :$index:BundleIsRelocatable bool false" "$BUILD/components.plist"
  index=$((index + 1))
done
pkgbuild --root "$FS" --component-plist "$BUILD/components.plist" --scripts installer/macos/scripts \
  --identifier "$PKG_ID" --version "$VERSION" --install-location / "$BUILD/control-deck.pkg" >/dev/null
sed "s/@VERSION@/$VERSION/" installer/macos/distribution.xml > "$BUILD/distribution.xml"
rm -f "$OUTPUT"
productbuild --distribution "$BUILD/distribution.xml" --package-path "$BUILD" --sign "$INSTALLER_IDENTITY" --timestamp "$OUTPUT" >/dev/null
pkgutil --check-signature "$OUTPUT" | sed -n 1,4p

if (( notarize )); then notarize_package; fi
print "\n$OUTPUT ($(du -h "$OUTPUT" | cut -f1))"
