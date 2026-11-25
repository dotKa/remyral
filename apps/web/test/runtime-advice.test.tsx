import { configure, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseAdvice } from '../src/api/runtimeAdvice';
import { adviceOf } from '../src/screens/chat/drafts';
import { adviceSettingsProblem } from '../src/screens/runtimeAdviceSettings';
import { emptyDraft } from '../src/screens/composer/draft';
import { RuntimeAdvice } from '../src/diyalog/screens/composer/where';
import { fakeFetch } from './helpers';

/**
 * p11-runtime-advice (docs/design/p11-runtime-advice.md): the advice note (composer), the chat card's advice line, the
 * job page's runtime-and-outcome card with 👍 / 👎, Projects → Policy → Runtime advice and Usage → Outcomes' matrix.
 */

configure({ asyncUtilTimeout: 5_000 });

afterEach(() => {
  vi.unstubAllGlobals();
});

const ADVICE = {
  mode: 'auto',
  classification: {
    kind: 'execute',
    kindSource: 'inferred',
    area: 'frontend',
    areaSource: 'prompt',
    scores: { frontend: 3 },
    signals: [{ source: 'prompt', area: 'frontend', weight: 1, detail: 'layout…' }],
  },
  advice: {
    recommended: 'claude-code',
    confidence: 'strong',
    scope: "this project's frontend jobs",
    text: "Recommended runtime for this project's frontend jobs: Claude Code — 91% good outcomes (n=23) vs Codex 74% (n=19); median 12 min; est. cost $0.42",
    options: [],
  },
};

const SETTINGS = {
  mode: 'advice',
  explorationPct: 10,
  minSamples: 5,
  allowedRuntimes: [],
  allowPaid: false,
  halfLifeDays: 60,
  rerunWindowDays: 3,
  areaRules: [],
};

describe('advice note (composer)', () => {
  // p15-classic-removal: the classic composer note's tests, on the Diyalog composer's advice (same request).
  it('shows the advice with its evidence, offers the recommended runtime and auto mode; the user chooses', async () => {
    const f = fakeFetch({ 'POST /api/routing/advice': () => ({ status: 200, body: ADVICE }) });
    vi.stubGlobal('fetch', f.fetch);
    const set = vi.fn();
    const draft = { ...emptyDraft(), project: 'acme', prompt: 'Fix the navbar layout', runtime: 'codex' };
    render(<RuntimeAdvice draft={draft} set={set} errors={{}} preview={null} />);
    const text = await screen.findByTestId('runtime-advice-text');
    expect(text.textContent).toContain('Claude Code — 91% good outcomes (n=23) vs Codex 74% (n=19)');
    expect(f.requests[0]?.body).toEqual({ project: 'acme', prompt: 'Fix the navbar layout' });
    const user = userEvent.setup();
    await user.click(screen.getByTestId('use-advised-runtime'));
    expect(set).toHaveBeenCalledWith({ runtime: 'claude-code', model: '' });
    await user.click(screen.getByTestId('use-auto-runtime'));
    expect(set).toHaveBeenLastCalledWith(expect.objectContaining({ runtime: 'auto' }));
  });

  it('no button when the draft already uses the advised runtime and advice is not auto', async () => {
    vi.stubGlobal(
      'fetch',
      fakeFetch({ 'POST /api/routing/advice': () => ({ status: 200, body: { ...ADVICE, mode: 'advice' } }) })
        .fetch,
    );
    const draft = { ...emptyDraft(), project: 'acme', prompt: 'x', runtime: 'claude-code' };
    render(<RuntimeAdvice draft={draft} set={vi.fn()} errors={{}} preview={null} />);
    await screen.findByTestId('runtime-advice-text');
    expect(screen.queryByTestId('use-advised-runtime')).toBeNull();
    expect(screen.queryByTestId('use-auto-runtime')).toBeNull();
  });

  it('parses the advice payload', () => {
    expect(parseAdvice(ADVICE).advice?.recommended).toBe('claude-code');
    expect(() => parseAdvice({ mode: 'weird' })).toThrow();
  });
});

describe('chat draft card', () => {
  it('reads the advice from the payload and says when the card uses another runtime', () => {
    expect(
      adviceOf({ runtimeAdvice: { text: 'Recommended …', recommended: 'claude-code' } }, 'codex'),
    ).toEqual({
      text: 'Recommended …',
      differs: true,
    });
    expect(adviceOf({ runtimeAdvice: { text: 'R', recommended: 'codex' } }, 'codex')?.differs).toBe(false);
    expect(adviceOf({}, 'codex')).toBeNull();
  });
});

describe('Projects → Policy → Runtime advice', () => {
  it('refuses out-of-range values without a request', () => {
    expect(adviceSettingsProblem({ ...SETTINGS, mode: 'auto', explorationPct: 40 })).toContain('Exploration');
    expect(adviceSettingsProblem({ ...SETTINGS, mode: 'auto', minSamples: 1 })).toContain('Minimum');
    expect(adviceSettingsProblem({ ...SETTINGS, mode: 'auto' })).toBeNull();
  });
});
