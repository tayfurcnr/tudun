# Architecture

TUDUN has three application layers:

1. `src/renderer/` presents service data and handles user interaction. It has no Node.js integration.
2. `src/preload/` exposes a small, explicit API through Electron's context bridge.
3. `src/main/` handles IPC, settings, systemd commands, Polkit requests, journal streaming, and file export.

The BrowserWindow uses context isolation and sandboxing. External navigation and new windows are blocked. Service actions accept only `start`, `stop`, `restart`, `enable`, and `disable`. The main process checks unit names against the latest service inventory before passing them to `systemctl` through `pkexec`.

`systemctl list-unit-files` and `systemctl show` populate the service list. The renderer refreshes it every five seconds. `journalctl` provides historical and live logs; live output is sent from the main process to the renderer by IPC. User preferences are stored in Electron's per-user configuration directory.

The Debian builder in `packaging/linux/build_deb.py` bundles the Electron runtime, application sources, icon, desktop entry, and launcher into an `amd64` package. The source menu installer in `packaging/linux/install-menu.sh` creates a per-user desktop entry pointing to the checkout.
