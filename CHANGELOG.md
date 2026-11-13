# Changelog

Versions follow [Semantic Versioning](https://semver.org/) and are described in `docs/RELEASING.md`. The server's
version is the one in `app/package.json`; the Android app has its own, listed under each release it belongs to.
New changes go under **Unreleased** until a release is tagged.

## [3.0.1] - 2026-11-13

Fixed
- In-app app updates read from the normal update location. 3.0.0 looked in the folder used for test builds, so the
  app's Check for app update found nothing.
- The message under a channel that won't play said "switch to" the first provider in the list, whichever one that was. It now says
  "Try again, or switch providers."

## [3.0.0] - 2026-11-13

Zibbit started as a live-TV player. Now it also rewinds and records channels, plays your provider's movies and shows, and runs on your phone, tablet and big screen.

Added
- **Rewind live TV.** Wind back up to an hour (an admin can lower it) and press Go live to return. One buffer is shared by
  everyone on the channel and kept only while it is watched.
- **Record live TV.** Record a show from the rewind buffer, or from now until you stop. Recordings are MP4 files in your
  `/recordings` folder, with resume points.
- **Movies & Shows.** Browse a provider's movies and series, search, choose the categories you want, and Continue watching.
- **Downloads.** Copy a movie, episode or season from the provider to your own folder.
- **Content lock.** A per-person PIN hides and blocks groups that match a word list (adult terms by default) or that an
  admin marks. Admin settings > Locks.
- **Encrypted logins and server backups.** Provider logins and guide addresses are stored encrypted. Admins can read the
  recovery key under Security, and the same screen saves, downloads and restores an encrypted backup of the whole setup.
  Set `ZIBBIT_KEY` to keep the key off the disk.
- **Sign out everywhere**, from Settings, for when a device is lost.
- **All channels** at the top of the group menu: every ticked group in one list.
- **E-AC-3 audio** on live channels is converted to AAC for browsers that can't play it (admin switch under Playback).
- **Refresh channel list** in Settings.
- **Install as an app** from the browser: Add to Home Screen on iPhone and iPad, Install app in Chrome.

Changed
- Admin settings are regrouped: Providers, Channels & guide, Playback, Locks and Security, with people under Security.
- Manage groups moved into Settings.
- The status line shows stream speed, and "Up next" is gone.
- The player says why a channel won't start, on screen and in the log.
- The provider's own guide is a fallback only when an admin turns that on.
- The container runs as an ordinary user (`PUID` and `PGID`), not root.

Security
- The first account gets a random password, shown once in the log.
- Security headers and a content policy on every page.
- Requests to private addresses, including by redirect, are refused unless they are your provider's.
- Wrong guesses against one account are capped across all addresses.
- Saved files are owner-only.
- A stray error is logged instead of stopping the server.

Fixed
- Channel lists were cut off at 4,000; they now hold 25,000.
- The Uncategorized group lists its channels.
- Some live channels stalled with "media sequence mismatch".
- Numerous other security enhancements and bug fixes since 2.x.

Android app 3.0 (versionCode 15)
- **Big-screen mode:** large type, d-pad navigation, and a menu on long-press. Rewind, record and download from the couch
  with just a remote.
- Sign in on a big screen with a code from your phone.
- The app can update itself.

Upgrading from 2.x
- Back up the config folder first. Once 3.0 has started, saved logins are encrypted and 2.x can't read them.
- The config folder is handed once to the user the container now runs as. On Unraid use `PUID` 99 and `PGID` 100.
- If a provider serves from inside your network and stops loading, set `ALLOW_PRIVATE_UPSTREAM=1`.

## [2.1.0] - 2026-11-10

Added
- **HDHomeRun** antenna tuners as a source. Video is converted for the browser with ffmpeg only while someone
  watches, and the tuner count limits simultaneous streams. With SiliconDust's guide subscription the tuner's
  listings fill the guide automatically, with no XMLTV address needed.
- **Tablo 4th Gen** as a source (experimental; confirmed on one real device). Sign in with the Tablo account,
  channels and the Tablo's own guide with no XMLTV address needed, and stopping a channel frees its tuner.
- The server version is logged at start-up and shown right under the Settings heading.
- Settings has **Change server** when the page is open inside the Android app.

Changed
- The player says why the browser refused to start playback, instead of staying on "Ready" with no explanation.
- Image tags: `latest` now follows tagged releases only. `X.Y.Z` and `X.Y` are published with each release, and
  `edge` follows `main`. See `docs/SETUP.md`.

Android app 2.1 (versionCode 5)
- Opens the server you used last on every launch. The server list appears on the first run and from Settings >
  Change server (or the "Can't reach" screen's Change address). Works with any 2.x server; the Change server
  button needs server 2.1.0 or newer. On that screen, Back returns to the page you were on (Exit appears only on
  the first launch, before any server is set).

## [2.0.0]

Renamed from iptv-dock to **Zibbit**. Container, image and log prefix are `zibbit`; the Android app is
`app.zibbit` (a new app ID, so install it fresh; the signing key is unchanged).

Server and page
- Roles (admin and regular user), forced password change at first sign-in, no default open access.
- Any number of providers, Xtream, M3U, HDHomeRun antenna tuners or (experimental, untested on hardware) Tablo 4th Gen
  (converted for the browser with ffmpeg while watched), all managed from Admin settings in the browser.
- XMLTV guide sources per provider, name-based matching, and a guide grid (about three hours visible,
  sideways scroll, "now" line, readable titles).
- Per-person channel groups (reorderable), favorites (reorderable), hidden channels and channel order.
- Admin tool to make a channel use another channel's guide (saved in `epgmap.json`).
- Channel-name cleanup list is comma separated.
- Sign-in lockout, optional Admin address allowlist, CSRF protection, sealed stream addresses.
- Reads a v1 config unchanged (see `docs/UPGRADING.md`).

Android app 2.0 (versionCode 3)
- No address built in. Every launch shows a startup screen with a list of saved servers (last used
  preselected) and Connect, Remove and Exit buttons. Home-network addresses may use plain http.
- The "Can't reach" screen (also shown for 5xx errors) has a Change address button.
- Signed with the same key as 1.x, so it installs over the old app.

## 1.x

Single-provider Xtream player with a shared password, a channel list and a text-only program list.
Tagged `v1` in git.
