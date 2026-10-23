#!/bin/sh
set -eu

APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
if [ ! -x "$APP_DIR/node_modules/electron/dist/electron" ]; then
    printf 'Electron is missing. Run npm install first.\n' >&2
    exit 1
fi
APPLICATIONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
ICON_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/icons/hicolor/scalable/apps"
mkdir -p "$APPLICATIONS_DIR"
mkdir -p "$ICON_DIR"
sed "s|@APP_PATH@|$APP_DIR|g" "$APP_DIR/packaging/linux/tudun.desktop.in" > "$APPLICATIONS_DIR/tudun.desktop"
cp "$APP_DIR/assets/icons/tudun.svg" "$ICON_DIR/tudun.svg"
chmod 644 "$APPLICATIONS_DIR/tudun.desktop"
printf 'Installed: TUDUN is available in the application menu.\n'
