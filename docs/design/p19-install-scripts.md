# p19-install-scripts: reviewing and approving npm install scripts

Owner request (2026-10-29): "bağımlılıklar değerlendirilip onaylanabilmeli" — a local MCP server (REA) could not be
installed because its dependency `frida@17.23.2` has an install script, and the assistant called that a fixed rule.
Owner decisions: an approval **runs** the script; approvals are **platform-wide**. Decision record: ADR-0068.

## Flow
1. An `mcp.install` fails on the canary with `install_scripts_required`; the detail names the packages
   (`packages with install scripts that are not approved: frida@17.23.2 …`). The console's install view links to
   Ayarlar → Güvenlik → Kurulum betikleri; the assistant (prompt rule 61) offers `draft_install_script_approval`.
2. The master evaluates each package from `registry.npmjs.org` (version document; the full document only for the
   publish time, ≤ 8 MiB): lifecycle scripts' text (≤ 2000 characters each), `gypfile`, hosts in the scripts,
   publisher / trusted publishing, maintainers, signatures, provenance, repository, license. Nothing is downloaded or
   run on the master. 30 evaluations per user per minute.
3. The admin approves (console: `POST /mcp/install-scripts`, always-fresh step-up `extensions.install_scripts`; chat:
   the confirm-only card, the same rules). The integrity on the card must still be the registry's.
4. The install is retried. The fleet pipeline attaches the active approvals to `mcp.install` for machines with
   `mcp-install-scripts-v1`. The worker accepts exactly matching scripted entries, unpacks the tree from hashed
   tarballs, runs the approved scripts (`apps/worker/src/mcp/install-scripts.ts`), then hashes the tree and makes it
   read-only. The OPS_UPDATE report carries `scripts: { ran, sandbox, output }`; the master audits `scriptsRan` and
   `scriptsSandbox` on `mcp.install.result`.

## API (admin, `mcp.scripts`)
| Route | What |
| --- | --- |
| `GET /mcp/install-scripts` | Active approvals, then recently revoked ones (≤ 200), with the stored evaluation |
| `GET /mcp/install-scripts/evaluate?name&version` | The evaluation of one exact version |
| `POST /mcp/install-scripts` | Approve `{name, version, integrity?, reason?}` (always-fresh code) |
| `DELETE /mcp/install-scripts/:id` | Revoke (no code; it only takes a permission away) |

## The script sandbox (worker)
- `npm rebuild --ignore-scripts` (npm only) links the bins scripts call; then
  `npm rebuild <name@version>… --foreground-scripts` runs only the approved packages (npm's order, node-gyp for a
  `binding.gyp`).
- Environment: proxy / CA variables, PATH with the worker's Node, HOME / TMP in the install's staging dir, an empty
  npmrc, `npm_config_offline=true` (npm itself fetches nothing; the script may).
- Linux with a trusted, usable bubblewrap: `--ro-bind / /`, private `/dev`, `/proc`, `/tmp`, tmpfs over the worker's
  data dir, its HOME and `sandbox.protectedHomes` (the worker's Node / npm bound back read-only when they live there),
  the install dir and its staging dir bound read-write, user / IPC / PID / UTS namespaces, the network shared.
  macOS / Windows: no sandbox.
- Output: the last 4000 characters go into the report; a failing script fails the install (`install_failed`) with
  its last line.

## Limits and follow-ups
- Revoking does not remove what is installed; removing / reinstalling the server applies it.
- `p19-install-scripts-live`: run the REA / frida install on the Linux machine (bubblewrap) and on macOS.
