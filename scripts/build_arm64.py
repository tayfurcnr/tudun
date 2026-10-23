#!/usr/bin/env python3
"""Build the arm64 package in an isolated temporary npm installation."""

import os
import shutil
import subprocess
import tempfile


ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def main():
    with tempfile.TemporaryDirectory(prefix="tudun-arm64-") as temp:
        for name in ("package.json", "package-lock.json"):
            shutil.copy2(os.path.join(ROOT, name), os.path.join(temp, name))
        subprocess.run(["npm", "ci", "--ignore-scripts"], cwd=temp, check=True)
        installer = os.path.join(temp, "node_modules", "electron", "install.js")
        environment = os.environ.copy()
        environment.update(ELECTRON_INSTALL_PLATFORM="linux", ELECTRON_INSTALL_ARCH="arm64")
        subprocess.run(["node", installer], cwd=temp, env=environment, check=True)
        runtime = os.path.join(temp, "node_modules", "electron", "dist")
        subprocess.run([
            "python3", os.path.join(ROOT, "packaging", "linux", "build_deb.py"),
            "--arch", "arm64", "--electron-dist", runtime
        ], check=True)


if __name__ == "__main__":
    main()
