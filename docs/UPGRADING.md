# Upgrading

## From 2.x to 3.0

**Back up the config folder first.** 3.0 changes how your files are stored, and the change is one-way.

- **Saved logins are now encrypted.** On first start 3.0 encrypts provider logins, tokens in playlist addresses and guide
  addresses. 2.x cannot read them afterwards. To go back to 2.x, restore your backup of the config folder.
- **Keep the recovery key.** An admin can read it under Admin settings > Security. It is also what opens the server backups.
  Set `ZIBBIT_KEY` to keep it off the disk; if you do, store it somewhere safe, because without it the logins cannot be read.
- **The config folder is handed once** to the user the container now runs as. On Unraid set `PUID` to 99 and `PGID` to 100.
- **A provider that serves from inside your network** may stop loading, because requests to private addresses are refused.
  If so, set `ALLOW_PRIVATE_UPSTREAM=1`.
- **Optional folders:** map `/recordings` for recordings and downloads, and `/rewind` for the rewind buffer.

## From v1

v2 reads the v1 config as it is: `providers.json`, `users.json`, `settings.json`, `secret.key`,
`epgmap.json`, per-person `state-*.json` and the cache. Nothing is converted, and a v1 install tested
this way keeps its sign-ins, groups and favorites (this is part of `npm test`).

What differs:

- **The server no longer runs as root.** On first start it hands the config folder to the user named by `PUID` and `PGID`
  (by default the folder's owner, or user 1000 when it belongs to root; on Unraid set `99` and `100`), then runs as that user.
  Nothing else changes. To keep running as root, set `PUID=0`.

- **Nobody is an admin yet.** Existing profiles become regular users, with no forced password change, and
  **no default admin account is created** on an install that already has profiles. Make one person
  an admin from the command line, then everything else is done in the browser:

  ```
  docker exec -it zibbit node server.js promote <name>
  ```

  (`demote <name>` reverses it. The last admin can't be demoted from the browser.)
- **Installs with no profiles at all** (open, or `APP_PASSWORD`) now get the first-run `admin` account.
  `APP_PASSWORD`, if set, becomes the first password of that account, which must still be changed at first
  sign-in. The shared-password mode itself is gone.
- Provider and settings edits made in the browser are written to `providers.json` and `settings.json`
  (the same files and formats; unknown keys are preserved). Changes take effect immediately, with no
  restart.
- `providers.example.json` is no longer written.

Rolling back to v1 is just running the v1 code against the same config. v1 ignores the extra fields v2 adds
(`role`, `mustChange`, `type`, the new settings keys). Providers added as M3U playlists are skipped by v1.
