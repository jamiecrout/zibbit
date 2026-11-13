# Zibbit for Android

The Android app for [Zibbit](../README.md). It opens your own Zibbit server full screen, remembers the servers
you use, and on a TV it switches to a big-screen layout you control with the remote. It is one activity holding a
WebView, with no third-party libraries. The same app runs on phones, tablets, car head units and Android TV / Fire TV.

Ready-built APKs, with checksums and install steps, are in
[github.com/jamiecrout/zibbit-android](https://github.com/jamiecrout/zibbit-android). This folder is the source.

- Launcher label **Zibbit** (**Zibbit TV** on an Android TV or Fire TV home screen). Package `app.zibbit`.
- Version 3.0 (versionCode 15). minSdk 24 (Android 7.0), targetSdk 33.

## What it does

- Opens the server you used last and **blocks navigation to any other site**.
- Keeps the screen on while open.
- HTML5 full-screen video works (system bars hidden), and Back leaves full screen first.
- Back steps back through the page history; from the first page it exits.
- The sign-in cookie is flushed to disk when the app pauses. The WebView is not paused in the background, so
  audio keeps playing if you switch apps.
- If the page cannot be reached it shows a "Try again" page instead of a blank screen.
- If the WebView renderer is killed, the activity recreates itself.

## Big-screen mode

On a TV the app opens the server's big-screen page (`/tv`) and handles the remote:

- Large type and d-pad navigation. The media keys (play, pause, stop, channel up and down) and the Menu key work,
  and a long press opens a menu.
- Signing in does not need typing: the screen shows a short code to approve on your phone, with a password
  option as a fallback.
- On a TV the app adds `ZibbitTV` to the browser identification, so the page knows which layout to use.

## The address

The app has no address built in. The first time it runs it shows a server screen: type the address
(`zibbit.example.com`; `https://` is added for you) and tap **Connect**. After that it opens the server you used
last, straight away, on every launch. Plain `http://` is accepted only for home-network addresses (10.x,
172.16-31.x, 192.168.x, `.local`, `.lan`, `.home`, a bare hostname); anything else must be https. Once
connected the app stays on that one site.

To switch servers, open the page's **Settings** and tap **Change server**. That shows the saved servers, with
**Connect**, **Remove from list** and **Exit**; Back returns to the server you were on. The "Can't reach" screen
(also shown when the page answers with a 5xx error) has a **Change address** button that does the same thing, so
it is the way back if a server is down. The app adds `ZibbitApp/3.0` to the browser identification so the page
can tell it is running inside the app.

## Updating the app

**Settings > Check for app update** asks your server whether a newer app is published. If one is, the app downloads
it from the server, verifies its SHA-256, and hands it to Android's installer, which asks you to confirm. Android
asks once for permission to let Zibbit install its own update. The update must carry the same package name and
signing key as the installed app, and a higher versionCode. How a release is published is in
[`docs/RELEASING.md`](../docs/RELEASING.md).

Version 3.0 is signed with the same key as 1.x, 2.0 and 2.1, so it installs over them.

## Build

Needs: JDK 21 (compiles with `--release 8`), Python 3 with Pillow, Android SDK platform 34 and
build-tools 34.0.0, and the standalone R8/D8 jar **8.7.18**
(`https://maven.google.com/com/android/tools/r8/8.7.18/r8-8.7.18.jar`).

The D8 bundled in build-tools 34.0.0 (8.2.2) crashed on this app's anonymous inner classes
(NullPointerException), which is why `build.sh` uses the newer standalone jar.

```
SDK=/path/to/android-sdk R8=/path/to/r8-8.7.18.jar KEYSTORE_PASS=... bash build.sh
```

This writes `Zibbit.apk`. `build.sh` draws the icons (`make_icons.py`), compiles, dexes, aligns and signs. Set
`VC` and `VN` to number a test build (`VC=16 VN=3.1 bash build.sh`) and `OUT` to change the file name.

`publish.sh <apk> <folder>` copies a built APK into a folder together with `latest.json` (version, size, SHA-256)
and `SHA256SUMS`, ready to put in the update location.

## Signing key

On first run `build.sh` creates `release.keystore` next to the script, protected by the password you give it in
`KEYSTORE_PASS` (or on the first line of `keystore.pass` next to the script). The password is never stored in the
script. **Keep both files out of git** (`.gitignore` already does) and keep a backup.

If you build your own copy, you sign with your own key. A build signed with a different key from the one already
installed will not install over it (uninstall the old app first), and the in-app update only accepts an APK signed
with the same key. The published `Zibbit.apk` is signed with the maintainer's key; its certificate SHA-256 is in the
[zibbit-android](https://github.com/jamiecrout/zibbit-android) README.

## Icon

`make_icons.py` draws a teal TV with antenna and play button on dark navy: an adaptive icon (foreground plus
`#0F1D2C` background) and legacy PNGs for older launchers. A TV banner for the Android TV home screen is in `res/`.
