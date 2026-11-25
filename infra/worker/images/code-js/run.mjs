// Remyral code node runner (p14-workflow-engine 14.3, K3). Reads ONE JSON document {source, input} from stdin,
// runs `source` as the body of an async function (input, ctx) and writes exactly one JSON line to stdout:
// {"ok":true,"output":…} or {"ok":false,"error":"…"}. The user code's console output goes to stderr, so stdout
// stays the protocol channel. The container has no network, a read-only root and no secrets.
import { Buffer } from 'node:buffer';
import { writeSync } from 'node:fs';

const out = (doc) => {
  writeSync(1, `${JSON.stringify(doc)}\n`);
};
const toStderr =
  (prefix) =>
  (...args) => {
    try {
      writeSync(2, `${prefix}${args.map((a) => (typeof a === 'string' ? a : safe(a))).join(' ')}\n`);
    } catch {
      // stderr closed: ignore
    }
  };
const safe = (v) => {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};
console.log = toStderr('');
console.info = toStderr('');
console.debug = toStderr('');
console.warn = toStderr('warn: ');
console.error = toStderr('error: ');

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
let doc;
try {
  doc = JSON.parse(Buffer.concat(chunks).toString('utf8'));
} catch {
  out({ ok: false, error: 'runner: stdin is not one JSON document' });
  process.exit(2);
}
try {
  const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
  const fn = new AsyncFunction('input', 'ctx', String(doc.source));
  const ctx = Object.freeze({ language: 'js' });
  const value = await fn(doc.input, ctx);
  const json = JSON.stringify(value === undefined ? null : value);
  if (json === undefined) throw new Error('the return value is not JSON-serialisable');
  writeSync(1, `{"ok":true,"output":${json}}\n`);
  process.exit(0);
} catch (err) {
  out({ ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  process.exit(1);
}
