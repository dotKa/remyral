/** "1.2 GB", "340 MB", "12 KB" (binary units, as operating systems show disk use). */
export function formatBytes(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const n = i === 0 || v >= 10 ? String(Math.round(v)) : String(Math.round(v * 10) / 10);
  return `${n} ${units[i] ?? 'B'}`;
}
