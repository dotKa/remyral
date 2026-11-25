#!/usr/bin/env node
// Fails if an ADR file is missing from docs/adr/README.md (ADR-0001).
import { readdirSync, readFileSync } from 'node:fs';

const dir = new URL('../docs/adr/', import.meta.url);
const index = readFileSync(new URL('README.md', dir), 'utf8');
const missing = readdirSync(dir)
  .filter((f) => /^\d{4}-.+\.md$/.test(f))
  .filter((f) => !index.includes(`(${f})`));
if (missing.length) {
  console.error(`adr: not listed in docs/adr/README.md: ${missing.join(', ')}`);
  process.exit(1);
}
console.log('adr: index complete');
