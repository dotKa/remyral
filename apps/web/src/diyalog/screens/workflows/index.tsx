import { lazyScreen } from '../../../lib/lazyScreen';
import { lazy, type ReactNode, Suspense } from 'react';
import { SkeletonRows } from '../parts';
import { useT } from '../../../i18n/I18nProvider';
import { ScreenFrame } from '../ScreenFrame';

const WorkflowsScreen = lazyScreen(() => import('./WorkflowsScreen'), 'WorkflowsScreen');
// p14-workflow-engine 14.5: the template gallery and the create-from-template wizard (own chunks, no canvas library).
const TemplateGallery = lazyScreen(() => import('./templates/TemplateGallery'), 'TemplateGallery');
const TemplateWizard = lazyScreen(() => import('./templates/TemplateWizard'), 'TemplateWizard');

/**
 * p13-workflows-ui: `/workflows` (the list) and `/workflows/new`, `/workflows/:id` (the editor / viewer, keyed by
 * id). The editor is a lazy chunk: React Flow, dagre and yaml load only when a workflow is opened. Null for every
 * other path and for an id that does not decode.
 */

const WorkflowEditorScreen = lazy(() => import('./WorkflowEditor'));

function Loading(): ReactNode {
  const e = useT().workflows.editor;
  return (
    <ScreenFrame title={e.workflow} back={{ to: '/workflows', label: e.back }} testId="dy-workflow-loading">
      <SkeletonRows label={e.editorLoading} rows={4} />
    </ScreenFrame>
  );
}

export function matchWorkflows(pathname: string): ReactNode | null {
  if (pathname === '/workflows') return <WorkflowsScreen />;
  if (pathname === '/workflows/templates') return <TemplateGallery />;
  const tm = /^\/workflows\/templates\/([a-z0-9-]{1,64})$/.exec(pathname);
  if (tm?.[1] !== undefined) return <TemplateWizard key={tm[1]} id={tm[1]} />;
  const m = /^\/workflows\/([^/]+)$/.exec(pathname);
  if (m === null) return null;
  let id: string;
  try {
    id = decodeURIComponent(m[1] ?? '');
  } catch {
    return null;
  }
  if (id === '') return null;
  const key = id === 'new' ? 'new' : id;
  return (
    <Suspense key={key} fallback={<Loading />}>
      <WorkflowEditorScreen key={key} id={id === 'new' ? null : id} />
    </Suspense>
  );
}
