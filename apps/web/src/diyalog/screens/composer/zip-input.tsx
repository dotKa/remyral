import { type ReactNode, useId, useState } from 'react';
import { useT } from '../../../i18n/I18nProvider';
import { formatBytes } from '../../../screens/chat/attachment-files';
import type { Draft, Errors } from '../../../screens/composer/draft';
import { type ComposerZip, composerZipWithout, readComposerZip } from '../../../screens/composer/zip-input';

/**
 * p16-zip-job-input (ADR-0060): the composer's "Files from a .zip" field — for workspace and repository jobs started
 * now. The .zip is read in the browser when picked; the controller uploads it as an input bundle when the job is
 * submitted. Secret findings stop the submission until the person chooses "Send anyway"; refused files (e.g.
 * executables) can be left out. A "Run again" reuses the earlier job's bundle while it is kept.
 */
export function ZipInputField(props: {
  readonly draft: Draft;
  readonly set: (p: Partial<Draft>) => void;
  readonly errors: Errors;
}): ReactNode {
  const z = useT().shared.chat.zip;
  const { draft, set } = props;
  const zip = draft.inputZip;
  const reuse = draft.inputBundleReuse;
  const id = useId();
  const [reading, setReading] = useState(false);
  const patch = (p: Partial<ComposerZip>): void => {
    if (zip !== null) set({ inputZip: { ...zip, ...p } });
  };
  const plan = zip?.plan ?? null;
  return (
    <div className="grid min-w-0 gap-1.5" data-testid="dy-composer-zip">
      <label htmlFor={id} className="text-[0.8125rem] font-bold text-dy-ink">
        {z.composerLabel}
      </label>
      {reuse !== null && zip === null ? (
        <p
          className="m-0 flex flex-wrap items-center gap-2 text-[0.8125rem] text-dy-ink"
          data-testid="dy-zip-reuse"
        >
          {z.composerReuse({ name: reuse.label ?? reuse.id.slice(0, 8), n: reuse.fileCount })}
          <button
            type="button"
            className="rounded-[7px] border border-dy-line-2 px-2 py-0.5 text-[0.78125rem]"
            onClick={() => {
              set({ inputBundleReuse: null });
            }}
          >
            {z.composerDrop}
          </button>
        </p>
      ) : null}
      <input
        id={id}
        type="file"
        accept=".zip,application/zip"
        aria-describedby={`${id}-hint`}
        className="w-full max-w-full text-[0.875rem] text-dy-muted file:mr-3 file:min-h-10 file:cursor-pointer file:rounded-[9px] file:border file:border-dy-line-2 file:bg-dy-card file:px-3 file:text-[0.875rem] file:font-bold file:text-dy-ink"
        onChange={(e) => {
          const file = e.target.files?.[0];
          e.target.value = '';
          if (file === undefined) return;
          setReading(true);
          void readComposerZip(file)
            .then((r) => {
              set({ inputZip: r, inputBundleReuse: null });
            })
            .finally(() => {
              setReading(false);
            });
        }}
      />
      <p id={`${id}-hint`} className="m-0 text-[0.78125rem] text-dy-muted">
        {z.composerHint}
      </p>
      {reading ? (
        <p role="status" className="m-0 text-[0.8125rem] text-dy-muted">
          {z.reading}
        </p>
      ) : null}
      {zip === null ? null : (
        <div
          className="grid gap-1 rounded-[11px] border border-dy-line px-3 py-2 text-[0.8125rem]"
          data-testid="dy-zip-card"
        >
          <span className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-dy-ink">{zip.name}</span>
            {plan === null ? null : (
              <span className="text-dy-muted">
                {z.summary({ n: plan.files.length, size: formatBytes(plan.totalBytes) })}
              </span>
            )}
            <button
              type="button"
              className="ml-auto rounded-[7px] border border-dy-line-2 px-2 py-0.5 text-[0.78125rem]"
              onClick={() => {
                set({ inputZip: null });
              }}
            >
              {z.composerDrop}
            </button>
          </span>
          {plan?.strippedRoot == null ? null : (
            <span className="text-dy-muted">{z.stripped({ folder: plan.strippedRoot })}</span>
          )}
          {plan !== null && plan.skipped > 0 ? (
            <span className="text-dy-muted">{z.skippedFiles({ n: plan.skipped })}</span>
          ) : null}
          {zip.error !== null && plan === null ? (
            <p role="alert" className="m-0 text-dy-red-ink">
              {zip.error}
            </p>
          ) : null}
          {plan !== null && plan.problems.length > 0 ? (
            <ul role="alert" className="m-0 list-none p-0 text-dy-red-ink">
              {plan.problems.map((x) => (
                <li key={x}>{z.inputProblems[x]}</li>
              ))}
            </ul>
          ) : null}
          {plan !== null && plan.refused.length > 0 ? (
            <div className="text-dy-muted">
              <p className="m-0">{z.refusedFiles({ n: plan.refused.length })}</p>
              <ul className="m-0 list-none p-0 font-dy-mono text-[0.75rem]">
                {plan.refused.slice(0, 10).map((r) => (
                  <li key={`${r.path}-${r.reason}`} className="break-all">
                    {r.path} — {r.reason}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {zip.progress === null ? null : (
            <progress
              className="h-1 w-full"
              max={Math.max(1, zip.progress.totalBytes)}
              value={zip.progress.sentBytes}
            />
          )}
          {zip.findings.length > 0 && zip.uploadId === null ? (
            <div role="alert" className="grid gap-1 text-dy-red-ink" data-testid="dy-zip-secrets">
              <p className="m-0">{z.secretsTitle({ n: zip.findings.length })}</p>
              <ul className="m-0 list-none p-0 font-dy-mono text-[0.75rem]">
                {zip.findings.slice(0, 20).map((f) => (
                  <li key={`${f.path}:${String(f.line)}:${f.rule}`} className="break-all">
                    {z.secretLine({ path: f.path, line: f.line, rule: f.rule })}
                  </li>
                ))}
              </ul>
              {zip.allowSecrets ? (
                <span className="text-dy-muted">{z.willSendAnyway}</span>
              ) : (
                <span className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="dy-zip-send-anyway"
                    className="rounded-[7px] border border-dy-red-ink px-2 py-0.5"
                    onClick={() => {
                      patch({ allowSecrets: true });
                    }}
                  >
                    {z.sendAnyway}
                  </button>
                  <span className="text-dy-muted">{z.sendAnywayHint}</span>
                </span>
              )}
            </div>
          ) : null}
          {zip.error !== null && plan !== null ? (
            <div role="alert" className="grid gap-1 text-dy-red-ink">
              <p className="m-0">{z.failed({ error: zip.error })}</p>
              {zip.refused.length > 0 ? (
                <button
                  type="button"
                  data-testid="dy-zip-leave-out"
                  className="justify-self-start rounded-[7px] border border-dy-line-2 px-2 py-0.5 text-dy-ink"
                  onClick={() => {
                    set({ inputZip: composerZipWithout(zip) });
                  }}
                >
                  {z.leaveOut({ n: zip.refused.length })}
                </button>
              ) : null}
            </div>
          ) : null}
          {zip.uploadId === null ? null : <span className="text-dy-green">{z.uploaded}</span>}
        </div>
      )}
      {props.errors.inputZip === undefined ? null : (
        <p role="alert" className="m-0 text-[0.8125rem] font-medium text-dy-red-ink">
          {props.errors.inputZip}
        </p>
      )}
    </div>
  );
}
