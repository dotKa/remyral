// Preloaded into each ESLint process by scripts/lint.mjs: prints the peak resident memory on exit, so the
// headroom against the CI runners' memory stays visible in the logs.
import process from 'node:process';

process.on('exit', () => {
  const peakMb = Math.round(process.resourceUsage().maxRSS / 1024);
  process.stderr.write(
    `lint: ${process.env.REMYRAL_LINT_TARGET ?? 'eslint'} peak rss ${String(peakMb)} MB\n`,
  );
});
