/**
 * Runtime version pins: the data lives in @remyral/protocol (packages/protocol/src/runtime-pins.ts) so the
 * master's runtime policy template and the worker compare against the same compiled-in pins.
 */
export { RUNTIME_PINS, type RuntimePin } from '@remyral/protocol';

/** Minimum Node.js for the worker itself (ADR-0002). */
export const MIN_NODE_MAJOR = 24;
