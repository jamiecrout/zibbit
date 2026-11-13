# Versions and releasing

## What the numbers mean

The server uses [semantic versioning](https://semver.org/), `MAJOR.MINOR.PATCH`:

- **PATCH** (2.1.0 to 2.1.1): fixes only. Nothing to do when updating.
- **MINOR** (2.1.0 to 2.2.0): new features, such as a new kind of source or a new screen. Existing config keeps working.
- **MAJOR** (2.x to 3.0): something an admin has to act on, such as a changed config file or a removed feature.
  The change is described in `docs/UPGRADING.md`.

The number lives in one place, `version` in `app/package.json`. The server logs it at start-up and shows it in
Settings. A release is the git tag `v<version>`, and the image carries the same number.

The **Android app** has its own version (`versionName` and `versionCode` in `android-app/AndroidManifest.xml`
and `build.sh`) and is released separately. Any 2.x server works with any 2.x app. When an app feature needs
a newer server, `CHANGELOG.md` says so.

## Image tags

| Tag | What it is |
| --- | --- |
| `latest` | The newest release. Moves only when a release is tagged. |
| `2.1` | The newest 2.1.x release, for staying on one minor version and taking fixes. |
| `2.1.0` | Exactly that release. Never changes. |
| `edge` | Whatever is on `main`, released or not. For trying things early. |
| `<branch name>` | A test build of that branch (amd64 only). |

A pre-release such as `2.2.0-rc1` publishes only its own tag, never `latest`.

## Making a release

1. In `CHANGELOG.md`, move what is under **Unreleased** to a new `## [X.Y.Z] - date` heading, and mention any
   Android app version that ships with it.
2. Set `version` in `app/package.json` to `X.Y.Z`.
3. Run the tests: `cd app && npm test`.
4. Commit to `main` (`Release X.Y.Z`), then tag and push:

   ```
   git tag vX.Y.Z
   git push origin main vX.Y.Z
   ```

   The image workflow refuses a tag that does not match `app/package.json`, so a mismatch fails instead of
   publishing the wrong version.
5. When the workflow finishes, check that `docker pull ghcr.io/jamiecrout/zibbit:X.Y.Z` works. Optionally
   publish release notes with `gh release create vX.Y.Z --notes-file <the changelog section>`.

## Releasing the Android app

1. Raise `versionCode` by one and set `versionName` in `android-app/AndroidManifest.xml` and `build.sh`.
2. Build and sign it with the same key as before (see `android-app/README.md`). A different key will not install
   over an existing install.
3. Put the APK, its SHA-256 and the signing certificate's SHA-256 in the public `zibbit-android` repository's
   README, and add the app version to `CHANGELOG.md`.
