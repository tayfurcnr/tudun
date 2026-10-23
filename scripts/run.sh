#!/bin/sh
set -eu
APP_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
unset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE
exec "$APP_DIR/node_modules/electron/dist/electron" "$APP_DIR" "$@"
