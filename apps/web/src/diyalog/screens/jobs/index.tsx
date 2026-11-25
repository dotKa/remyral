import { lazyScreen } from '../../../lib/lazyScreen';
import type { ReactNode } from 'react';

const JobsScreen = lazyScreen(() => import('./JobsScreen'), 'JobsScreen');
const WorkflowRunScreen = lazyScreen(() => import('./WorkflowRuns'), 'WorkflowRunScreen');
// p18-multi-project W5: job fan-out batches.
const BatchListScreen = lazyScreen(() => import('./BatchScreens'), 'BatchListScreen');
const BatchNewScreen = lazyScreen(() => import('./BatchScreens'), 'BatchNewScreen');
const BatchScreen = lazyScreen(() => import('./BatchScreens'), 'BatchScreen');

/**
 * p12-diyalog Faz 4: İşler + Kuyruk (exactly `/jobs`) in the Diyalog language; p12-diyalog-w1: the workflow run page
 * `/jobs/workflows/:runId` (keyed by run). `/jobs/:id` is the job control panel; `/jobs/new` and templates have their
 * own matchers. Returns null for every other path (classic in the frame) and for a run id that does not decode.
 */
export function matchJobs(pathname: string): ReactNode | null {
  if (pathname === '/jobs') return <JobsScreen />;
  // p18-multi-project W5: `/jobs/batches`, `/jobs/batches/new`, `/jobs/batches/:id`.
  if (pathname === '/jobs/batches') return <BatchListScreen />;
  if (pathname === '/jobs/batches/new') return <BatchNewScreen />;
  const b = /^\/jobs\/batches\/([^/]+)$/.exec(pathname);
  if (b !== null) {
    let id: string;
    try {
      id = decodeURIComponent(b[1] ?? '');
    } catch {
      return null;
    }
    return id === '' ? null : <BatchScreen key={id} batchId={id} />;
  }
  const m = /^\/jobs\/workflows\/([^/]+)$/.exec(pathname);
  if (m === null) return null;
  let runId: string;
  try {
    runId = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  return runId === '' ? null : <WorkflowRunScreen key={runId} runId={runId} />;
}
