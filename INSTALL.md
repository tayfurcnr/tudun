# Installing TUDUN

## Requirements

- Ubuntu 20.04 or 22.04 on an `amd64` desktop with systemd
- A working Polkit authentication agent for privileged service actions and journal access
- The Debian dependencies listed in the package manifest (installed automatically by `apt`)

The application package bundles Electron. You do not need Node.js to run the installed package.

## Install a `.deb`

From the project directory:

```bash
sudo apt install ./dist/tudun_1.0.0_amd64.deb
```

Open **Tudun** from the GNOME application menu, or run `tudun` in a terminal. A Polkit password dialog may appear when you change a service, save a unit file, or open its journal. Merely viewing the service list does not require elevation.

Use **Add service** to create a unit under `/etc/systemd/system`. Select a service and use **Edit unit** to edit a local unit or a systemd override for a package-provided unit. Review the file before saving. Saving reloads systemd, but a running service must be restarted separately to use new settings.

**Delete service** is available for local units. After confirmation, Tudun stops and disables the service, removes its unit file, and reloads systemd. Package-provided units cannot be deleted from this action.

To remove the installed package:

```bash
sudo apt remove tudun
```

Personal settings remain under the user's Electron configuration directory (`~/.config/tudun/`).

## Run from source

For development, install Node.js 22.12 or newer, Python 3, and `dpkg-deb`. Then run:

```bash
npm ci
npm start
```

To add the source checkout to your user application menu:

```bash
npm run install:menu
```

The menu entry points to this checkout. Keep the directory in place while using that entry. The menu installer does not install a system package.

## Build a package from source

```bash
npm ci
npm run package:deb
```

The resulting file is `dist/tudun_1.0.0_amd64.deb`. Build on a compatible Ubuntu machine. Test the package on the Ubuntu release you plan to use.

## Troubleshooting

- **Authentication dialog does not appear:** Ensure a Polkit authentication agent is running in your desktop session.
- **Service actions fail:** Check that your account is authorized for the requested systemd operation; TUDUN displays the command error returned by Polkit or systemd.
- **Logs are empty:** Choose a service and click **Live**, or select a historical time range. Some services have no journal entries in the selected range.
- **No services appear:** Check that `systemctl list-unit-files --type=service` works in a terminal and that the host uses systemd.
