import { type ReactNode, useCallback, useEffect, useState } from 'react';
import type { ApiError } from '../../../../api/client';
import { listProjects, type Project } from '../../../../api/directory';
import {
  listWorkflowTemplates,
  type TemplateCategory,
  type TemplateList,
  type WorkflowTemplate,
} from '../../../../api/workflowTemplates';
import { toApiError } from '../../../../components/ui';
import { useT } from '../../../../i18n/I18nProvider';
import { DyNotice } from '../../kit';
import { DyButtonLink, EmptyLine, ErrorLine, Panel, Pill, SkeletonRows } from '../../parts';
import { ScreenFrame } from '../../ScreenFrame';
import { canDefine } from '../WorkflowsScreen';
import { TemplateGraph } from './TemplateGraph';
import { categoryText, PRIVILEGED_ACTIONS, templateFeatures, templateText } from './templateText';

/**
 * p14-workflow-engine 14.5 (docs/design/p14-workflow-engine.md §20): `/workflows/templates` — the ready-made templates
 * by category (Pazarlama · İçerik üretimi · Video üretimi): name, description, a static graph preview, node count,
 * what runs on a machine (HTTP / e-mail / code) and whether creating one needs a project admin with a TOTP code
 * (network / code nodes are privileged, §8.5). "Oluştur" opens the wizard.
 */

const ORDER: readonly TemplateCategory[] = ['marketing', 'content', 'video'];

export function TemplateCard(props: {
  readonly template: WorkflowTemplate;
  readonly canCreate: boolean;
}): ReactNode {
  const t = useT();
  const g = t.workflowGallery;
  const tpl = props.template;
  const text = templateText(t, tpl.id);
  const f = templateFeatures(tpl.nodes.map((n) => n.type));
  const machine = f.http || f.email || f.code;
  const admin = tpl.requires.some((a) => (PRIVILEGED_ACTIONS as readonly string[]).includes(a));
  return (
    <article
      className="grid min-w-0 gap-3 rounded-[12px] border border-dy-line bg-dy-card p-4"
      data-testid="template-card"
      data-template={tpl.id}
    >
      <div className="grid gap-1">
        <h3 className="m-0 text-[0.9375rem] font-bold">{text.name}</h3>
        {text.description === '' ? null : (
          <p className="m-0 text-[0.875rem] text-dy-muted">{text.description}</p>
        )}
      </div>
      <TemplateGraph template={tpl} />
      <div className="flex flex-wrap items-center gap-1.5">
        <Pill tone="neutral">{g.nodes({ n: tpl.nodes.length })}</Pill>
        {f.ai ? <Pill tone="violet">{g.features.ai}</Pill> : null}
        {f.approval ? <Pill tone="amber">{g.features.approval}</Pill> : null}
        {machine ? (
          <Pill tone="teal" icon="cpu">
            {`${g.runsOnMachine}: ${[
              f.http ? g.features.http : null,
              f.email ? g.features.email : null,
              f.code ? g.features.code : null,
            ]
              .filter((x) => x !== null)
              .join(' · ')}`}
          </Pill>
        ) : null}
      </div>
      {admin ? (
        <p className="m-0 text-[0.8125rem] text-dy-amber-ink" data-testid="template-needs-admin">
          {g.needsAdmin}
        </p>
      ) : null}
      {props.canCreate ? (
        <div>
          <DyButtonLink
            to={`/workflows/templates/${encodeURIComponent(tpl.id)}`}
            variant="primary"
            icon="plus"
            aria-label={g.createAria({ name: text.name })}
          >
            {g.create}
          </DyButtonLink>
        </div>
      ) : null}
    </article>
  );
}

export function TemplateGallery(): ReactNode {
  const t = useT();
  const g = t.workflowGallery;
  const [list, setList] = useState<TemplateList | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [projects, setProjects] = useState<readonly Project[] | null>(null);

  const load = useCallback(() => {
    setError(null);
    listWorkflowTemplates().then(setList, (err: unknown) => {
      setError(toApiError(err));
    });
  }, []);
  useEffect(() => {
    load();
    listProjects().then(setProjects, () => {
      setProjects([]);
    });
  }, [load]);

  const anyDefine = (projects ?? []).some((p) => canDefine(projects, p.id));
  const canCreate = anyDefine && list?.engineV2 === true;
  return (
    <ScreenFrame
      title={g.title}
      purpose={g.purpose}
      back={{ to: '/workflows', label: g.back }}
      testId="dy-workflow-templates"
    >
      <ErrorLine error={error} what={g.what} onRetry={load} />
      {list === null ? (
        error === null ? (
          <SkeletonRows label={g.loading} rows={4} />
        ) : null
      ) : (
        <div className="grid gap-4">
          {list.engineV2 ? null : (
            <DyNotice tone="amber" testId="templates-engine-off">
              {g.engineOff}
            </DyNotice>
          )}
          {projects !== null && !anyDefine ? (
            <DyNotice tone="neutral" testId="templates-no-define">
              {g.noDefine}
            </DyNotice>
          ) : null}
          {list.templates.length === 0 ? <EmptyLine>{g.none}</EmptyLine> : null}
          {ORDER.map((c) => {
            const items = list.templates.filter((x) => x.category === c);
            if (items.length === 0) return null;
            return (
              <Panel
                key={c}
                title={categoryText(t, c)}
                count={String(items.length)}
                testId={`template-category-${c}`}
              >
                <div className="grid gap-3 px-4 pt-2 pb-4 lg:grid-cols-2">
                  {items.map((x) => (
                    <TemplateCard key={x.id} template={x} canCreate={canCreate} />
                  ))}
                </div>
              </Panel>
            );
          })}
        </div>
      )}
    </ScreenFrame>
  );
}
