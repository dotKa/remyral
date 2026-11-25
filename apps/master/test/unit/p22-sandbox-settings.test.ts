// p22-sandbox-settings — draft_worker_config_change `sandbox`: the settings patch keeps the other panel settings and
// changes only the switches asked for.
import { describe, expect, it } from 'vitest';
import { sandboxSettingsPatch } from '../../src/chat/tools.js';

describe('p22-sandbox-settings: assistant settings patch', () => {
  it('adds the asked switches to the current settings', () => {
    expect(
      sandboxSettingsPatch(
        { logLevel: 'debug', sandbox: { linuxPrivateNetwork: 'off' } },
        { linuxLoginStoreView: true },
      ),
    ).toEqual({
      settings: { logLevel: 'debug', sandbox: { linuxPrivateNetwork: 'off', linuxLoginStoreView: true } },
    });
    expect(sandboxSettingsPatch(undefined, { linuxPrivateNetwork: 'auto' })).toEqual({
      settings: { sandbox: { linuxPrivateNetwork: 'auto' } },
    });
  });

  it('nothing asked (or nonsense) changes nothing', () => {
    expect(sandboxSettingsPatch({ logLevel: 'info' }, undefined)).toEqual({});
    expect(sandboxSettingsPatch({ logLevel: 'info' }, {})).toEqual({});
    expect(
      sandboxSettingsPatch(undefined, { linuxPrivateNetwork: 'on', linuxLoginStoreView: 'yes' }),
    ).toEqual({});
  });
});
