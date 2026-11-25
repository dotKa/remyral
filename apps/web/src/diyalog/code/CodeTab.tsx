import type { ReactNode } from 'react';
import { CodeBrowser } from './CodeBrowser';
import { IdePanel } from './IdePanel';

/**
 * p19-ide W1: Projeler → proje → "Kod" (lazy chunk); the full screen is `/projects/:id/code`. W2: "Tam IDE" above the
 * viewer for the project's operators.
 */
export function CodeTab(props: { readonly project: string }): ReactNode {
  return (
    <div className="grid gap-3">
      <IdePanel project={props.project} />
      <CodeBrowser project={props.project} initial={{}} fullScreenLink />
    </div>
  );
}
