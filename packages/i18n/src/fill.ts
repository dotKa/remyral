/**
 * Fills a catalog string's `{name}` placeholders (the syntax of the `errors` catalog) — for messages written as strings
 * with `{param}` instead of functions (p16-chat-complete, p16-api-tokens). Values are text only (numbers via `String`),
 * nothing is parsed as markup. A placeholder without a value stays as it is, so a missing value shows instead of
 * vanishing.
 */
export function fill(template: string, params: Readonly<Record<string, string | number>> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m: string, name: string) => {
    const v = Object.hasOwn(params, name) ? params[name] : undefined;
    return v === undefined ? m : String(v);
  });
}
