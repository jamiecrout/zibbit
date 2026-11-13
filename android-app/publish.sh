#!/usr/bin/env bash
# Prepares an app update for the servers to offer: copies the APK into a folder together with latest.json
# (version, size, SHA-256). Publish that folder's two files to the update location (the public zibbit-android repo,
# in the alpha/ folder for test builds or its top level for the stable app); every server picks it up within minutes.
# Usage: SDK=<android sdk> bash publish.sh <built.apk> <folder>
set -euo pipefail
SDK=${SDK:?set SDK to the Android SDK root}
APK=${1:?built apk}; DEST=${2:?destination folder}
BADGE=$("$SDK/build-tools/34.0.0/aapt2" dump badging "$APK" | grep -m1 "^package:" || true)
VC=$(sed -n "s/.*versionCode='\([0-9]*\)'.*/\1/p" <<<"$BADGE"); VN=$(sed -n "s/.*versionName='\([^']*\)'.*/\1/p" <<<"$BADGE")
[ -n "$VC" ] && [ -n "$VN" ] || { echo "could not read the version from $APK"; exit 1; }
mkdir -p "$DEST"
NAME=$(basename "$APK")
cp "$APK" "$DEST/$NAME"
SHA=$(sha256sum "$DEST/$NAME" | cut -d' ' -f1); SIZE=$(stat -c %s "$DEST/$NAME")
printf '{\n  "versionCode": %s,\n  "versionName": "%s",\n  "file": "%s",\n  "size": %s,\n  "sha256": "%s"\n}\n' "$VC" "$VN" "$NAME" "$SIZE" "$SHA" > "$DEST/latest.json"
( cd "$DEST" && sha256sum "$NAME" > SHA256SUMS )
echo "ready: $DEST ($VN, code $VC)"
