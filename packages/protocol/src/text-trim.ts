/**
 * Linear-time trimming helpers. A `/[…]+$/` regex rescans the rest of the string from every position of a long run
 * that is not at the end (quadratic on untrusted text); these walk back from the end once.
 */

/** `s` without its trailing run of code units for which `drop` is true. */
export function trimEndWhile(s: string, drop: (ch: string) => boolean): string {
  let end = s.length;
  while (end > 0 && drop(s.charAt(end - 1))) end -= 1;
  return end === s.length ? s : s.slice(0, end);
}
