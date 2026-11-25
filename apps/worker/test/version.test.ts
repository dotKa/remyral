import { describe, expect, it } from 'vitest';
import { extractVersion, stripNuls, versionAtLeast } from '../src/probe/version.js';

describe('extractVersion', () => {
  it.each([
    ['2.1.296 (Claude Code)', '2.1.296'],
    ['codex-cli 0.162.1', '0.162.1'],
    ['1.19.0\n', '1.19.0'],
    ['v24.19.0', '24.19.0'],
    ['Python 3.12.13', '3.12.13'],
    ['git version 2.50.1 (Apple Git-155)', '2.50.1'],
    ['Docker version 29.7.2, build a7dcaa6fdb', '29.7.2'],
    ['uv 0.12.2 (46ead6098 2026-08-05 aarch64-apple-darwin)', '0.12.2'],
    ['1.2.0-beta.3', '1.2.0-beta.3'],
    ['WSL version: 2.4.13.0', '2.4.13'],
  ])('%s → %s', (input, expected) => {
    expect(extractVersion(input)).toBe(expected);
  });

  it('returns null without a version', () => {
    expect(extractVersion('command not found')).toBeNull();
  });
});

describe('versionAtLeast', () => {
  it('compares numerically', () => {
    expect(versionAtLeast('3.12.0', '3.12.0')).toBe(true);
    expect(versionAtLeast('3.14.6', '3.12.0')).toBe(true);
    expect(versionAtLeast('3.11.9', '3.12.0')).toBe(false);
    expect(versionAtLeast('3.9.0', '3.12.0')).toBe(false);
    expect(versionAtLeast('garbage', '3.12.0')).toBe(false);
  });
});

describe('stripNuls', () => {
  it('decodes UTF-16LE text that was read as UTF-8', () => {
    expect(stripNuls('W\u0000S\u0000L\u0000 \u00002\u0000.\u00004\u0000.\u00001\u0000')).toBe('WSL 2.4.1');
  });
});
