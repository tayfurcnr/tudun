#!/usr/bin/env python3
"""Build an Ubuntu .deb bundling the Electron runtime and app sources."""

import json
import argparse
import os
import shutil
import struct
import subprocess
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
PACKAGE = "tudun"
APP_DIR_NAME = "tudun"
with open(os.path.join(ROOT, "package.json"), encoding="utf-8") as package_file:
    VERSION = json.load(package_file)["version"]
OUTPUT_DIR = os.path.join(ROOT, "dist")
ELF_MACHINES = {"amd64": 62, "arm64": 183}


def write(path, content, mode=0o644):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as file:
        file.write(content)
    os.chmod(path, mode)


def copy(source, destination):
    os.makedirs(os.path.dirname(destination), exist_ok=True)
    shutil.copy2(source, destination)


def electron_architecture(binary):
    with open(binary, "rb") as executable:
        header = executable.read(20)
    if len(header) < 20 or header[:4] != b"\x7fELF" or header[4] != 2 or header[5] != 1:
        raise SystemExit("Electron binary is not a 64-bit little-endian ELF executable.")
    return struct.unpack_from("<H", header, 18)[0]


def main():
    parser = argparse.ArgumentParser(description="Build an Ubuntu package for amd64 or arm64")
    parser.add_argument("--arch", choices=ELF_MACHINES, default=subprocess.check_output(["dpkg", "--print-architecture"], text=True).strip())
    parser.add_argument("--electron-dist", default=os.path.join(ROOT, "node_modules", "electron", "dist"))
    args = parser.parse_args()
    if args.arch not in ELF_MACHINES:
        raise SystemExit(f"Unsupported Debian architecture: {args.arch}")
    electron_dist = os.path.abspath(args.electron_dist)
    electron_binary = os.path.join(electron_dist, "electron")
    if not os.path.isfile(os.path.join(electron_dist, "electron")):
        if args.electron_dist == os.path.join(ROOT, "node_modules", "electron", "dist"):
            installer = os.path.join(ROOT, "node_modules", "electron", "install.js")
            if os.path.isfile(installer):
                subprocess.run(["node", installer], check=True)
        if not os.path.isfile(electron_binary):
            raise SystemExit("Electron is missing. Run npm ci first.")
    if electron_architecture(electron_binary) != ELF_MACHINES[args.arch]:
        raise SystemExit(f"Electron binary architecture does not match {args.arch}. Use the matching runtime or npm run package:deb:arm64.")
    output = os.path.join(OUTPUT_DIR, f"{PACKAGE}_{VERSION}_{args.arch}.deb")
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="tudun-deb-") as temp:
        stage = os.path.join(temp, "package")
        write(os.path.join(stage, "DEBIAN", "control"), f"""Package: {PACKAGE}
Version: {VERSION}
Section: admin
Priority: optional
Architecture: {args.arch}
Depends: libc6 (>= 2.28), libstdc++6, libgtk-3-0, libnss3, libxss1, libxtst6, libatspi2.0-0, libasound2, libgbm1, systemd, policykit-1, python3, openssh-client
Maintainer: TUDUN Contributors
Description: TUDUN systemd service manager
 Electron desktop application for monitoring and managing system services.
 Supports Ubuntu 20.04 and 22.04, including JetPack 5 and 6 on arm64.
""")
        app_dir = os.path.join(stage, "usr", "lib", APP_DIR_NAME)
        os.makedirs(app_dir, exist_ok=True)
        copy(os.path.join(ROOT, "package.json"), os.path.join(app_dir, "package.json"))
        copy(os.path.join(ROOT, "LICENSE"), os.path.join(stage, "usr", "share", "doc", PACKAGE, "copyright"))
        shutil.copytree(os.path.join(ROOT, "src"), os.path.join(app_dir, "src"), ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        with open(os.path.join(ROOT, "package-lock.json"), encoding="utf-8") as lock_file:
            locked = json.load(lock_file)["packages"]
        for name, metadata in locked.items():
            if not name.startswith("node_modules/") or metadata.get("dev") or metadata.get("optional"):
                continue
            source = os.path.join(ROOT, name)
            if not os.path.isdir(source):
                raise SystemExit(f"Production dependency is missing: {name}. Run npm ci first.")
            shutil.copytree(source, os.path.join(app_dir, name), ignore=shutil.ignore_patterns("*.node", "*.pdb", "__pycache__"))
        shutil.copytree(electron_dist, os.path.join(app_dir, "electron"), ignore=shutil.ignore_patterns("*.pdb"))
        sandbox_helper = os.path.join(app_dir, "electron", "chrome-sandbox")
        if not os.path.isfile(sandbox_helper):
            raise SystemExit("Electron sandbox helper is missing.")
        os.chmod(sandbox_helper, 0o4755)
        shutil.copytree(os.path.join(ROOT, "assets"), os.path.join(app_dir, "assets"))
        copy(os.path.join(ROOT, "assets", "icons", "tudun.svg"), os.path.join(stage, "usr", "share", "icons", "hicolor", "scalable", "apps", "tudun.svg"))
        desktop_template = os.path.join(ROOT, "packaging", "linux", "tudun.desktop.in")
        with open(desktop_template, encoding="utf-8") as desktop_file:
            desktop_entry = desktop_file.read().replace("Exec=@APP_PATH@/scripts/run.sh", "Exec=tudun")
        write(os.path.join(stage, "usr", "share", "applications", "tudun.desktop"), desktop_entry)
        launcher = f"#!/bin/sh\nset -eu\nunset ELECTRON_RUN_AS_NODE ELECTRON_NO_ATTACH_CONSOLE\nexec /usr/lib/{APP_DIR_NAME}/electron/electron /usr/lib/{APP_DIR_NAME} \"$@\"\n"
        write(os.path.join(stage, "usr", "bin", "tudun"), launcher, 0o755)
        subprocess.run(["dpkg-deb", "--build", "--root-owner-group", "-Zxz", stage, output], check=True)
    print(output)


if __name__ == "__main__":
    main()
