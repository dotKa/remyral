/**
 * The shape another language must match (ADR-0053 §2). The Turkish catalog is the source of truth; every
 * other language's namespace is written `export default { … } satisfies Shape<typeof trNamespace>`, so a
 * missing key, an extra key or a message with different parameters fails `pnpm typecheck`.
 *
 * A message is a string or a function of one typed parameter object returning a string (for values,
 * plurals and Turkish suffixes). No HTML in messages: rich text is composed in JSX around them.
 */
export type Shape<T> = {
  readonly [K in keyof T]: T[K] extends string
    ? string
    : T[K] extends (...args: infer A) => string
      ? (...args: A) => string
      : Shape<T[K]>;
};
