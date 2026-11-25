import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const ProjectScreen = lazyScreen(() => import('./ProjectScreen'), 'ProjectScreen');
const ProjectsList = lazyScreen(() => import('./ProjectsList'), 'ProjectsList');
// p19-ide W1: the code viewer / reviewer routes — their own chunk with CodeMirror (never in the home bundle).
const CodeScreen = lazyScreen(() => import('../../code/CodeScreen'), 'CodeScreen');

/**
 * p12-diyalog Faz 4: Projeler (/projects, /projects/:id) in the Diyalog language. Returns the screen for a path it
 * owns, or null (the shell then leaves the path to the route table). p19-ide W1: `/projects/:id/code`,
 * `/projects/:id/code/jobs/:jobId` and `/projects/:id/code/compare`.
 */
export function matchProjects(pathname: string): ReactNode | null {
  if (pathname === '/projects') return <ProjectsList />;
  const code = /^\/projects\/([^/]+)\/code(?:\/(jobs)\/([^/]+)|\/(compare))?$/.exec(pathname);
  if (code !== null) {
    let id: string;
    let jobId: string | undefined;
    try {
      id = decodeURIComponent(code[1] ?? '');
      jobId = code[3] === undefined ? undefined : decodeURIComponent(code[3]);
    } catch {
      return null;
    }
    if (id === '') return null;
    const view = code[2] === 'jobs' ? 'job' : code[4] === 'compare' ? 'compare' : 'browse';
    return <CodeScreen key={id} project={id} view={view} jobId={jobId} />;
  }
  const m = /^\/projects\/([^/]+)$/.exec(pathname);
  if (m === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  return id === '' ? null : <ProjectScreen key={id} id={id} />;
}
