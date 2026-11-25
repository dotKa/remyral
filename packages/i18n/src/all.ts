import { en } from './en/index.js';
import type { Locale } from './locale.js';
import { type Messages, registerCatalog } from './messages.js';
import { tr } from './tr/index.js';

/**
 * p14-web-perf-2: both catalogs, synchronously — for Node callers (the master's template texts, catalog tests).
 * Importing this module registers English, so `messagesFor('en')` answers in English everywhere in that process. The
 * console imports `@remyral/i18n` and loads English on demand instead (`loadCatalog`).
 */
registerCatalog('en', en);

export const CATALOGS: Readonly<Record<Locale, Messages>> = { tr, en };

export { messagesFor } from './messages.js';
