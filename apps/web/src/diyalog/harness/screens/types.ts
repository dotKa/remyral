/**
 * p12-diyalog Faz 4 harness: a fixture route of a secondary screen. Gets the URL and the method; `undefined` falls
 * through to the base fixtures (the home / job thread ones), so a screen may refine a shared path (`/jobs` with its
 * own filters) without changing what the home reads.
 */
export type ScreenRoute = (url: URL, method: string) => unknown;
export type ScreenRoutes = Readonly<Record<string, ScreenRoute>>;
