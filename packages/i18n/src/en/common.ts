import { plural } from '../plural.js';
import type { Shape } from '../shape.js';
import type tr from '../tr/common.js';

export default {
  machineCount: (p) => `${String(p.n)} ${plural('en', p.n, { one: 'machine', other: 'machines' })}`,
  jobCount: (p) => `${String(p.n)} ${plural('en', p.n, { one: 'job', other: 'jobs' })}`,
  onMachine: (p) => `on ${p.name}`,
} satisfies Shape<typeof tr>;
