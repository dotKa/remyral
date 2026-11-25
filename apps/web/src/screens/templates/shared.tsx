import { useEffect, useState } from 'react';
import type { ComposerPrefill, PrefillState } from '../composer/prefill';
import { listProjects, type Project } from '../../api/directory';
import type { Rendered, Template, TemplateParameter } from '../../api/templates';

/** Projects the viewer may run jobs in (operator+). */
export function useRunnableProjects(): Project[] | null {
  const [projects, setProjects] = useState<Project[] | null>(null);
  useEffect(() => {
    listProjects().then(
      (p) => {
        setProjects(p.filter((x) => x.myRole !== 'viewer'));
      },
      () => {
        setProjects([]);
      },
    );
  }, []);
  return projects;
}

export type Values = Record<string, string | boolean>;

export function initialValues(params: readonly TemplateParameter[]): Values {
  const v: Values = {};
  for (const p of params) {
    if (p.type === 'bool') v[p.name] = p.default === true;
    else v[p.name] = p.default === undefined ? '' : String(p.default);
  }
  return v;
}

/** Form values → request values (empty fields left out so defaults / "required" apply on the server). */
export function toRequest(
  params: readonly TemplateParameter[],
  values: Values,
): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (const p of params) {
    const v = values[p.name];
    if (v === undefined) continue;
    if (typeof v === 'boolean') out[p.name] = v;
    else if (v.trim() !== '') out[p.name] = v;
  }
  return out;
}

/** Router state that opens the composer filled from a rendered template (attributed to that version). */
export function composerState(t: Template, r: Rendered): PrefillState {
  const d = r.defaults;
  const prefill: ComposerPrefill = {
    project: r.project,
    spec: {
      runtime: d.runtime,
      ...(d.modelProfile === undefined ? {} : { model: d.modelProfile }),
      prompt: r.prompt,
      ...(d.sandboxProfile === undefined ? {} : { sandboxProfile: d.sandboxProfile }),
      ...(d.approvalPolicy === undefined ? {} : { approvalPolicy: d.approvalPolicy }),
      ...(d.limits === undefined ? {} : { limits: d.limits }),
      ...(d.baseRef === undefined ? {} : { repository: { baseRef: d.baseRef } }),
    },
    template: { id: t.id, version: r.version, title: t.title },
    ...(d.deployOnSuccess === undefined ? {} : { deployOnSuccess: d.deployOnSuccess }),
    ...(d.verify === undefined ? {} : { verify: d.verify }),
  };
  return { prefill };
}
