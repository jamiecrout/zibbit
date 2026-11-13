# Android app (for zibbit)

A tiny Android app that opens your self-hosted zibbit page full screen. It exists because a car head
unit (here an Aucar, Android 13) can't save a Chrome page as an app. It is one activity holding a WebView;
there is no other app logic and no third-party library.

- Launcher label: **Zibbit**. Package: `app.zibbit` (change both before any public release; see
  below). Version 2.1 (versionCode 4). minSdk 24, targetSdk 33.

## What it does

- Opens the server you used last and **blocks navigation to any other site**.
- Keeps the screen on while open.
- HTML5 full-screen video works (system bars hidden), and Back leaves full screen first.
- Back steps back through the page history; from the first page it exits.
- The sign-in cookie is flushed to disk when the app pauses. The WebView is not paused in the
  background, so audio keeps playing if you switch apps.
- If the page cannot be reached it shows a "Try again" page instead of a blank screen.
- If the WebView renderer is killed, the activity recreates itself.

## The address

The app has no address built in. The first time it runs it shows a server screen: type the address
(`tv.example.com`; `https://` is added for you) and tap **Connect**. After that it opens the server you used
last, straight away, on every launch. Plain `http://` is accepted only for home-network addresses (10.x,
172.16-31.x, 192.168.x, `.local`, `.lan`, `.home`, a bare hostname); anything else must be https. Once
connected the app stays on that one site.

To switch servers, open the page's **Settings** (the gear) and tap **Change server**. That shows the saved
servers, with **Connect**, **Remove from list** and **Exit**; Back returns to the server you were on. The
"Can't reach" screen (also shown when the page answers with a 5xx error) has a **Change address** button that
does the same thing, and so is the way back if a server is down. The app adds `ZibbitApp/2.1` to the browser
identification so the page can tell it is running inside the app; a server older than this release has no
**Change server** button, only the "Can't reach" route.

Version 2.1 is signed with the same key as 1.x and 2.0, so it installs over them.

## Build

Needs: JDK 21 (compiles with `--release 8`), Python 3 with Pillow, Android SDK platform 34 and
build-tools 34.0.0, and the standalone R8/D8 jar **8.7.18**
(`https://maven.google.com/com/android/tools/r8/8.7.18/r8-8.7.18.jar`).

The D8 bundled in build-tools 34.0.0 (8.2.2) crashed on this app's anonymous inner classes
(NullPointerException), which is why `build.sh` uses the newer standalone jar.

```
SDK=/path/to/android-sdk R8=/path/to/r8-8.7.18.jar bash build.sh
```

This writes `Zibbit.apk`. `build.sh` draws the icons (`make_icons.py`), compiles, dexes, aligns
and signs.

## Signing key

On first run `build.sh` creates `release.keystore` next to the script. **Keep it out of git**
(`.gitignore` already does) and keep a backup. A build signed with a different key will not
install over an existing install; uninstall the old app first. The keystore password in
`build.sh` is a placeholder for a local, personal key; change it if you care.

## Install

Copy the APK to the device and allow installs from unknown sources.

## Icon

`make_icons.py` draws a teal TV with antenna and play button on dark navy: an adaptive icon
(foreground plus `#0F1D2C` background) and legacy PNGs for older launchers. A preview is in
`docs/icon_preview.png`.

## Before a public release

The package name and the signing key are permanent. Installing an app with a different package name makes a
separate app; installing one signed with a different key requires uninstalling the old one first. So, before
anything is published: pick the final product name, change the package (`app.zibbit` in
`AndroidManifest.xml`, `build.sh`, the source folder and `MainActivity.java`), the launcher label, and decide
who holds the signing key. Google Play also expects an app-bundle build and its own signing arrangement, which
this script does not produce.
