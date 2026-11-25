import type { ReactNode } from 'react';
import type { Project } from '../../api/directory';
import { DyCheck } from '../screens/kit';

/**
 * p18-multi-project W4: a set of projects to pick (checkbox per project) — "Başka projelerde de oluştur" in the
 * automation form, "Seçili projeler" of a template's sharing, "Başka projelere de ekle" of a workflow template. The
 * caller passes the texts (from the catalog) and the candidate projects.
 */
export function ProjectChecks(props: {
  readonly legend: string;
  readonly hint?: string | undefined;
  readonly empty: string;
  readonly projects: readonly Project[];
  readonly chosen: readonly string[];
  readonly onChange: (next: string[]) => void;
  readonly max?: number | undefined;
  readonly testId?: string | undefined;
  readonly disabled?: boolean | undefined;
}): ReactNode {
  const { chosen, max } = props;
  return (
    <fieldset className="m-0 grid min-w-0 gap-2 border-0 p-0" data-testid={props.testId}>
      <legend className="mb-1 p-0 text-[0.875rem] font-bold">{props.legend}</legend>
      {props.hint === undefined ? null : <p className="m-0 text-[0.8125rem] text-dy-muted">{props.hint}</p>}
      {props.projects.length === 0 ? (
        <p className="m-0 text-[0.8125rem] text-dy-muted">{props.empty}</p>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-2">
          {props.projects.map((p) => {
            const on = chosen.includes(p.id);
            return (
              <DyCheck
                key={p.id}
                label={p.name === p.id ? p.id : `${p.name} (${p.id})`}
                checked={on}
                disabled={props.disabled === true || (!on && max !== undefined && chosen.length >= max)}
                onChange={(v) => {
                  props.onChange(v ? [...chosen, p.id] : chosen.filter((x) => x !== p.id));
                }}
              />
            );
          })}
        </div>
      )}
    </fieldset>
  );
}
