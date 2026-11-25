/**
 * Turns the master's QR SVG into a `data:image/svg+xml;base64,...` URL for an `<img>`.
 *
 * Why not inject the markup: SVG loaded as an image never runs scripts, never loads external resources
 * and cannot touch the DOM, so even a hostile string is inert. That keeps the console free of
 * `dangerouslySetInnerHTML` and works under the master's CSP (`img-src 'self' data:`).
 * Returns null for anything that does not look like an SVG document.
 */
export function svgToDataUri(svg: string): string | null {
  const text = svg.trim();
  if (!/^<svg[\s>]/.test(text) || !text.endsWith('</svg>')) return null;
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return `data:image/svg+xml;base64,${btoa(binary)}`;
}

/** Splits a base32 secret into groups of four for reading aloud / typing ("ABCD EFGH ..."). */
export function groupSecret(secret: string): string {
  return (secret.match(/.{1,4}/g) ?? []).join(' ');
}

/** Only `otpauth://totp/...` URIs are offered as links (the master generates them; this is defence in depth). */
export function safeOtpauthUri(uri: string): string | null {
  return /^otpauth:\/\/totp\/[^\s"'<>]+$/.test(uri) ? uri : null;
}
