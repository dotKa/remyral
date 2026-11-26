import { appendFileSync } from 'node:fs';
import { relative } from 'node:path';
import type { Reporter, TestCase } from 'vitest/node';

/**
 * CI only (REMYRAL_TEST_RETRY): lists the tests that passed only on a retry, in the log and in the GitHub job summary
 * ($GITHUB_STEP_SUMMARY), with the error of each failed try. A retry keeps a load-dependent test from failing the run;
 * it must never hide it (the known ones: CONTRIBUTING.md, "Flaky tests on hosted runners").
 */
export default class FlakyReporter implements Reporter {
  readonly #flaky: { name: string; tries: number; errors: string[] }[] = [];

  onTestCaseResult(test: TestCase): void {
    const diagnostic = test.diagnostic();
    const result = test.result();
    if (result.state !== 'passed' || diagnostic === undefined || diagnostic.retryCount === 0) return;
    this.#flaky.push({
      name: `${test.project.name} ${relative(process.cwd(), test.module.moduleId)} > ${test.fullName}`,
      tries: diagnostic.retryCount + 1,
      errors: (result.errors ?? []).map((e) => e.message.split('\n')[0] ?? '').slice(0, 3),
    });
  }

  onTestRunEnd(): void {
    if (this.#flaky.length === 0) return;
    const lines = this.#flaky.map(
      (f) =>
        `- \`${f.name}\` (passed on try ${String(f.tries)})${f.errors.map((e) => `\n  - ${e}`).join('')}`,
    );
    const text = `### Tests that passed only on a retry (${String(this.#flaky.length)})\n\n${lines.join('\n')}\n`;
    process.stdout.write(`\n${text}\n`);
    const summary = process.env.GITHUB_STEP_SUMMARY;
    if (summary !== undefined && summary !== '') appendFileSync(summary, `${text}\n`);
  }
}
