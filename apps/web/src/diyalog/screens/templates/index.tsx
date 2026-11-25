import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const TemplateDetail = lazyScreen(() => import('./TemplateDetail'), 'TemplateDetail');
const TemplateForm = lazyScreen(() => import('./TemplateForm'), 'TemplateForm');
const TemplatesList = lazyScreen(() => import('./TemplatesList'), 'TemplatesList');

/**
 * p12-diyalog-w1: Templates (`/jobs/templates`, `/jobs/templates/new`, `/jobs/templates/:id`,
 * `/jobs/templates/:id/edit`) in the Diyalog language. Returns null for every other path (and for an id that does
 * not decode), so the classic route handles it.
 */
export function matchTemplates(pathname: string): ReactNode | null {
  if (pathname === '/jobs/templates') return <TemplatesList />;
  if (pathname === '/jobs/templates/new') return <TemplateForm key="new" />;
  const m = /^\/jobs\/templates\/([^/]+)(\/edit)?$/.exec(pathname);
  if (m === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  if (id === '') return null;
  return m[2] === undefined ? (
    <TemplateDetail key={id} id={id} />
  ) : (
    <TemplateForm key={`edit:${id}`} id={id} />
  );
}
