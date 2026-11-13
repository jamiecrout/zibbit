# Configuration

Almost everything is set in the browser (Settings > Admin settings, admins only). This page explains what
that writes, for backups, for scripting, and for the few things that stay outside the page.

Everything is read from `CONFIG_DIR` (set to `/config` by the Dockerfile). Examples are in
`config.example/`. None of the real files are ever committed.

## Roles

| | Regular user | Admin |
| --- | --- | --- |
| Watch, search, favorites, choose and reorder their own groups | yes | yes |
| Hide channels and put channels in their own order (per group, and for favorites) | yes | yes |
| Refresh a provider's channel list, stop their own streams | yes | yes |
| Change their own password (needs the current one) | yes | yes |
| See or reach Admin settings | no (the server refuses the requests) | yes |
| Providers, people, name cleanup, guide sources, security | no | yes |
| Change which guide a channel uses (applies to everyone) | no | yes |
| Set another person's password | no | yes |

Rules the server enforces: there is always at least one admin; you can't remove your own account or reset
your own password from the admin screen (use *Change password*); a temporary or default password must be
replaced at first sign-in before anything else works; changing a password signs that person out everywhere
else.

## Files

| File | Purpose |
| --- | --- |
| `providers.json` | Provider list. Written by the Providers screen. |
| `users.json` | People: name, role, scrypt hash, state file, `mustChange`. Written by the People section of Security and the commands below. |
| `settings.json` | Channel, guide, playback, lock and security settings. Written by the Channels & guide, Playback, Locks and Security screens and by guide addresses on a provider. Unknown keys are kept. |
| `secret.key` | Key that seals URLs sent to the browser and signs sessions. Created if missing. Keep it when restoring. |
| `epgmap.json` | Stream-to-guide-id overrides: `{ "<provider id>": { "<stream id>": "<guide id>" } }`. Written by the guide screen in Edit mode (admins tap a channel's name) and by `epgimport`. |
| `state-<person>.json` | That person's chosen groups (in their order), favorites, hidden channels, channel order per group, and last channel. |
| `cache/` | Catalog and guide caches. Rebuilt automatically. For M3U providers the cache holds stream addresses, so it is written with owner-only permissions. |

### providers.json

```
{ "providers": [
  { "id": "primary", "name": "Primary", "type": "xtream", "url": "http://host:8080", "username": "...", "password": "...", "format": "m3u8" },
  { "id": "playlist", "name": "My playlist", "type": "m3u", "url": "https://.../list.m3u", "format": "m3u8" },
  { "id": "antenna", "name": "Antenna", "type": "hdhr", "url": "http://192.168.1.50" }
] }
```

- `type` is `xtream` (default, so v1 files work unchanged), `m3u`, `hdhr` (an HDHomeRun tuner, see below) or `tablo` (a Tablo 4th Gen, experimental, see below).
- `format` is `m3u8` (HLS) or `ts`. For an M3U playlist, *Test connection* looks at the stream addresses and
  picks the right one.
- `id` is made from the name when you add a provider and never changes afterwards.
- An M3U channel gets a stable numeric id from its guide id, name and group, so favorites survive a refresh.
  If two entries have identical guide id, name and group they are numbered in file order.
- Groups for an M3U provider come from `group-title` (or `#EXTGRP`). Entries without one appear under
  *Uncategorized*.
- Guide addresses live in `settings.json` under `epg`, keyed by provider id, and are edited on the provider.
  Xtream providers use their own guide as a fallback; M3U providers have none unless an address is added.
- The admin screens never send a password back to the browser. When you edit a provider, leaving a secret
  blank keeps the saved one.

### settings.json

| Key | Meaning | Default |
| --- | --- | --- |
| `trimFromNames` | Text hidden in channel names (comma separated string, or a list). | none |
| `stripSuperscripts` | Remove superscript and subscript characters from channel names. | off |
| `epg` | `{ "<provider id>": ["guide address", ...] }` | none |
| `epgRefreshHours` | How often guides refresh. | 12 |
| `epgNameMatch` | Match guide data by cleaned-up channel name when there is no guide id. | on |
| `trustIpHeader` | Header your reverse proxy sets to the real visitor address. | none |
| `lockUserFails` | Wrong passwords per person and address before lockout. | 5 |
| `lockIpFails` | Wrong passwords from one address in total before lockout. | 20 |
| `lockMinutes` | Lockout length and counting window. | 10 |
| `adminAllow` | List of addresses or ranges (IPv4 or IPv6, CIDR) allowed to open Admin settings. Empty means no limit. | none |

All of these apply immediately after saving. `TRUST_IP_HEADER` in the environment overrides `trustIpHeader`
(and the page shows it as locked).

## Tablo 4th Gen (experimental)

**Experimental.** Sign-in, the channel list and playback have been confirmed on one real Tablo 4th Gen; the guide
and ending streams cleanly have only been tried against a pretend Tablo so far. It was written from community
descriptions of how the Tablo app talks to its cloud and device (the `tablo-api` library and TabloView's API
notes). Treat it as a preview. Tablo publishes no API, so Tablo can change or block this at any time. Only 4th Gen devices
are covered.

Add a provider of type *Tablo 4th Gen*, with your Tablo account email and password. The address is optional: leave
it blank to use the one your account reports, or enter the Tablo's address on your network (for example
`192.168.1.60`) if that doesn't work. Zibbit signs in to the Tablo cloud, lists the antenna channels in one group
called *Antenna*, then asks the device on your network to start each channel you watch. Streaming-app (OTT)
channels are left out.

- **Your Tablo password is stored in `providers.json`** on the server, like any other provider login, because
  Zibbit signs in again as needed. It is never sent to the browser.
- **The server must be able to reach the Tablo** on your network (port 8885, plus the port it streams on).
- **Video is converted while someone watches**, the same way as for an HDHomeRun, so ffmpeg is needed. People on
  the same channel share one stream.
- **Guide:** the program listings come from the Tablo's own guide, with no XMLTV address needed. They are read from
  the Tablo cloud's daily guide grid, or, if that has none of your channels, from the Tablo itself in slow batches
  (it refuses connections for about a minute after a burst). Any XMLTV addresses you add are read after it.
- Stopping a channel tells the Tablo the session is over, so its tuner is freed straight away.
- The two request-signing keys come from the Tablo app (as listed by `tablo-api`). If Tablo changes them, set
  `TABLO_HASH_KEY` and `TABLO_DEVICE_KEY`.
- The number of tuners isn't read from the device, so nothing stops you starting more streams than it has; the
  Tablo then answers "all tuners are busy". `STREAM_LIMIT` can cap it.

## HDHomeRun tuners

An HDHomeRun is added as a provider of type *HDHomeRun tuner (antenna)*; the address is all it needs (for example
`192.168.1.50`). Zibbit reads the device's channel list and puts every channel in one group called *Antenna*,
named with its number (`3.1 WLBT-DT`). Copy-protected cable channels are left out.

- **The server must be able to reach the tuner.** If Zibbit runs on a separate network segment from the tuner,
  allow that traffic (the tuner's web port, and port 5004 for video).
- **Video is converted while someone watches.** Antenna video is MPEG-2 with AC3 audio, which browsers and
  phones can't play, so ffmpeg turns each watched channel into H.264/AAC HLS (720p by default, see
  `TRANSCODE_MAX_HEIGHT`). People on the same channel share one conversion, and it stops as soon as the last
  person stops watching or closes the page. The image includes ffmpeg; running from source needs it installed.
  Expect roughly a third of one processor core per watched channel at 720p, and a few seconds before video
  starts.
- **Tuners are the limit.** The stream limit for a tuner is its tuner count, counted per channel (two people on
  one channel use one tuner). If something else is using the tuners, playback fails with "all tuners are busy".
- **Guide.** If you have SiliconDust's guide subscription, the listings are read from their service automatically (using
  the tuner's own key, so nothing to enter) and channels are matched by number. Zibbit then needs internet access to
  `api.hdhomerun.com`. Without the subscription the tuner has no program data; add an XMLTV guide address on the
  provider instead. Any address you add is read after the tuner's own guide.

## How the guide is matched

Guide sources are XMLTV files listed per provider. A channel uses the first source that has a programme on
right now. Matching goes in this order:

1. A saved override in `epgmap.json`.
2. The provider's own guide id for the channel (`epg_channel_id` or `tvg-id`).
3. The cleaned-up channel name, when `epgNameMatch` is on. When several guide channels share a name, the one
   listed first in the file wins, which can pick the wrong country. Use an override for those.
4. Local-station call signs (for example `WLBT`), preferring the plain `.us` id.

If nothing is on right now in the XMLTV data, an Xtream provider's own guide answers instead. Only channels
somebody has ticked or starred are kept, for a few hours back and a day ahead, so memory stays small.
The server logs one line per guide load (`guide <name>: n/m sources read, x of y channels matched`) and never
logs guide addresses. Per-channel misses are not logged; use the Edit-mode guide sheet to see one channel.

## Environment variables

| Variable | Default | Notes |
| --- | --- | --- |
| `PORT` | 8080 | |
| `CONFIG_DIR` | `./config` (`/config` in the image) | |
| `ADMIN_INITIAL_PASSWORD` | a random one, shown in the log | Only used when the very first account is created. Must still be changed at first sign-in. |
| `APP_PASSWORD` | | Used the same way as `ADMIN_INITIAL_PASSWORD` if that is not set. |
| `CATALOG_TTL_HOURS` | 6 | How long a provider's channel list is reused. |
| `TRUST_IP_HEADER` | | Overrides `trustIpHeader`. |
| `PUID`, `PGID` | owner of the config folder, or 1000 if that is root | The user and group the server runs as. It never runs as root unless you set `PUID=0`. On first start the config folder is handed to this user once, so files saved by earlier versions (as root) stay readable. On Unraid use `99` and `100`. |
| `ALLOW_PRIVATE_UPSTREAM` | | Set to `1` (or `"allowPrivateUpstream": true` in `settings.json`) only if a provider really serves video from an address inside your own network and is not listed as a provider host. By default the server refuses stream, playlist and picture requests, and redirects, that land on a private, loopback or link-local address; the log says `refused a request to <host>` when that happens. |
| `EPG_REFRESH_HOURS`, `TRIM_FROM_NAMES`, `STRIP_SUPERSCRIPTS` | | Used only when the matching key is absent from `settings.json`. |
| `STREAM_LIMIT` | 0 | A number caps simultaneous streams per provider; `auto` uses the Xtream account's own limit (Xtream only). |
| `LIMIT_CACHE_MS` | 60000 | |
| `TRANSCODE_MAX_HEIGHT` | 720 | HDHomeRun channels are converted to at most this many lines of video (0 keeps the original size, which needs more processor time). |
| `TRANSCODE_DIR`, `REWIND_DIR` | `/rewind` when that folder exists, else the system temp folder | Where the converted video and the rewind buffer are written (inside a `zibbit-hls` folder, which is emptied at every start). Nothing there is kept. Map a real folder to `/rewind` so a long buffer doesn't fill the container's own disk. |
| `FFMPEG_PATH` | `ffmpeg` | Only needed if ffmpeg is not on the path (the image includes it). |

## Command line

Run against the running container. These cover what the browser can't, mainly recovery.

```
docker exec -it zibbit node server.js users
docker exec -it zibbit node server.js adduser <name> [admin]
docker exec -it zibbit node server.js passwd <name>
docker exec -it zibbit node server.js deluser <name>
docker exec -it zibbit node server.js promote <name>
docker exec -it zibbit node server.js demote <name>
docker exec -it zibbit node server.js clear-ip-rules
docker exec -it zibbit node server.js epgimport <provider id> <playlist file>
```

- `passwd` sets a password without forcing a change (you are at the console).
- `clear-ip-rules` removes the `adminAllow` list if you ever lock yourself out of the Admin page.
- `epgimport` copies a playlist's stream-to-guide-id pairs into `epgmap.json`. A provider playlist contains
  the provider login in its URLs, so never commit one.

## Security notes

- **Admin address rule.** It applies only to Admin settings requests, not to sign-in or playback, so a
  phone or car on a changing mobile address can still watch. Loopback and private home-network addresses are
  always allowed. The page refuses a rule that would block the address you are using, and warns when the
  rules cover only IPv4 or only IPv6. It can't know about your *other* devices, which is why
  `clear-ip-rules` exists.
- **The address the app sees.** Lockouts and the address rule use the visitor address the app is given. Behind
  a reverse proxy, name a header the proxy sets itself and overwrites on every request (for example `cf-connecting-ip` behind Cloudflare). Don't expose the container's port directly if you rely on
  these, because a direct client could send its own header.
- **First password.** The first account's password is random and appears only in the container log; changing it at
  first sign-in is enforced. Still, sign in once before exposing the app to the internet.
- **Sessions.** A sign-in lasts 180 days on that device. **Settings > Sign out everywhere** ends every other sign-in for
  that person, paired screens included, and keeps the one you are using. Changing a password does the same.
- **Secrets at rest.** `providers.json`, `users.json`, `settings.json` and the key files are written with
  owner-only permissions. Account passwords and content-lock PINs are stored only as hashes. Provider logins (usernames,
  passwords, and playlist addresses that carry a token) and guide addresses are stored encrypted, so a copy of
  `providers.json` or `settings.json` on its own shows nothing usable; see [Recovery key and backups](#recovery-key-and-backups).
  The server still needs the key to read them, so anyone who can read both the key and the files can open them.


## Recovery key and backups

Provider logins and guide addresses are encrypted in `providers.json` and `settings.json` (AES-256-GCM, shown as `enc:v1:…`).
One **recovery key** opens them, and the same key opens a backup. Admins can read it under **Admin settings > Security >
Recovery key and backup** (after typing their password again). Copy it somewhere safe, such as a password manager.

- **Where the key lives.** By default Zibbit makes a key on first start and keeps it in `recovery.key` in the config folder.
  That protects against a stray copy of `providers.json` or `settings.json`, but not against a copy of the whole folder.
  To keep the key off the server's disk, set the **`ZIBBIT_KEY`** environment variable to the key (Unraid: add a Variable
  to the container; Compose: an `environment:` entry) and restart. Zibbit then removes `recovery.key`. Any text of at least
  16 characters works, and capitals, spaces and dashes don't matter. Keep the value: if it is lost and `recovery.key` is
  gone, saved logins can't be read, and you re-enter them or restore a backup.
- **Changing the key.** Set `ZIBBIT_KEY` to a new value while `recovery.key` still exists and everything is re-encrypted
  with the new key at the next start. If the old key is already gone, the old logins can't be opened with a new one.
- **Existing installs.** The first start of this version encrypts logins that were stored in plain text. A value typed into
  the file by hand is still read, and is encrypted at the next start. If the key doesn't match, those providers are not
  loaded and the log says why; the file is left as it is, so setting the right key brings them back.
- **Backups.** Security > Recovery key and backup can save one encrypted file with the providers (logins included),
  people, settings, guide links and everyone's groups and favorites. **Save to storage** puts it in `zibbit-backups` inside the
  folder mapped to `/recordings` (name that path whatever you like in your container template, for example "Storage"),
  **Download** gives you the file, and **Save a backup to storage every day** keeps the newest 14 by default (set it
  from 1 to 60). Backups you save by hand are never removed. The file can only be opened with the key, which isn't in it.
- **Restoring.** Choose a saved backup, or a downloaded file, and enter the recovery key of the server that made it and
  your password. Restoring replaces providers, people, settings, guide links, groups and favorites, after saving what was
  there as `zibbit-before-restore-…` (the last three are kept). A backup with no admin account is refused so nobody is
  locked out, and a limit on which addresses may open Admin settings is left out if it would exclude yours. Logins are
  encrypted again with the key of the server you restore onto. Recordings and downloads are not part of a backup; they
  already live in the storage folder.

## Rewinding live TV

Live channels can be wound back. While anyone watches a channel, the server keeps a rolling buffer of it (one copy per
channel, shared by everyone watching it, so the provider is still asked once) and the player gets a seek bar, with
**Go live** to jump back to the edge. Nothing is kept for a channel nobody is watching: the buffer is deleted a couple of
minutes after the last person leaves, and you can only rewind as far as the channel has been watched.

- **Admin settings > Playback > Rewind live TV, at most:** off, 15 minutes, 30 minutes or 1 hour (the default).
  Off sends channels straight from the provider as before.
- **Each person chooses their own length** (Settings > Rewind live TV), never more than the admin allows. A shorter
  choice really does free space: video older than the longest length anyone on that channel asked for is deleted.
- **Disk budget** (same page, default 10 GB): all running buffers together stay under it, oldest video first, and the
  server never lets the disk itself drop below about 1.5 GB free. Roughly: 1080p is 2 to 4 GB an hour, 4K 10 GB or more.
- **Where it lives:** map a folder to `/rewind` (Docker) or set `REWIND_DIR`. Without one it uses the system temp folder,
  which in a container is the container's own disk. Docker Compose: `- ./rewind:/rewind`. Unraid: Path, container
  `/rewind`, host `/mnt/user/appdata/zibbit/rewind` (or a cache or scratch share).
- **Cost:** channels that were passed straight through now go through ffmpeg (video and audio are copied, not
  re-encoded, so it is light), and a channel takes a few seconds longer to start. If a channel can't be buffered it plays
  directly, as before, and the server notes it in the log.
- Needs ffmpeg (included in the image).

## Recording live TV

With rewind on, a channel can be recorded from its buffer, so a recording can start in the past: **Record this show**
(from where the program began, as far back as the buffer reaches, until it ends plus three minutes), **Record from now**
(until you stop it), or everything buffered. Recordings are MP4 files, kept in `/recordings/<profile>/recordings/` with a
folder per profile. They are listed under **Recordings** and play like a movie, remembering where you stopped; Delete
removes the file.

- **Where it lives:** map a folder to `/recordings` (Docker) or set `RECORDINGS_DIR`. Recording is off until the folder exists
  and is writable. Docker Compose: `- ./recordings:/recordings`. Unraid: Path, container `/recordings`, host a share.
- **Admin settings > Playback > Longest recording** (6 hours by default, up to 24): a recording stops by itself after this.
- **Stop recording when free space drops below** (20 GB by default): running recordings stop, and new ones won't start.
- Recordings are never deleted automatically. A channel being recorded keeps its buffer running even with nobody watching,
  which keeps using one provider stream.

## Downloading movies and shows

A movie, episode or whole season can be copied from the provider into the profile's own folder:
`/recordings/<profile>/downloads/` (same `/recordings` folder as recordings). The file is kept exactly as the provider sends
it, with no conversion, so it plays wherever streaming it already played. Names look like `Movie (2019).mkv` and
`Show - S01E02 - Title.mkv`.

- Only one download runs per provider at a time, so a download never uses more than one of the provider's streams. The rest
  wait their turn. A download that breaks off resumes from where it stopped; a restart picks the unfinished ones back up.
- Downloads stop when free space drops below the same floor as recordings (Admin settings > Playback).
- Downloads are never deleted automatically. Delete removes the file, and cancelling removes what had come down.
