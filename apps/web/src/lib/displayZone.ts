import { useEffect, useState } from 'react';
import { getReportSettings } from '../api/efficiency';

/**
 * p20-quick (UX research 2026-10-31): the time zone the console shows wall-clock times in — the
 * person's own time zone setting (Kullanım → Raporlar, `GET /reports/settings`, the zone the master also uses for
 * their schedules and watch notes) when they chose one, else this browser's zone. Never UTC by default: the rail
 * clock showed the server's UTC time, and a watch's "ends at" must read in the person's day.
 *
 * The setting is read once per page load (shared by every caller); until it arrives — or when it cannot be read
 * (older master, no access) — the browser's zone is used.
 */

export function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function validZone(z: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: z });
    return true;
  } catch {
    return false;
  }
}

let chosen: string | null | undefined;
let inflight: Promise<string | null> | null = null;
const listeners = new Set<(z: string | null) => void>();

function loadChosen(): Promise<string | null> {
  inflight ??= getReportSettings().then(
    (s) => (s.isDefault || !validZone(s.timeZone) ? null : s.timeZone),
    () => null,
  );
  return inflight;
}

/** Tests: forget the setting read. */
export function resetDisplayZone(): void {
  chosen = undefined;
  inflight = null;
}

/** The zone to show wall-clock times in (the person's setting, else the browser's). */
export function useDisplayZone(): string {
  const [zone, setZone] = useState<string | null>(chosen ?? null);
  useEffect(() => {
    if (chosen !== undefined) {
      setZone(chosen);
      return;
    }
    let alive = true;
    const on = (z: string | null): void => {
      if (alive) setZone(z);
    };
    listeners.add(on);
    void loadChosen().then((z) => {
      chosen = z;
      for (const l of listeners) l(z);
    });
    return () => {
      alive = false;
      listeners.delete(on);
    };
  }, []);
  return zone ?? browserZone();
}

/** "14:05:09" — the instant `ms` on a 24-hour clock in `zone`. */
export function formatZoneClock(ms: number, zone: string): string {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone: zone,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(ms));
    const get = (t: string): string => parts.find((p) => p.type === t)?.value ?? '00';
    return `${get('hour')}:${get('minute')}:${get('second')}`;
  } catch {
    const d = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, '0');
    return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  }
}

/** The zone's short name at `ms` ("GMT+3", "CET", "UTC"). */
export function zoneLabel(ms: number, zone: string): string {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date(ms))
      .find((p) => p.type === 'timeZoneName')?.value;
    return name === undefined || name === '' ? zone : name;
  } catch {
    return zone;
  }
}
