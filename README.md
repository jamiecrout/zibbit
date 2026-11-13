# zibbit

A touch-first, portrait-friendly IPTV player with an on-demand streaming proxy. One small Node
container, no npm dependencies. Built for a car head unit (Android 13), phones and tablets.

## What it does

- **Any number of providers**, each an **Xtream** login, an **M3U playlist** an **HDHomeRun** antenna tuner or (experimental) a **Tablo** 4th Gen
  (with optional XMLTV guide sources). Provider credentials stay on the server, and every URL handed to the browser is sealed (AES-GCM).
- **A real guide grid.** About three hours visible, scrolls sideways through a day, with a "now" line.
  Channel rows stay the same height. Guide data comes from your provider, from XMLTV sources, or both.
- **Each person's own view.** Pick and reorder channel groups, star favorites (and reorder them), hide
  channels you never watch, and put channels in your own order inside a group. Nobody else sees your changes.
- **Movie and show categories you choose.** Tick the categories you want from each provider's movies and shows; the rest
  stay out of the lists, search and Recently added.
- **A content lock (optional).** Made for adult content, but it works for any group you want out of sight. An admin turns it on and gives each person a four-digit PIN. Groups whose names
  match a list of words, or that an admin marks, show with a lock and their channels and titles stay hidden everywhere (guide,
  search, favorites, history) until the PIN is entered. The server refuses to play them while locked. It locks again after
  a period of no activity, after 12 hours at most, and when someone switches profile or signs out.
- **Streams are proxied only while someone is watching.** Closing the page or pressing Stop drops the
  upstream connection immediately. Provider connection limits are respected.
- **Two kinds of people.** Regular users manage their own view and password. Admins also get **Admin
  settings** for providers, people, channel-name cleanup, guide sources and security.
- **Guide fixes without editing files.** When a channel has no guide data, an admin can tell it to use
  another channel's listings, from the page.
- **Touch-first.** Built for a portrait car screen, and just as at home on a phone, tablet or desktop browser.
  An optional Android app keeps a list of servers and opens the one you choose.
- Everything is managed in the browser. Sign-in lockout (per /64 for IPv6), a limit on who can open Admin
  settings, forced password change at first sign-in, CSRF protection.

## Quick start

```
docker run -d --name zibbit --restart unless-stopped \
  -p 8080:8080 -v "$PWD/config:/config" \
  ghcr.io/jamiecrout/zibbit:latest
```

The image is public (`amd64` and `arm64`), so no login is needed to pull it. Open `http://<host>:8080`, sign
in as **admin** with the temporary password the container prints in its log on first start (`docker logs zibbit`,
or the log button in the Unraid Docker tab). You are asked to choose a new password straight away. Then open
Settings > Admin settings > Providers > Add provider.

To choose the first password yourself instead, set `ADMIN_INITIAL_PASSWORD` (`-e ADMIN_INITIAL_PASSWORD=...`) before
the first start. It is still replaced at first sign-in.

The app serves plain HTTP; put a TLS reverse proxy in front of it for use away from home. `docs/SETUP.md`
covers Docker Compose, Unraid, updating and the reverse proxy.

## Layout

| Path | What it is |
| --- | --- |
| `app/` | The application: `server.js`, `package.json`, `public/` (page, admin screens, sign-in page, vendored hls.js and mpegts.js), `test/`. |
| `Dockerfile`, `docker-compose.yml`, `.dockerignore` | Packaging. The compose file runs the published image; `docker build -t zibbit .` builds your own. |
| `config.example/` | Example `providers.json` and `settings.json`. Real files hold secrets and are never committed. |
| `docs/USING.md` | A tour of the screens for the people who watch. |
| `docs/SETUP.md` | Install from nothing, first sign-in, reverse proxy. |
| `docs/CONFIGURATION.md` | Roles, files, settings, environment variables, admin commands, security notes. |
| `docs/UPGRADING.md` | Moving from 2.x or from v1. |
| `docs/RELEASING.md` | What the version numbers and image tags mean, and how a release is made. |
| `android-app/` | The Android app: a server list and a full-screen WebView (see its README). |
| `CHANGELOG.md`, `THIRD-PARTY-NOTICES.md` | What changed, and licenses for the two bundled libraries. |
| `tools/make-release.sh` | Builds a clean source archive (no keys, config or build output). |

## Tests

```
cd app && npm test
```

Starts the server against a temporary config and a pretend provider (Xtream, M3U and streams) and checks
roles, password rules, provider management, playback through the proxy and the upgrade path from v1.
Node 18 or newer; nothing to install.

## Notes

- Third-party libraries are vendored, unmodified, in `app/public/` (hls.js 1.7.3, mpegts.js 1.8.2; see
  `package.json`). Their licenses and notices are in `THIRD-PARTY-NOTICES.md`.
- This project carries no content and no provider, playlist or guide source. You bring your own subscription.
- License: MIT, see `LICENSE`.
