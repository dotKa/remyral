import { describe, expect, it } from 'vitest';
import { projectHref } from '../src/lib/reasons';

/** p6-ui-projects-settings: the project table + project page with URL tabs, and the approvals inbox rows. */

describe('Projects (p6)', () => {
  it('project fixes link to the project page tab', () => {
    expect(projectHref('alpha', 'policy')).toBe('/projects/alpha?tab=policy');
    expect(projectHref(null)).toBe('/projects');
  });
});
