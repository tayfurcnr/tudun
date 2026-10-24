# Architecture

TUDUN has three application layers:

1. `src/renderer/` presents service data and handles user interaction. It has no Node.js integration.
2. `src/preload/` exposes a small, explicit API through Electron's context bridge.
3. `src/main/` handles IPC, settings, systemd commands, Polkit requests, journal streaming, and file export.

The BrowserWindow uses context isolation and sandboxing. External navigation and new windows are blocked. Service actions accept only `start`, `stop`, `restart`, `enable`, and `disable`. The main process checks unit names against the latest service inventory before passing them to `systemctl` through `pkexec`.

`systemctl list-unit-files` and `systemctl show` populate the service list. The renderer refreshes it every five seconds. `journalctl` provides historical and live logs; live output is sent from the main process to the renderer by IPC. User preferences are stored in Electron's per-user configuration directory.

Remote computers use `src/main/remote.js`. The main process validates `user@host` destinations and unit names, then runs `systemctl` and `journalctl` reads through OpenSSH with batch authentication and strict host-key checking. For first-time setup, `ssh-keyscan` retrieves a candidate host key, the renderer presents its SHA-256 fingerprint, and `ssh2` pins that exact key while authenticating with the remote user's password. After approval, Tudun installs an app-specific Ed25519 public key on the remote account and records the host key in the user's `known_hosts`. The SSH password is never stored. Remote service actions and startup changes use an allowlist of systemctl verbs and require sudo. Remote unit creation and editing reuse the privileged write helper over SSH. Remote deletion reuses the local deletion helper, checks the unit path and content revision, stops and disables the unit, removes its file, and reloads systemd. The sudo password travels through the encrypted SSH session on standard input for that operation only; it is never stored. Saved destinations and the selected computer live in user settings. Remote resource analysis is disabled because local cgroup paths do not describe remote services.

The Debian builder in `packaging/linux/build_deb.py` bundles the Electron runtime, application sources, production JavaScript dependencies, icon, desktop entry, and launcher into `amd64` and `arm64` packages. The source menu installer in `packaging/linux/install-menu.sh` creates a per-user desktop entry pointing to the checkout.
