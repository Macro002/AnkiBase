#!/usr/bin/env python3
"""Publish dist/AnkiBase-<version>-<build>.ipa to the SideStore source on `ssh watch`.

The app gets its own feed (ankibase-source.json) and is merged into the shared
source.json there, leaving the other apps' entries alone. Released files are never
replaced: bump CFBundleVersion in Info.plist for every new build.

    scripts/publish.py "What changed in this build"
"""
import datetime
import hashlib
import json
import plistlib
import struct
import subprocess
import sys
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parent.parent
base_url = "https://watch.macr0.dev/static/ios"
info = plistlib.loads((root / "Info.plist").read_bytes())
version, build = info["CFBundleShortVersionString"], info["CFBundleVersion"]
ipa = root / "dist" / f"AnkiBase-{version}-{build}.ipa"
icon = root / "Sources/AnkiBase/Resources/AppIcon.png"
notes = sys.argv[1] if len(sys.argv) > 1 else ""
assert notes, "Pass the release notes"

with zipfile.ZipFile(ipa) as archive:
    assert archive.testzip() is None, "Damaged IPA"
    names = archive.namelist()
    plist_path, = [n for n in names if n.count("/") == 2 and n.endswith(".app/Info.plist")]
    app_dir = plist_path.removesuffix("Info.plist")
    built = plistlib.loads(archive.read(plist_path))
    assert built["CFBundleIdentifier"] == "dev.macr0.ankibase"
    assert (built["CFBundleShortVersionString"], built["CFBundleVersion"]) == (version, build), "Rebuild first"
    assert app_dir + "AnkiBase_AnkiBase.bundle/web/index.html" in names, "Missing web UI"
    executable = archive.read(app_dir + built["CFBundleExecutable"])
    assert struct.unpack_from("<II", executable) == (0xFEEDFACF, 0x0100000C), "Expected ARM64 Mach-O"
    assert b"_ab_handle" in executable, "Anki engine not linked"
    assert app_dir + "AnkiBase_AnkiBase.bundle/pages/index.html" in names, "Missing Anki's pages"
    assert app_dir + "Icon-Midnight@3x.png" in names, "Missing theme icons"
    assert not any("embedded.mobileprovision" in n for n in names), "Expected unsigned build"

date = datetime.date.today().isoformat()
description = ("AnkiBase with Anki's own engine on your iPhone: your collection lives on the phone, "
               "studying works offline and syncs straight with AnkiWeb. Stories, AI and Quizlet come "
               "from your AnkiBase server. Unsigned build — SideStore signs it with your Apple ID.")
ipa_name, icon_name = ipa.name, f"AnkiBase-icon-{version}-{build}.png"
download = f"{base_url}/{ipa_name}"
release = {"version": version, "buildVersion": build, "date": date, "localizedDescription": notes,
           "downloadURL": download, "size": ipa.stat().st_size, "minOSVersion": built["MinimumOSVersion"]}
app = {
    "name": "AnkiBase", "bundleIdentifier": "dev.macr0.ankibase", "developerName": "macr0",
    "localizedDescription": description, "iconURL": f"{base_url}/{icon_name}", "tintColor": "E94560",
    "category": "education", "versions": [release], "appPermissions": {"entitlements": [], "privacy": {}},
    "version": version, "versionDate": date, "versionDescription": notes,
    "downloadURL": download, "size": ipa.stat().st_size,
}
source = {"name": "AnkiBase", "identifier": "dev.macr0.ankibase.source",
          "sourceURL": f"{base_url}/ankibase-source.json", "apps": [app], "news": []}
feed = root / "dist/ankibase-source.json"
feed.write_text(json.dumps(source, indent=2) + "\n")

files = {ipa_name: ipa, icon_name: icon, "ankibase-source.json": feed}
checksums = {name: hashlib.sha256(path.read_bytes()).hexdigest() for name, path in files.items()}

# Runs on watch once everything is uploaded: verify, publish files, then the feeds.
remote_program = r'''
import datetime, hashlib, json, shutil, sys
from pathlib import Path

stage = Path(sys.argv[1])
destination = Path("/opt/aniworld/src/aniworld/web/static/ios")
checksums = json.loads((stage / "checksums.json").read_text())
for name, expected in checksums.items():
    assert Path(name).name == name
    assert hashlib.sha256((stage / name).read_bytes()).hexdigest() == expected
    target = destination / name
    if target.exists() and name != "ankibase-source.json":
        assert hashlib.sha256(target.read_bytes()).hexdigest() == expected, "Bump the build before replacing a release"

source_path = destination / "source.json"
original = source_path.read_bytes()
shared = json.loads(original)
app = json.loads((stage / "ankibase-source.json").read_text())["apps"][0]
shared["apps"] = [a for a in shared["apps"] if a["bundleIdentifier"] != app["bundleIdentifier"]] + [app]

backups = Path("/root/.local/state/ankibase")
backups.mkdir(parents=True, exist_ok=True)
stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
(backups / f"source-{stamp}.json").write_bytes(original)

for name in checksums:
    temporary = destination / (name + ".ankibase-upload")
    shutil.copyfile(stage / name, temporary)
    temporary.chmod(0o644)
    temporary.replace(destination / name)
temporary = destination / "source.json.ankibase-upload"
temporary.write_text(json.dumps(shared, indent=2) + "\n")
temporary.chmod(0o644)
assert source_path.read_bytes() == original, "Feed changed during upload; retry"
temporary.replace(source_path)
print("Published AnkiBase; the other apps' entries are unchanged.")
'''

ssh = ["ssh", "-o", "BatchMode=yes", "watch"]
stage = subprocess.check_output(ssh + ["mktemp -d /tmp/ankibase.XXXXXXXX"], text=True).strip()
assert stage.startswith("/tmp/ankibase.") and stage.replace("/", "").replace(".", "").isalnum()
try:
    (root / "dist/checksums.json").write_text(json.dumps(checksums))
    for name, path in {**files, "checksums.json": root / "dist/checksums.json"}.items():
        subprocess.run(["scp", "-q", str(path), f"watch:{stage}/{name}"], check=True)
    subprocess.run(ssh + [f"python3 - {stage}"], input=remote_program, text=True, check=True)
finally:
    subprocess.run(ssh + [f"rm -rf -- {stage}"], check=True)
print(f"{base_url}/source.json  (shared)")
print(f"{base_url}/ankibase-source.json  (AnkiBase only)")
print(f"SHA-256 {ipa_name}: {checksums[ipa_name]}")
