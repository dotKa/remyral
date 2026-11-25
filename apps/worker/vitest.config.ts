import { mergeConfig } from 'vitest/config';
import { packageProject } from '../../vitest.shared.js';

// Transport tests poll for asynchronous socket effects; on a busy machine 1 s (the default) is too short.
export default mergeConfig(packageProject('worker'), {
  test: { expect: { poll: { timeout: 5_000 } } },
});
