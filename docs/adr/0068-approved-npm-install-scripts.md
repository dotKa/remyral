# ADR-0068: Approved npm install scripts for local MCP installs

- **Status:** Accepted
- **Date:** 2026-10-29
- **Deciders:** owner (2026-10-29: "bağımlılıklar değerlendirilip onaylanabilmeli"; an approval runs the script;
  approvals are platform-wide), agent
- **Related:** `p19-install-scripts`, ADR-0054 (MCP servers and skills, P4 local packages), ADR-0056 (step-up events),
  ADR-0067 (bubblewrap on Linux); design [p19-install-scripts.md](../design/p19-install-scripts.md)

## Context
ADR-0054 P4 installs local (stdio) MCP servers from npm with the worker's own downloader: every tarball is checked
against its sha512 before it is unpacked and **install scripts never run**; a lockfile entry with `hasInstallScript`
refuses the whole install (`install_scripts_required`). That made some servers impossible: the REA MCP server depends
on `frida@17.23.2`, whose install script downloads the native binding built for the machine. The assistant then told
the owner it was "a fixed rule of the platform", which is a dead end, not a decision anyone made for that package.

## Decision
1. An admin may **approve the install script of exactly one npm version and tarball** (`name`, `version`,
   `dist.integrity`), for the whole platform (`npm_install_script_approvals`). Another version, or a re-published
   tarball, needs its own approval. Revoking stops new installs from running it; what is installed stays until it is
   removed or installed again.
2. Before approving, the master **evaluates** the version from the registry's JSON only (no download, nothing run):
   the `preinstall` / `install` / `postinstall` text, a `binding.gyp` (native build), the hosts the scripts' text names,
   the publisher (npm trusted publishing), maintainers, registry signatures, the provenance attestation, repository and
   publish time. The evaluation is stored with the approval (what the reviewer saw).
3. Approving is the authz action `mcp.scripts` (admin), the step-up event `extensions.install_scripts` in the
   **safe core** (a code in every preset), and the route is always-fresh. It is audited
   (`mcp.install_script.approve|revoke`). API tokens cannot approve. In the chat it is the
   `draft_install_script_approval` card, **confirm-only** (never run by "act directly", a plan's autonomy or a watch).
4. `mcp.install` carries the active approvals (`installScripts`, at most 200) **only to workers advertising
   `mcp-install-scripts-v1`**. Such a worker accepts a lockfile entry with an install script only when name, version
   and integrity match an approval; every other scripted package still refuses the install, and the refusal names the
   packages (`name@version`) so the assistant and the console can offer the review. Older workers keep refusing.
5. After the tree is unpacked from hashed tarballs the worker runs **only the approved packages' lifecycle scripts**
   (`npm rebuild --ignore-scripts` links bins, then `npm rebuild <name@version>… --foreground-scripts`), with a minimal
   environment (no worker secrets; HOME / TMP in the install's staging dir; empty npmrc) and the install timeout. On
   Linux, when bubblewrap is present, trusted and usable, the scripts run in their own bubblewrap view: the root file
   system read-only, the worker's data dir, its HOME and the protected homes hidden, writable only the install dir and
   its staging dir, the network open (a script may download a prebuilt binary). macOS and Windows run them without a
   sandbox; the review card and the settings page say so.
6. The tree digest is taken **after** the scripts ran, so it covers what they produced; the stat-stamp / re-hash check
   at job admission protects it as before. Script output differs per machine, so digests are per machine (they always
   were per machine; the canary's lockfile is what every machine shares).

## Consequences
- A package whose install script is needed can be used after an informed, audited decision instead of never.
- The approved script is third-party code running as the worker account: on macOS / Windows with that account's
  access. The approval is exact (integrity-pinned), always-fresh step-up, and visible / revocable in
  Ayarlar → Güvenlik → Kurulum betikleri.
- No change for PyPI (wheels only, no builds) or for the runtime installer (its pinned locks keep their name list).
