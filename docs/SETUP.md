# Setup (blank slate)

Zibbit runs as one small container. The image is public, so you can pull it without an account:

```
ghcr.io/jamiecrout/zibbit:latest
```

It is built for both `amd64` (most PCs and servers) and `arm64` (Raspberry Pi 4/5, Apple silicon). All state
lives in one config directory mounted at `/config`, so the container can be replaced or upgraded at any time
without losing settings, sign-ins or favorites.

## 1. Run it

Pick one.

**Docker**

```
docker run -d --name zibbit --restart unless-stopped \
  -p 8080:8080 \
  -v /path/to/zibbit-config:/config \
  ghcr.io/jamiecrout/zibbit:latest
```

Use any folder you like in place of `/path/to/zibbit-config`. It is created if it does not exist.

**Docker Compose** (save as `docker-compose.yml`, then `docker compose up -d`)

```
services:
  zibbit:
    image: ghcr.io/jamiecrout/zibbit:latest
    container_name: zibbit
    restart: unless-stopped
    ports:
      - "8080:8080"
    environment:
      CONFIG_DIR: /config
      # ADMIN_INITIAL_PASSWORD: ""   # optional first password for "admin"
    volumes:
      - ./config:/config
```

**Unraid** (Docker tab > Add Container)

| Field | Value |
| --- | --- |
| Name | `zibbit` |
| Repository | `ghcr.io/jamiecrout/zibbit:latest` |
| Network type | Bridge (or a custom network with its own address, if you prefer) |
| Port | Container `8080` to a free host port, for example `8080` |
| Path | Container `/config` to Host `/mnt/user/appdata/zibbit/config` |
| Path (optional) | Container `/rewind` to a host folder, for the live-TV rewind buffer (see Configuration). Without it the buffer uses the container's own disk |
| Path (optional) | Container `/recordings` to a host folder, for recorded live TV (see Configuration). Recording is off without it |
| Variable | `PUID` = `99` and `PGID` = `100` (Unraid's `nobody:users`), so the files it saves belong to the same user as your other appdata |

Apply, then open the container's WebUI. If you give the container its own address on a custom network, set a
fixed MAC address so a router or firewall rule written for it keeps matching.

**From source** (to change the code yourself, or without Docker)

The code is in `app/` and needs only Node 18 or newer (the image uses Node 22). It has no npm dependencies.

```
docker build -t zibbit .
```

or run it directly: `cd app && CONFIG_DIR=../config node server.js`.

The source repository is private for now. Ask for access if you want it.

## 2. First sign-in

Open `http://<host>:8080`. On a blank config the app creates one account: name **admin**, with a random
temporary password that is printed once in the container log (`docker logs zibbit`, or the log button in the Unraid
Docker tab). If you set `ADMIN_INITIAL_PASSWORD`, that is the password instead. Until it is changed, nothing
else works: the page asks for a new one first. Sign in and change it before exposing the app to the internet.

Then, as admin:

1. **Settings > Admin settings > Providers > Add provider.** Choose *Xtream login* or *M3U playlist*.
   *Test connection* checks the login or reads the playlist. Add as many as you like.
2. **Security > People > Add person** for everyone who should have their own groups and favorites. They are asked to
   choose their own password at first sign-in.
3. Everyone picks their channel groups under **Manage** on the main screen.

Optional: **Channels & guide** (hide text such as `US:` in channel names, remove superscript letters, guide matching), **Playback** (rewind, recording, audio conversion), **Locks** (the content lock) and **Security**
(people, lockout limits, trusted address header, who may open Admin settings).

Zibbit carries no channels. You add your own sources, and you are responsible for having the right to use
them.

## 3. Reach it from other devices

On your home network, `http://<server-address>:8080` works from phones, tablets and browsers as it is. The
Android app accepts plain `http` only for home-network addresses.

To use it away from home you need `https`. The app serves plain HTTP on port 8080, so put a TLS reverse proxy
in front of it (Nginx Proxy Manager, Caddy, nginx, a Cloudflare tunnel). Streams are proxied, so disable
response buffering and use long read timeouts on the proxy (the app sends `X-Accel-Buffering: no`).
`docs/CONFIGURATION.md` explains how the real client address reaches the app, which matters for the
sign-in lockout and the Admin address rule.

Do not forward port 8080 straight to the internet.

## 4. Optional extras

- **Android app:** download `Zibbit.apk` from the public
  [zibbit-android](https://github.com/jamiecrout/zibbit-android) repository. It remembers the servers you have used
  and opens the last one on every launch; switch with **Settings > Change server**. The same page also works in any browser and can be added to a phone's home screen.
- **iPhone and iPad:** there is no app to install. Open the address in Safari, tap Share, then **Add to Home Screen**.
  It opens full screen with the Zibbit icon. Sign in once inside it; it keeps its own sign-in, separate from Safari's.
- **VPN for provider traffic:** do it at your router or firewall, against the container's address. The app
  has no VPN logic of its own. If your provider only works from certain countries, this is the place to solve it.

## Updating

```
docker pull ghcr.io/jamiecrout/zibbit:latest
```

`latest` is the newest release. To stay on one line of releases, use a version tag instead: `:2.1` takes fixes
but not new features, and `:2.1.0` never changes. `:edge` follows work that is not released yet. The tags and how
a release is made are in `docs/RELEASING.md`, and the version you are running is shown at the bottom of
Settings.

Then recreate the container (`docker compose up -d`, or the update button in the Unraid Docker tab). Your
`/config` folder carries over. Moving from 2.x or from the earlier single-file version is covered in `docs/UPGRADING.md`.

## Backup

Back up the config directory (except `cache/`). It holds provider logins and password hashes, so keep it
private.
