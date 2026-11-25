import { type ReactNode, useCallback, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { useAuth } from '../../auth/AuthProvider';
import { useT } from '../../i18n/I18nProvider';
import { ScreenFrame } from '../screens/ScreenFrame';
import { type BrowserState, CodeBrowser } from './CodeBrowser';
import { DiffReview } from './DiffReview';
import { codeHref, parseLineRange } from './refs';

/**
 * p19-ide W1 (docs/design/p19-ide.md §8): the full-screen code routes, a lazy chunk with CodeMirror —
 *   /projects/:id/code?ref=&path=&L=          the viewer at a branch / commit (job= for kept working files)
 *   /projects/:id/code/jobs/:jobId?path=      a job's verified changes in the reviewer (p19-ide W4: at a file)
 *   /projects/:id/code/compare?base=&head=&path=   two refs compared
 * The project page checks access again on every read (a project the caller cannot read answers 404).
 */
export function CodeScreen(props: {
  readonly project: string;
  readonly view: 'browse' | 'job' | 'compare';
  readonly jobId?: string | undefined;
}): ReactNode {
  const t = useT().code;
  const location = useLocation();
  const navigate = useNavigate();
  const { state } = useAuth();
  const q = new URLSearchParams(location.search);
  const { project } = props;
  // Operators and above may comment; the master decides per project (a viewer's write is refused there).
  const role = state.kind === 'signedIn' ? state.user.role : 'viewer';
  const canReview = role !== 'viewer';
  const onNavigate = useCallback(
    (s: BrowserState) => {
      void navigate(
        codeHref({
          project,
          source: s.job === undefined ? 'repo' : 'workfiles',
          ref: s.job ?? s.ref,
          path: s.path,
          ...(s.lines === undefined || s.lines === null
            ? {}
            : { startLine: s.lines.start, endLine: s.lines.end }),
        }),
        { replace: true, state: { codeInternal: true } },
      );
    },
    [navigate, project],
  );
  // A link from outside (a chat chip, a pasted URL) remounts the browser at its file and lines; the browser's own
  // address-bar updates do not.
  const external = useRef(location.key);
  if ((location.state as { codeInternal?: boolean } | null)?.codeInternal !== true)
    external.current = location.key;
  const back = { to: `/projects/${encodeURIComponent(project)}?tab=code`, label: t.back };
  if (props.view === 'job' && props.jobId !== undefined) {
    return (
      <ScreenFrame title={t.diff.title} back={back} purpose={t.diff.sub} testId="dy-code-review" width="wide">
        <DiffReview
          target={{ kind: 'job', jobId: props.jobId, project }}
          canReview={canReview}
          initialPath={q.get('path') ?? undefined}
        />
      </ScreenFrame>
    );
  }
  if (props.view === 'compare') {
    const base = q.get('base') ?? '';
    const head = q.get('head') ?? '';
    return (
      <ScreenFrame title={t.diff.compare({ base, head })} back={back} testId="dy-code-compare" width="wide">
        {/* p18-last-gaps: a compare view takes comments and "Değişiklik iste" too. */}
        <DiffReview
          target={{ kind: 'compare', project, base, head }}
          canReview={canReview}
          initialPath={q.get('path') ?? undefined}
        />
      </ScreenFrame>
    );
  }
  const job = q.get('job') ?? undefined;
  return (
    <ScreenFrame
      title={`${t.title} · ${project}`}
      back={back}
      purpose={t.purpose}
      testId="dy-code"
      width="wide"
    >
      <CodeBrowser
        key={`${project}:${external.current}`}
        project={project}
        initial={{
          ref: q.get('ref') ?? undefined,
          job,
          path: q.get('path') ?? undefined,
          lines: parseLineRange(q.get('L')),
        }}
        onNavigate={onNavigate}
      />
    </ScreenFrame>
  );
}
