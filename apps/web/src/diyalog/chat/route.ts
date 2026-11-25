/**
 * `/chat` → null (latest conversation), `/chat/:id` → id; undefined for any other route.
 * p14-web-perf: a module of its own so the shell can route without loading the Sohbet chunk.
 */
export function chatRouteId(pathname: string): string | null | undefined {
  if (pathname === '/chat' || pathname === '/chat/') return null;
  const m = /^\/chat\/([^/]+)\/?$/.exec(pathname);
  if (m === null) return undefined;
  try {
    const id = decodeURIComponent(m[1] ?? '');
    return id === '' ? null : id;
  } catch {
    return undefined;
  }
}

/** "Yeni iş" anywhere in the shell: `/chat#yeni-is`. */
export const NEW_JOB_HASH = 'yeni-is';

/**
 * p18-plans-ui: `/chat/:id?plan=<plan id>` (the Planlar screen's link) — the conversation opens with its plan shown: the
 * plan panel for the active plan, the details' Planlar tab with the read-only view for an earlier one.
 */
export const PLAN_PARAM = 'plan';

/** The link to a plan in its conversation. */
export function planHref(threadId: string, planId: string): string {
  return `/chat/${encodeURIComponent(threadId)}?${PLAN_PARAM}=${encodeURIComponent(planId)}`;
}
