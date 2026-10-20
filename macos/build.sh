#!/bin/sh
# Builds the menu bar app and wraps it in dist/Servedev Bar.app. SwiftPM makes a bare executable;
# notifications and launch at login only work from a signed bundle, so this assembles one.
#   macos/build.sh            build dist/Servedev Bar.app
#   macos/build.sh --install  also copy it to /Applications and open it
set -eu

here="$(cd "$(dirname "$0")" && pwd)"
root="$(dirname "$here")"
app="$root/dist/Servedev Bar.app"

cd "$here"
swift build -c release
bin="$(swift build -c release --show-bin-path)/ServedevBar"

rm -rf "$app"
mkdir -p "$app/Contents/MacOS"
cp "$bin" "$app/Contents/MacOS/ServedevBar"
cp "$here/Info.plist" "$app/Contents/Info.plist"
codesign --force -s - "$app"
echo "Built $app"

if [ "${1:-}" = "--install" ]; then
  # Quit a running copy first, or `open` just brings the old one forward.
  pkill -x ServedevBar 2>/dev/null || true
  rm -rf "/Applications/Servedev Bar.app"
  ditto "$app" "/Applications/Servedev Bar.app"
  open "/Applications/Servedev Bar.app"
  echo "Installed /Applications/Servedev Bar.app"
fi
