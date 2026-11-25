#!/usr/bin/env node
// Emits JSON Schema for both protocol directions (ADR-0011 §5) into dist/schema/.
import { mkdirSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { MasterToWorker, PROTOCOL_VERSION, WorkerToMaster } from '../dist/index.js';

const out = new URL('../dist/schema/', import.meta.url);
mkdirSync(out, { recursive: true });
for (const [name, schema] of Object.entries({ WorkerToMaster, MasterToWorker })) {
  const json = z.toJSONSchema(schema, { io: 'input' });
  writeFileSync(new URL(`${name}.v${PROTOCOL_VERSION}.json`, out), JSON.stringify(json, null, 2) + '\n');
}
console.log(`protocol: JSON Schema v${PROTOCOL_VERSION} written to dist/schema/`);
