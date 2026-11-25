import { type ReactNode, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router';
import { SEALED_REQUEST, SSO_RESUME_PATHS } from '../../api/sso';
import { useAuth } from '../../auth/AuthProvider';
import { useT } from '../../i18n/I18nProvider';
import { browser } from '../../screens/ssoBrowser';
import { useStepUp } from '../../stepup/StepUpProvider';
import { DyNotice } from '../forms';
import { DyButton, Panel } from './parts';
import { ScreenFrame } from './ScreenFrame';

/** Margin so a step-up that expires during the round trip to Coolify does not bounce the user back. */
const STEP_UP_MARGIN_MS = 60_000;

/**
 * p12-diyalog-w4: `/sso/continue?flow=oidc|coolify&r=…` (p5-coolify-sso) in the Diyalog language — the same logic as
 * the classic SsoContinuePage: it continues only to the two fixed same-origin master paths with the opaque sealed
 * request `r` (never to a URL from the query), OIDC asks for a fresh authenticator code unless the session has one
 * for at least another minute, a gate ticket waits for a click, other roles and malformed links are refused.
 */
export function DySsoContinue(): ReactNode {
  const [params] = useSearchParams();
  const { state } = useAuth();
  const stepUp = useStepUp();
  const t = useT().auth.sso;
  const [cancelled, setCancelled] = useState(false);
  const started = useRef(false);
  const flow = params.get('flow');
  const r = params.get('r') ?? '';
  const error = params.get('error');
  const valid = (flow === 'oidc' || flow === 'coolify') && SEALED_REQUEST.test(r);
  const session = state.kind === 'signedIn' ? state.session : null;
  const user = state.kind === 'signedIn' ? state.user : null;
  const privileged = user !== null && (user.role === 'owner' || user.role === 'admin');

  const continueOidc = async (): Promise<void> => {
    const until = session?.stepUpValidUntil ? Date.parse(session.stepUpValidUntil) : 0;
    if (until - Date.now() < STEP_UP_MARGIN_MS) {
      const ok = await stepUp.confirm(t.stepUpReason);
      if (!ok) {
        setCancelled(true);
        return;
      }
    }
    browser.assign(`${SSO_RESUME_PATHS.oidc}?r=${encodeURIComponent(r)}`);
  };

  useEffect(() => {
    if (flow !== 'oidc' || !valid || !privileged || session === null || started.current) return;
    started.current = true;
    void continueOidc();
  }, [flow, valid, privileged, session]);

  let body: ReactNode;
  if (error === 'forbidden' || (user !== null && !privileged)) {
    body = (
      <DyNotice tone="red" testId="dy-sso-role">
        {t.role}
      </DyNotice>
    );
  } else if (!valid) {
    body = (
      <DyNotice tone="red" testId="dy-sso-invalid">
        {t.invalid}
      </DyNotice>
    );
  } else if (flow === 'coolify') {
    body = (
      <div className="grid gap-3">
        <p className="m-0 text-[0.9375rem] text-dy-muted">
          {t.gateBefore} <b className="font-bold text-dy-ink">{user?.username}</b>
          {t.gateAfter}
        </p>
        <div>
          <DyButton
            variant="primary"
            icon="globe"
            onClick={() => {
              browser.assign(`${SSO_RESUME_PATHS.coolify}?r=${encodeURIComponent(r)}`);
            }}
          >
            {t.gateButton}
          </DyButton>
        </div>
      </div>
    );
  } else {
    body = (
      <div className="grid gap-3">
        <p className="m-0 text-[0.9375rem] text-dy-muted">
          {t.oidcBefore} <b className="font-bold text-dy-ink">{user?.username}</b>
          {t.oidcAfter}
        </p>
        {cancelled ? (
          <div>
            <DyButton
              variant="primary"
              icon="key"
              onClick={() => {
                setCancelled(false);
                void continueOidc();
              }}
            >
              {t.confirm}
            </DyButton>
          </div>
        ) : (
          <p role="status" className="m-0 flex items-center gap-2 text-[0.875rem] text-dy-muted">
            <span className="dy-breathe size-2 rounded-full bg-dy-teal" aria-hidden="true" />
            {t.continuing}
          </p>
        )}
      </div>
    );
  }

  return (
    <ScreenFrame title={t.title} purpose={t.purpose} width="narrow" testId="dy-sso">
      <Panel title={t.panel}>{body}</Panel>
    </ScreenFrame>
  );
}
