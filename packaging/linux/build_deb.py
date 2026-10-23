#!/usr/bin/env python3
"""Build an Ubuntu .deb bundling the Electron runtime and app sources."""

import json
import os
import shutil
import subprocess
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PACKAGE = "tudun"
APP_DIR_NAME = "tudun"
with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as package_file:
    VERSION = json.load(package_file)["version"]
OUTPUT_DIR = os.path.join(ROOT, "dist")
OUTPUT = os.path.join(OUTPUT_DIR, f"{PACKAGE}_{VERSION}_amd64.deb")


def write(path, content, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        file.write(content)
    os.chmod(path, mode)


def copy(source, destination):
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copy2(source, destination)


def main():
    electron_dist = os.path.join(ROOT, "node_modules", "electron", "dist")
    if not os.path.isfile(os.path.join(electron_dist, "electron")):
        raise SystemExit("Electron is missing. Run npm install first.")
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tudun-deb-") as temp:
        stage = os.path.join(temp, "package")
        write(os.path.join(stage, "DEBIAN", "control"), f"""Package: {PACKAGE}
Version: {VERSION}
Section: admin
Priority: optional
Architecture: amd64
Depends: libc6 (>= 2.28), libstdc++6, libgtk-3-0, libnss3, libxss1, libxtst6, libatspi2.0-0, libasound2, libgbm1, systemd, policykit-1
Maintainer: TUDUN Contributors
Description: TUDUN systemd service manager
 Electron desktop application for monitoring and managing system services.
 Supports Ubuntu 20.04 and 22.04.
""")
        app_dir = os.path.join(stage, "usr", "lib", APP_DIR_NAME)
        os.makedirs(app_dir, exist_ok=True)
        copy(os.path.join(ROOT, "package.json"), os.path.join(app_dir, "package.json"))
        copy(os.path.join(ROOT, "LICENSE"), os.path.join(stage, "usr", "share", "doc", PACKAGE, "copyright"))
        shutil.copytree(os.path.join(ROOT, "src"), os.path.join(app_dir, "src"), ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        shutil.copytree(electron_dist, os.path.join(app_dir, "electron"), ignore=shutil.ignore_patterns("*.pdb"))
        shutil.copytree(os.path.join(ROOT, "assets"), os.path.join(app_dir, "assets"))
        copy(os.path.join(ROOT, "assets", "icons", "tudun.svg"), os.path.join(stage, "usr", "share", "icons", "hicolor", "scalable", "apps", "tudun.svg"))
        desktop_template = os.path.join(ROOT, "packaging", "linux", "tudun.desktop.in")
        with open(desktop_template, encoding="utf-8") as desktop_file:
            desktop_entry = desktop_file.read().replace("Exec=@APP_PATH@/scripts/run.sh", "Exec=tudun")
        write(os.path.join(stage, "usr", "share", "applications", "tudun.desktop"), desktop_entry)
        launcher = f"#!/bin/sh\nset -eu\nunset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE\nexec /usr/lib/{APP_DIR_NAME}/electron/electron /usr/lib/{APP_DIR_NAME} \"$@\"\n"
        write(os.path.join(stage, "usr", "bin", "tudun"), launcher, 0o755)
        subprocess.run(["dpkg-deb", "--build", "--root-owner-group", "-Zzstd", stage, OUTPUT], check=True)
    print(OUTPUT)


if __name__ == "__main__":
    main()
