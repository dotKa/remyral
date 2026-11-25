import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { listUntrustedAllows, revokeUntrustedAllow, type UntrustedAllow } from '../../../api/chat';
import type { ApiError } from '../../../api/client';
import { toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { DyIcon } from '../../icons';
import { useDoneToast } from '../../toast/useDoneToast';
import { ConfirmButton, DyApiError } from '../forms';
import { EmptyLine, Panel, Row, Rows, SkeletonRows } from '../parts';
import { DyTime } from '../records';

/**
 * oss-sec3 — Ayarlar → Sohbet → Hatırlanan onaylar (every user, their own): the kinds of assistant actions on a target
 * the person told a held card to remember. They run without a card even in a turn that read untrusted content. Each one
 * can be forgotten (no step-up: it only takes a permission away); audited by the master.
 */
export function RememberedConfirmationsPanel(): ReactNode {
  const t = useT().settings.chat.remembered;
  const [rows, setRows] = useState<readonly UntrustedAllow[] | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done);
  const submit = useSubmit();

  const load = useCallback(async () => {
    try {
      setRows(await listUntrustedAllows());
      setLoadError(null);
    } catch (err) {
      setLoadError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function forget(a: UntrustedAllow): void {
    setDone(null);
    void submit.run(async () => {
      await revokeUntrustedAllow(a.id);
      setDone(t.forgotten({ label: a.label }));
      await load();
    });
  }

  return (
    <Panel
      title={t.title}
      count={rows === null ? undefined : String(rows.length)}
      sub={t.sub}
      flush
      testId="dy-untrusted-allows"
    >
      <div className="px-4 empty:hidden">
        <DyApiError error={loadError} />
      </div>
      {rows === null ? (
        loadError === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : rows.length === 0 ? (
        <EmptyLine testId="no-untrusted-allows">{t.empty}</EmptyLine>
      ) : (
        <Rows label={t.title}>
          {rows.map((a) => (
            <Row
              key={a.id}
              testId="dy-untrusted-allow"
              lead={<DyIcon name="shield" className="size-4" />}
              title={a.label}
              meta={
                <>
                  <span className="font-dy-mono">{a.action}</span>
                  {a.target === '' ? null : <span className="font-dy-mono">{a.target}</span>}
                  <span>
                    {t.since} <DyTime iso={a.createdAt} />
                  </span>
                </>
              }
              actions={
                <ConfirmButton
                  label={t.forget}
                  question={t.forgetQuestion({ label: a.label })}
                  disabled={submit.busy}
                  testId={`untrusted-allow-forget-${a.id}`}
                  onConfirm={() => {
                    forget(a);
                  }}
                />
              }
            />
          ))}
        </Rows>
      )}
    </Panel>
  );
}
