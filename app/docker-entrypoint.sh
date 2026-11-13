#!/bin/sh
# Starts Zibbit as an ordinary user instead of root.
#
# Who it runs as:  PUID / PGID if you set them (on Unraid: 99 and 100, which is nobody:users);
#                  otherwise the owner of the config folder; if that is root, user 1000.
#                  PUID=0 keeps the old behaviour and runs as root.
# What it fixes:   files that earlier versions saved as root are handed to that user once, so nothing is left unreadable.
set -e

# already started as an ordinary user (for example with --user): nothing to switch
if [ "$(id -u)" != "0" ]; then exec "$@"; fi

CONFIG="${CONFIG_DIR:-/config}"
mkdir -p "$CONFIG"

uid="${PUID:-}"
gid="${PGID:-}"
if [ -z "$uid" ]; then
  uid="$(stat -c %u "$CONFIG")"
  [ -z "$gid" ] && gid="$(stat -c %g "$CONFIG")"
  if [ "$uid" = "0" ]; then uid=1000; gid=1000; fi
fi
[ -z "$gid" ] && gid="$uid"

if [ "$uid" = "0" ]; then
  echo "[zibbit] PUID=0: running as root, as older versions did."
  exec "$@"
fi

# the config folder: everything in it, once (a quick look first, so a normal start costs nothing)
if [ -n "$(find "$CONFIG" ! -user "$uid" -print -quit 2>/dev/null)" ] || [ "$(stat -c %g "$CONFIG")" != "$gid" ]; then
  echo "[zibbit] giving the config folder to user $uid:$gid (one time)"
  chown -R "$uid:$gid" "$CONFIG"
fi
# folders you map in for recordings and the rewind buffer: only the top folder, so a large library is never walked
for d in "${RECORDINGS_DIR:-/recordings}" "${REWIND_DIR:-/rewind}"; do
  if [ -d "$d" ] && [ "$(stat -c %u:%g "$d")" != "$uid:$gid" ]; then chown "$uid:$gid" "$d" 2>/dev/null || echo "[zibbit] could not give $d to user $uid:$gid"; fi
done

exec "${ZIBBIT_SWITCH:-su-exec}" "$uid:$gid" "$@"
