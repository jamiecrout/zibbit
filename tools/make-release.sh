#!/usr/bin/env bash
# Builds a clean source archive (no private notes folder, no keys, no build output, no config).
# Usage: bash tools/make-release.sh [output-dir]      Needs git. Writes <name>-<version>.tar.gz
set -euo pipefail
cd "$(dirname "$0")/.."
OUT=${1:-.}
VER=$(node -p "require('./app/package.json').version")
NAME=$(node -p "require('./app/package.json').name")
mkdir -p "$OUT"
# git archive uses tracked files only, so untracked secrets (config/, *.keystore, *.apk) can't leak in.
git archive --format=tar.gz --prefix="$NAME-$VER/" -o "$OUT/$NAME-$VER.tar.gz" HEAD \
  ':!reference' ':!android-app/*.apk' ':!android-app/*.keystore'
echo "wrote $OUT/$NAME-$VER.tar.gz"
tar tzf "$OUT/$NAME-$VER.tar.gz" | grep -Ei 'keystore|\.apk|notes/|config/(providers|users|settings)\.json' && { echo "refusing: private file in archive"; exit 1; } || true
