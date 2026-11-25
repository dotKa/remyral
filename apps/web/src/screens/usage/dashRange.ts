export type DashPeriod = '7d' | '30d' | '90d' | 'month' | 'last-month';

export function dashRange(p: DashPeriod, now: number = Date.now()): { from: string; to: string } {
  const day = 86_400_000;
  const to = new Date(now + 1000);
  const d = new Date(now);
  switch (p) {
    case '7d':
      return { from: new Date(now - 7 * day).toISOString(), to: to.toISOString() };
    case '30d':
      return { from: new Date(now - 30 * day).toISOString(), to: to.toISOString() };
    case '90d':
      return { from: new Date(now - 90 * day).toISOString(), to: to.toISOString() };
    case 'month':
      return { from: new Date(d.getFullYear(), d.getMonth(), 1).toISOString(), to: to.toISOString() };
    case 'last-month':
      return {
        from: new Date(d.getFullYear(), d.getMonth() - 1, 1).toISOString(),
        to: new Date(d.getFullYear(), d.getMonth(), 1).toISOString(),
      };
  }
}
