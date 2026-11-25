#!/usr/bin/env node
// Fake `claude` / `codex` login CLIs for the remote-ops login relay tests (p5-remote-ops). Behaviour follows
// what the pinned CLIs do (verified 2026-10-14): Claude Code 2.1.296 `auth login --claudeai` prints a sign-in
// URL and reads the pasted code from stdin; Codex 0.162.1 `login --device-auth` prints a URL and a one-time
// code and finishes by itself. On success each writes a credential file under the user's HOME and — to prove
// the worker never relays runtime output — prints the token too.
//   FAKE_CLI=claude|codex   which CLI to imitate
//   FAKE_MODE=evil          print a foreign URL instead of the provider's
//   FAKE_MODE=hang          never finish
/* global setTimeout, setInterval */
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const TOKEN = 'sk-ant-oat01-FAKE-test-only-not-a-real-key-3456789012';
const cli = process.env.FAKE_CLI ?? 'claude';
const mode = process.env.FAKE_MODE ?? '';
const home = process.env.HOME ?? '/nonexistent';
const args = process.argv.slice(2);
// Record which environment names the worker passed (values never).
writeFileSync(
  join(home, `env-${cli}-${args.join('_')}.json`),
  JSON.stringify(Object.keys(process.env).sort()),
);

const claudeCred = join(process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'), '.credentials.json');
const codexCred = join(process.env.CODEX_HOME ?? join(home, '.codex'), 'auth.json');

function save(file) {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, JSON.stringify({ accessToken: TOKEN }), { mode: 0o600 });
}

if (cli === 'claude') {
  if (args[0] === 'auth' && args[1] === 'status') {
    const ok = existsSync(claudeCred);
    process.stdout.write(
      JSON.stringify(
        ok
          ? { loggedIn: true, authMethod: 'claude.ai', email: 'owner@example.com', subscriptionType: 'max' }
          : { loggedIn: false, authMethod: 'none' },
      ),
    );
    process.exit(ok ? 0 : 1);
  }
  if (args[0] === 'auth' && args[1] === 'logout') {
    rmSync(claudeCred, { force: true });
    process.exit(0);
  }
  if (args[0] === 'auth' && args[1] === 'login') {
    const url =
      mode === 'evil'
        ? 'https://evil.example/collect?x=1'
        : 'https://claude.com/cai/oauth/authorize?code=true&client_id=test&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&state=s1';
    process.stdout.write('Opening browser to sign in…\n');
    // The URL arrives in two chunks (the relay must wait for the whole URL).
    process.stdout.write(`If the browser didn't open, visit: ${url.slice(0, 40)}`);
    setTimeout(() => process.stdout.write(`${url.slice(40)}\n`), 50);
    if (mode === 'hang') setInterval(() => undefined, 1000);
    const rl = createInterface({ input: process.stdin });
    rl.once('line', (line) => {
      if (line.trim() === 'good-code#s1') {
        save(claudeCred);
        process.stdout.write(`Login successful. Token: ${TOKEN}\n`);
        process.exit(0);
      }
      process.stderr.write('Login failed: Request failed with status code 400\n');
      process.exit(1);
    });
  }
} else {
  if (args[0] === 'login' && args[1] === 'status') {
    if (existsSync(codexCred)) {
      process.stdout.write('Logged in using ChatGPT\n');
      process.exit(0);
    }
    process.stderr.write('Not logged in\n');
    process.exit(1);
  }
  if (args[0] === 'logout') {
    rmSync(codexCred, { force: true });
    process.exit(0);
  }
  if (args[0] === 'login' && args[1] === '--device-auth') {
    process.stdout.write(
      '\nWelcome to Codex [v\u001b[90m0.162.1\u001b[0m]\nFollow these steps to sign in with ChatGPT using device code authorization:\n\n1. Open this link in your browser and sign in to your account\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-EFGHI\u001b[0m\n\n',
    );
    if (mode === 'hang') setInterval(() => undefined, 1000);
    else
      setTimeout(() => {
        save(codexCred);
        process.stdout.write(`Successfully logged in (${TOKEN})\n`);
        process.exit(0);
      }, 400);
  }
}
