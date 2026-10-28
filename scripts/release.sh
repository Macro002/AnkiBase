#!/usr/bin/env bash
# Release vX.Y.Z: the iPhone app gets the version and a new build number, the tag goes
# up, GitHub builds the Android app and the Docker image into a draft release
# (.github/workflows/release.yml), and the iPhone .ipa built here is added before the
# release is published, so it appears with both apps.
#
#   scripts/release.sh v1.2.3
#
# Needs the gh CLI logged in and the iPhone build tools (ios/README.md).
set -euo pipefail
cd "$(dirname "$0")/.."
tag=${1:?usage: scripts/release.sh vX.Y.Z}
[[ $tag =~ ^v([0-9]+\.[0-9]+\.[0-9]+)$ ]] || { echo "Expected vX.Y.Z, got $tag" >&2; exit 1; }
version=${BASH_REMATCH[1]}
[ "$(git branch --show-current)" = main ] || { echo "Release from main" >&2; exit 1; }
[ -z "$(git status --porcelain)" ] || { echo "Commit or stash your changes first" >&2; exit 1; }
git fetch -q origin main --tags
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || { echo "main isn't in sync with origin" >&2; exit 1; }
! git rev-parse -q --verify "refs/tags/$tag" >/dev/null || { echo "$tag already exists" >&2; exit 1; }

echo "== iPhone app $version"
plist=ios/Info.plist
build=$(( $(sed -n 's:.*<key>CFBundleVersion</key><string>\([0-9]*\)</string>.*:\1:p' $plist) + 1 ))
sed -i -e "s:<key>CFBundleShortVersionString</key><string>[^<]*</string>:<key>CFBundleShortVersionString</key><string>$version</string>:" \
       -e "s:<key>CFBundleVersion</key><string>[0-9]*</string>:<key>CFBundleVersion</key><string>$build</string>:" $plist
ios/scripts/build.sh
ipa="ios/dist/release/AnkiBase-v$version.ipa"
[ -f "$ipa" ]
git commit -q -m "iOS: $version ($build)" $plist
git push -q origin main

echo "== Tag $tag"
git tag "$tag"
git push -q origin "$tag"

echo "== Waiting for the release workflow"
run=""
for _ in $(seq 1 30); do
  run=$(gh run list --workflow release.yml --branch "$tag" --limit 1 --json databaseId -q '.[0].databaseId')
  [ -n "$run" ] && break
  sleep 5
done
[ -n "$run" ] || { echo "The release workflow didn't start" >&2; exit 1; }
gh run watch "$run" --exit-status --interval 30 >/dev/null

echo "== Adding the iPhone app and publishing"
gh release upload "$tag" "$ipa"
gh release edit "$tag" --draft=false --latest
gh release view "$tag" --json url,assets -q '.url + "\n" + ([.assets[].name] | join("\n"))'
# Your own SideStore source, if this build has one (ios/local.env).
if grep -q '^PUBLISH_SSH_HOST=.' ios/local.env 2>/dev/null; then
  python3 ios/scripts/publish.py "AnkiBase $version"
fi
