import { type ReactNode } from 'react';
import type { ExportResult } from '../api/download';
import { Notice } from '../components/ui';

export function ExportNotice(props: { readonly result: ExportResult }): ReactNode {
  const r = props.result;
  return (
    <Notice tone={r.verified === false ? 'danger' : 'ok'} live>
      <span data-testid="export-result">
        Saved <span className="font-mono">{r.filename}</span>: {r.recordCount} record
        {r.recordCount === 1 ? '' : 's'}.{' '}
        {r.verified === true
          ? 'Checksum verified.'
          : r.verified === false
            ? 'Checksum mismatch — discard this file and export again.'
            : 'Checksum in the last line of the file.'}{' '}
        <span className="font-mono text-xs break-all">SHA-256 {r.sha256}</span>
        {r.truncated ? ' The export reached its size limit; continue to get the rest.' : ''}
      </span>
    </Notice>
  );
}
