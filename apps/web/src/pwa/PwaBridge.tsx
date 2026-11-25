import { type ReactNode, useEffect } from 'react';
import { useNavigate } from 'react-router';
import { getPushStatus } from '../api/notifications';
import { currentSubscription, permission, pushSupport, syncPush } from './push';
import { setNavigateHandler } from './serviceWorker';

/**
 * p8-pwa glue inside the signed-in shell: notification clicks route within the app and the browser's push
 * subscription is refreshed with the master once per start. The "new version available" offer is the Diyalog shell's
 * own banner (`DyUpdateBanner`, never an automatic reload: a form or a step-up dialog may be open).
 */
export function PwaBridge(): ReactNode {
  const navigate = useNavigate();

  useEffect(() => {
    setNavigateHandler((path) => {
      void navigate(path);
    });
    return () => {
      setNavigateHandler(null);
    };
  }, [navigate]);

  useEffect(() => {
    const run = { cancelled: false };
    void (async () => {
      if (pushSupport() !== 'supported' || permission() !== 'granted') return;
      if (!(await currentSubscription())) return;
      const status = await getPushStatus();
      if (!run.cancelled) await syncPush(status.available ? status.publicKey : null);
    })().catch(() => undefined); // best effort; the Devices page shows the real state
    return () => {
      run.cancelled = true;
    };
  }, []);

  return null;
}
