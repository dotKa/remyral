/**
 * p9-notification-sound: "the user just did something" — announced by the API client for every mutation it sends,
 * so the notification sound stays silent for the echo of the user's own action (docs/design/p9-notification-sound.md
 * §5). Reading / managing notifications, marking chat read and sign-in requests are not actions that cause
 * notifications and are left out (marking read happens on its own when a message arrives).
 */
export const OWN_ACTION_EVENT = 'remyral:own-action';

const IGNORED = /^\/(auth|notifications)(\/|$)|\/read(-all)?$/;

export function isOwnAction(method: string, path: string): boolean {
  return method !== 'GET' && !IGNORED.test(path.split('?')[0] ?? path);
}

export function announceOwnAction(method: string, path: string): void {
  if (typeof window === 'undefined' || !isOwnAction(method, path)) return;
  window.dispatchEvent(new Event(OWN_ACTION_EVENT));
}
