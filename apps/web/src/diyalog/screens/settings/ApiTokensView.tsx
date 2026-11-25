import { fill } from '@remyral/i18n';
import { type ReactNode, useCallback, useEffect, useState } from 'react';
import {
  type ApiToken,
  createMyToken,
  type IssuedToken,
  listMyTokens,
  revokeMyToken,
  rotateMyToken,
  type TokenRules,
} from '../../../api/apiTokens';
import type { ApiError } from '../../../api/client';
import { toApiError } from '../../../components/ui';
import { useT } from '../../../i18n/I18nProvider';
import { useSubmit } from '../../../screens/useSubmit';
import { DyApiError, DyNotice } from '../forms';
import { EmptyLine, Panel, Rows, SkeletonRows } from '../parts';
import { CreateTokenForm, RotateDialog, SecretReveal, TokenRow } from './api-tokens-parts';
import { useDoneToast } from '../../toast/useDoneToast';

/**
 * p16-api-tokens (docs/design/p16-api-tokens.md §8): Ayarlar → API anahtarları — the signed-in person's own tokens.
 * Create (shown once, with a copy button and a curl line), list (scopes, last use, expiry with a warning from 7 days),
 * rotate (overlap + new lifetime) and revoke. Every role may hold personal tokens unless the security policy turned
 * them off; the scopes offered are those the role can use.
 */
export function ApiTokensView(): ReactNode {
  const t = useT().apiTokens;
  const [items, setItems] = useState<readonly ApiToken[] | null>(null);
  const [rules, setRules] = useState<TokenRules | null>(null);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const [issued, setIssued] = useState<IssuedToken | null>(null);
  const [rotating, setRotating] = useState<ApiToken | null>(null);
  const [done, setDone] = useState<string | null>(null);
  useDoneToast(done, { testId: 'api-tokens-done' });
  const submit = useSubmit();

  const load = useCallback(async () => {
    try {
      const out = await listMyTokens();
      setItems(out.items);
      setRules(out.rules);
      setLoadError(null);
    } catch (err) {
      setLoadError(toApiError(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  function revoke(tok: ApiToken): void {
    setDone(null);
    void submit.run(async () => {
      await revokeMyToken(tok.id);
      setDone(fill(t.revoke.done, { name: tok.name }));
      await load();
    });
  }

  if (items === null || rules === null)
    return loadError === null ? (
      <Panel title={t.pages.personal.label}>
        <SkeletonRows label={t.loading} rows={3} />
      </Panel>
    ) : (
      <DyApiError error={loadError} />
    );

  return (
    <div className="grid gap-4" data-testid="dy-api-tokens">
      {issued === null ? null : (
        <SecretReveal
          issued={issued}
          onClose={() => {
            setIssued(null);
          }}
        />
      )}
      <Panel title={t.create.title} sub={t.create.sub} testId="api-token-create-panel">
        {rules.personal ? (
          <CreateTokenForm
            rules={rules}
            create={createMyToken}
            onCreated={(out) => {
              setIssued(out);
              setDone(fill(t.created, { name: out.token.name }));
              void load();
            }}
          />
        ) : (
          <DyNotice tone="neutral" testId="api-tokens-disabled">
            {t.create.disabled}
          </DyNotice>
        )}
      </Panel>
      <Panel
        title={t.list.title}
        count={String(items.length)}
        countLabel={fill(t.list.count, { n: items.length })}
        flush
        testId="api-token-list"
      >
        {items.length === 0 ? (
          <EmptyLine testId="api-tokens-empty">{t.list.empty}</EmptyLine>
        ) : (
          <Rows label={t.list.title}>
            {items.map((tok) => (
              <TokenRow
                key={tok.id}
                token={tok}
                busy={submit.busy}
                onRotate={rules.personal ? setRotating : undefined}
                onRevoke={revoke}
              />
            ))}
          </Rows>
        )}
        <div className="flex flex-col gap-2 px-4 pb-4 empty:hidden">
          <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
        </div>
      </Panel>
      <RotateDialog
        token={rotating}
        rules={rules}
        rotate={(tok, input) => rotateMyToken(tok.id, input)}
        onClose={() => {
          setRotating(null);
        }}
        onRotated={(out) => {
          setRotating(null);
          setIssued(out);
          setDone(fill(t.rotated, { name: out.token.name }));
          void load();
        }}
      />
    </div>
  );
}
