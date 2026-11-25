# Leak check for the public repository

The repository is public. Nothing specific to one installation or one person may enter it: an operator's domains
and host addresses, ssh aliases and key file names, cloud account and resource ids, personal e-mail addresses, local
paths and machine names, private notes. `scripts/security/public-denylist.mjs` refuses such content. Secrets (tokens,
keys, passwords) are a separate concern, covered by gitleaks and `pnpm scan:secrets` (see below).

The check has two layers:

- **Generic rules in the repository** (`scripts/security/public-denylist.json`). They describe *kinds* of
  installation data that no public file needs — cloud resource ids, real home directories, machine names, free-mail
  addresses — and name no installation and no person. They run everywhere, CI included.
- **A private list per maintainer**, kept **outside** the repository and passed with `--extra`. It holds the values
  that identify the maintainer's own installation: domains, host addresses, ssh aliases, e-mail addresses, user and
  machine names, project names, private folder names. It never enters the repository, not even in hashed form (see
  [Why no hashed values](#why-no-hashed-values)).

## Running it

```sh
pnpm check:leaks                                         # = node scripts/security/public-denylist.mjs --tree
node scripts/security/public-denylist.mjs --staged       # what the next commit would contain
node scripts/security/public-denylist.mjs --history      # every commit reachable from HEAD
node scripts/security/public-denylist.mjs --tree --extra ~/private/denylist.txt
node scripts/security/public-denylist.mjs --tree --json  # findings and counts per category / directory
```

- `--tree` checks tracked files and new, not ignored files. It is part of `pnpm verify`.
- `--staged` checks the index: run it with your private list before committing, or from a pre-push hook.
- `--history` checks every line any commit added, every path a commit touched, commit messages and the author /
  committer e-mail addresses. Contributors' own addresses are theirs to publish and pass; only an address git made up
  from the local user and machine name (`user.email` unset: `…@host.local`, `…@host`) is refused. Commit trailers
  (`Signed-off-by:` …) name contributors and are checked against the private list only.
- Output is `path:line category/rule [fingerprint]`. The matched value is **never printed**; the fingerprint is a
  keyed hash with a random key per run, so equal values can be recognised within one run and nothing can be
  recovered from a log. Exit code 1 on errors, 0 when only warnings remain, 2 on a usage or configuration error.

### Where it runs

- **CI, without a private list**: the `leaks` job of `.github/workflows/ci.yml` runs `--tree` and `--history` (full
  fetch depth) with the generic rules only, followed by gitleaks on an export of `HEAD` and on the history. This
  catches the kinds of data no public file needs, from any contributor.
- **Locally, with your private list**: before a push, run `--tree` (or `--staged`) with `--extra`. A pre-push hook
  in your checkout makes it automatic:

  ```sh
  # .git/hooks/pre-push (not tracked; adjust the path to your private list)
  #!/bin/sh
  exec node scripts/security/public-denylist.mjs --tree --extra "$HOME/private/denylist.txt"
  ```

To reproduce the CI job locally:

```sh
node scripts/security/public-denylist.mjs --tree && node scripts/security/public-denylist.mjs --history
rm -rf /tmp/leak-tree && mkdir /tmp/leak-tree && git archive HEAD | tar -x -C /tmp/leak-tree
gitleaks dir --redact --config .gitleaks.toml /tmp/leak-tree && gitleaks git --redact --config .gitleaks.toml .
```

## Generic rules

| Category | What it refuses |
|---|---|
| `cloud-id` | ARNs with a real 12-digit account (the AWS documentation account passes), EC2 instance / security group / VPC / subnet / EIP ids, `ec2-<ip>.` public host names; `ip-<a>-<b>-<c>-<d>` internal EC2 host names as a warning (obviously synthetic ones pass) |
| `host-access` | ssh commands with an explicit key file under `~/.ssh` (write `<key>` and `<host>`) |
| `ipv4` | any public IPv4 address in host documentation and scripts (`docs/ops/`, `infra/`, `scripts/deploy/`), as a warning |
| `local-path` | real home directories (`/Users/<name>/`, `/home/<name>/`, `C:\Users\<name>\`; generic names such as `alex`, `user`, `runner`, `ubuntu`, one- or two-letter names and system folders pass), application directories in macOS `Library/Application Support` other than the product's own and the browser profiles the macOS sandbox denies |
| `machine-name` | `*-MacBook-*.local` and generated Windows names (`DESKTOP-` or `LAPTOP-` and seven letters or digits) |
| `personal-mail` | free-mail addresses (`@gmail.`, `@icloud.`, `@outlook.` …) |
| `commit-metadata` | made-up local author / committer addresses (`--history`) |
| `owner-note` | dated owner-decision markers (warning) |
| `top-level` | a top-level directory or root file that is not listed in `topLevel.entries`: adding one is a deliberate decision |

## The private `--extra` list

`--extra <file>` adds a maintainer's own entries from a file kept **outside** the repository. Each entry applies to
file content, file paths, commit messages (trailers included) and commit e-mail addresses, and is reported as
`<category>/private:L<line>` — the line number in your list, never the value.

```text
# comments and blank lines are ignored
[owner-domain]                          # following entries are reported in this category (default: extra)
re:(?:^|[^a-z0-9-])(?:[a-z0-9-]+\.)*my-company\.example\b
  allow: apps/master/migrations/0001_seed.sql   # indented: this entry does not apply to that path (glob)
[identity]
lit:jo.maintainer@mailhost.example      # a literal, case-insensitive (a bare line is a literal too)
re:\bjmaintainer\b                      # a JavaScript regular expression, case-insensitive
  except: github\.com/jmaintainer/[a-z0-9._-]+   # indented: a match inside this match is not reported
[private-path]
re:^notes/|notes/plan\.md
```

Use an `allow:` line for a file that must keep a value (an applied migration, which is never edited) and an
`except:` line for a public form of a private value (for example the repository URL under a personal account, or the
account's GitHub noreply address). `--tree` reports allow lines that matched nothing, as for the public rules. The
original format — one literal per line, `re:` for a regex — is still read unchanged.

## Why no hashed values

An earlier version stored sensitive literals in the public configuration as salted, slow hashes. That does not hide
them: the salt and cost are public, and the input spaces are small. An IPv4 address of a given length has about a
billion candidates, a note such as "cloud provider address" narrows them to a few published ranges, and an e-mail
address at a guessable domain or a key file name is shorter still; a single machine checks every candidate in hours
to days. A hash in a public repository therefore publishes the value to anyone patient, and the entry's length and
note tell them where to look. Values that identify an installation belong only in the private list.

## Allowlist entries

Prefer fixing the content (an example value, a placeholder such as `<host>` or `console.example.com`). When content
must stay, add the narrowest entry, always with a `reason` of at least 20 characters:

- **path entry** on one rule: `"allow": [{ "glob": "apps/master/migrations/0166_worker_update_notice.sql", "reason": "…" }]` —
  the rule does not apply to that path (`**` spans directories, `*` stays within one);
- **pattern exception** on one rule: `"except": [{ "pattern": "…", "reason": "…" }]` — a match that lies inside a
  match of the exception pattern is not reported, the rest of the line still is;
- the global `allow` list covers every public rule (not the private list) and holds only the denylist
  configuration itself.

A reason must not restate the value it allows. `--tree` prints `note: allowlist entry no longer needed: …` for
entries that matched nothing; remove them. Tests: `scripts/test/public-denylist.test.mjs`.

## Relation to gitleaks and `pnpm scan:secrets`

- **gitleaks** (`.gitleaks.toml`, the default rules plus narrow allowlists) looks for secrets in the tree and the
  history; CI downloads a pinned, checksum-verified release.
- **`pnpm scan:secrets`** uses the same rules as the runtime log redaction, so a format the redactor knows is also
  refused in Git; it also checks the built web bundle for secrets, server configuration names and canary values.
  Its allowlist is `scripts/security/secret-scan.allow.json` (path globs and value fingerprints, each with a reason).
- The **public denylist** covers what neither of them can know: installation data that is not a secret but still
  identifies a person or a deployment — generically in the repository, specifically in each maintainer's private
  list.
