# Publishing a control-plane release (vendor)

- **Applies to:** the vendor (the maintainers) publishing a self-hosted release; customers follow
  [selfhost-install.md](selfhost-install.md)
- **Design / decision:** [p16-selfhost-onboarding](../design/p16-selfhost-onboarding.md), [ADR-0063](../adr/0063-selfhost-distribution-and-update-trust.md)
- **Tool:** `scripts/release/control-plane.mjs` (images, bundle, feed, verify)

Nothing in the repository uploads anything by itself: building + pushing images and uploading the bundle are explicit
steps below. The release key stays on the vendor's machine (offline backup in the password manager).

## 1. One-time preparation

1. Release key: reuse the worker release key (`~/remyral-release-key/release-key.pem`, domains differ) or create a
   separate one: `node scripts/release/sign.mjs keygen --out ~/remyral-cp-release-key`. Note its key id (printed) — it
   goes into the release announcement so customers can compare it.
2. Registry: a GHCR organisation (e.g. `ghcr.io/<org>`) with packages `remyral-master`, `remyral-web`,
   `remyral-backup` (public, or private with pull credentials for customers). `docker login ghcr.io` with a token that
   can write packages.
3. Release URL: the official channel is `https://releases.remyral.com/control-plane`. Anyone publishing their own
   channel uses any static HTTPS location they control (e.g. `https://releases.example.com/control-plane`: S3 +
   CloudFront, Cloudflare R2 / Pages, GitHub Pages). It serves `<url>/feed.json`, `<url>/feed.sig.json` and
   `<url>/<version>/*`.

## 2. Build and push the images (multi-arch, by digest)

```sh
git checkout <release commit> && git status --porcelain   # clean tree
node scripts/release/control-plane.mjs images --version 1.2.0 --registry ghcr.io/<org> --dry-run   # the commands
node scripts/release/control-plane.mjs images --version 1.2.0 --registry ghcr.io/<org>
```

`docker buildx build --platform linux/amd64,linux/arm64 --provenance=mode=max --sbom=true --push --metadata-file …`
per image; `dist/control-plane/1.2.0/digests.json` gets the registry manifest digests.

## 3. Bundle, sign, feed

```sh
# CHANGELOG.md: move the Unreleased entries under "## [1.2.0] - <date>" first (the notes are that section).
node scripts/release/control-plane.mjs bundle --version 1.2.0 --registry ghcr.io/<org> \
  --digests dist/control-plane/1.2.0/digests.json --key ~/remyral-cp-release-key/release-key.pem \
  --min-worker 1.0.77 --release-url https://releases.remyral.com/control-plane \
  [--breaking "…"]… [--min-upgrade-from 1.1.0] [--channel stable]
node scripts/release/control-plane.mjs verify --dir dist/control-plane/1.2.0 --public-key <pub>
node scripts/release/control-plane.mjs feed --out dist/control-plane --key ~/remyral-cp-release-key/release-key.pem
```

The feed covers every release directory under `--out` — keep the earlier releases there (or sync them back from the
release URL before running `feed`). A version is published once (the tool refuses to overwrite).

## 4. Publish

Upload `dist/control-plane/` to the release URL (e.g. `aws s3 sync dist/control-plane s3://<bucket>/control-plane
--cache-control max-age=300`; `feed.json` / `feed.sig.json` with a short cache time). Then:

1. On a scratch Linux VM: `curl -fsSLO <url>/1.2.0/install.sh && sudo bash install.sh --dry-run --domain … --tls …`
   (verifies the published files end to end), then a real install, then `remyral-ctl upgrade` from the previous
   release.
2. Announce the release with its key id and notes.

## 5. Key rotation

Create the new key; publish one release whose `bundle` call adds `--also-trust <new pub>` signed with the **old** key
(installations then trust both); later releases are signed with the new key; drop the old one from `--also-trust`
when no installation is older than the overlap release.

## 6. First public release — checklist

- [ ] Release key chosen, key id recorded; registry org and release URL exist.
- [ ] CHANGELOG section `## [1.0.0]`.
- [ ] `images` (real push), `bundle`, `verify`, `feed`.
- [ ] Upload; scratch-VM install in all three TLS modes (at least Let's Encrypt), the setup token, the wizard,
      `upgrade --check`, `doctor`.
- [ ] Customer docs link: `<url>/<version>/INSTALL.md` / `KURULUM.md`.
