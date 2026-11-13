#!/usr/bin/env bash
# Builds Zibbit.apk. Needs SDK (platform 34, build-tools 34.0.0) and r8.jar (8.7.18).
set -euo pipefail
SDK=${SDK:?set SDK to the Android SDK root}
R8=${R8:?set R8 to r8.jar}
VC=${VC:-15}; VN=${VN:-3.0}; OUT=${OUT:-Zibbit.apk}   # version code/name and the output file name
BT=$SDK/build-tools/34.0.0
JAR=$SDK/platforms/android-34/android.jar
cd "$(dirname "$0")"
# The keystore password is never in this script: set KEYSTORE_PASS, or put it on the first line of keystore.pass
# next to this script (git ignores that file). It is passed to the tools through the environment, not the command line.
if [ -z "${KEYSTORE_PASS:-}" ] && [ -f keystore.pass ]; then KEYSTORE_PASS=$(head -n1 keystore.pass); fi
[ -n "${KEYSTORE_PASS:-}" ] || { echo "Set KEYSTORE_PASS, or put the keystore password in android-app/keystore.pass" >&2; exit 1; }
export KEYSTORE_PASS
rm -rf build "$OUT" && mkdir -p build/classes
python3 make_icons.py   # draws the launcher icons into res/mipmap-*/ (needs Pillow)
"$BT/aapt2" compile --dir res -o build/res.zip
# the manifest carries the version too; fill in VC / VN so a test build can be numbered without editing it
sed -e "s/android:versionCode=\"[0-9]*\"/android:versionCode=\"$VC\"/" -e "s/android:versionName=\"[^\"]*\"/android:versionName=\"$VN\"/" AndroidManifest.xml > build/AndroidManifest.xml
"$BT/aapt2" link -o build/base.apk -I "$JAR" --manifest build/AndroidManifest.xml \
  --min-sdk-version 24 --target-sdk-version 33 --version-code "$VC" --version-name "$VN" build/res.zip
javac --release 8 -Xlint:-options -cp "$JAR" -d build/classes src/app/zibbit/MainActivity.java
java -cp "$R8" com.android.tools.r8.D8 --release --min-api 24 --lib "$JAR" --output build \
  $(find build/classes -name '*.class')
cp build/base.apk build/unsigned.apk
python3 -I -c "
import zipfile
z = zipfile.ZipFile('build/unsigned.apk', 'a', zipfile.ZIP_DEFLATED)
z.write('build/classes.dex', 'classes.dex'); z.close()"
"$BT/zipalign" -f -p 4 build/unsigned.apk build/aligned.apk
[ -f release.keystore ] || keytool -genkeypair -keystore release.keystore \
  -storepass:env KEYSTORE_PASS -keypass:env KEYSTORE_PASS -alias iptvdock \
  -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Zibbit"
"$BT/apksigner" sign --ks release.keystore --ks-pass env:KEYSTORE_PASS \
  --key-pass env:KEYSTORE_PASS --out "$OUT" build/aligned.apk
