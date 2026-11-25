import { withSuffix } from '../turkish.js';

/**
 * Words shared by many screens. Turkish keeps the noun singular after a number ("3 makine"); names the UI does
 * not control take their case suffix through `withSuffix` ("mac-1’de").
 */
export default {
  machineCount: (p: { n: number }) => `${String(p.n)} makine`,
  jobCount: (p: { n: number }) => `${String(p.n)} iş`,
  /** "mac-1’de" — where something runs. */
  onMachine: (p: { name: string }) => withSuffix(p.name, 'locative'),
};
