// age encryption to the owner's PUBLIC keys only (p10-backup-restore §7). The host never holds an identity that
// could decrypt a backup: a recipients file with a private key, or any age identity in the backed-up directories,
// stops the run.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RECIPIENT_RE = /^age1[02-9ac-hj-np-z]{58}$/;
const IDENTITY_MARK = 'AGE-SECRET-KEY-';

/** Parses a recipients file: `age1…` lines, blank lines and `#` comments. Throws on anything else. */
export function parseRecipients(text) {
  if (text.includes(IDENTITY_MARK)) {
    throw new Error(
      'the recipients file contains an age PRIVATE key (AGE-SECRET-KEY-…); only public keys belong on the server',
    );
  }
  const out = [];
  for (const [i, raw] of text.split('\n').entries()) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!RECIPIENT_RE.test(line))
      throw new Error(`recipients line ${String(i + 1)} is not an age1… public key`);
    out.push(line);
  }
  if (out.length === 0) throw new Error('the recipients file has no age1… public key');
  return [...new Set(out)];
}

/** Files under `dir` (recursive, regular files ≤ 1 MiB) that contain an age identity. */
export function findIdentities(dir, rel = '') {
  const hits = [];
  let entries;
  try {
    entries = readdirSync(join(dir, rel));
  } catch {
    return hits;
  }
  for (const name of entries) {
    const p = join(rel, name);
    let st;
    try {
      st = lstatSync(join(dir, p));
    } catch {
      continue;
    }
    if (st.isDirectory()) hits.push(...findIdentities(dir, p));
    else if (st.isFile() && st.size <= 1_048_576) {
      try {
        if (readFileSync(join(dir, p), 'latin1').includes(IDENTITY_MARK)) hits.push(p);
      } catch {
        // unreadable: the tar step reports it
      }
    }
  }
  return hits;
}

/** argv for `age` encrypting stdin (or `input`) to every recipient into `output`. */
export function ageEncryptArgs(recipients, output, input) {
  const args = [];
  for (const r of recipients) args.push('-r', r);
  args.push('-o', output);
  if (input !== undefined) args.push(input);
  return args;
}
