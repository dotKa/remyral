import { type ReactNode, useEffect, useState } from 'react';
import { createProject, type EgressMode, type ProjectKind } from '../../../../api/directory';
import { getKnowledgeDefaults } from '../../../../api/search';
import { parseAllowHosts } from '../../../../api/workspaces';
import { usePrivileged } from '../../../../screens/privileged';
import { DyApiError, DyCheck, DyDialog, DyField, DyTextarea, FormGrid } from '../../forms';
import { DyButton, DySelect } from '../../parts';
import { EgressChoice, WebRisk } from './repo-sections';
import { useT } from '../../../../i18n/I18nProvider';

/**
 * p12-diyalog wave 2 (W3) — Projeler → "Yeni proje" in the Diyalog language: the classic `NewProjectForm` rules
 * (project id 1–128 of `[A-Za-z0-9_.:-]`, optional display name, repository or workspace, a workspace's network access
 * with the allow-list parsed by `parseAllowHosts`, project knowledge pre-checked from the platform defaults) and the
 * same `createProject` call through step-up (`usePrivileged`: a cancelled code dialog is not an error).
 */

const PROJECT_ID = /^[A-Za-z0-9_.:-]{1,128}$/;

function NewProjectForm(props: {
  readonly onCreated: (id: string, then?: { readonly newRepo: boolean }) => void;
  readonly onCancel: () => void;
}): ReactNode {
  const { submit, run } = usePrivileged();
  const t = useT().projectTabs.newProject;
  const [id, setId] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ProjectKind>('repository');
  const [egress, setEgress] = useState<EgressMode>('none');
  const [hosts, setHosts] = useState('');
  const [invalid, setInvalid] = useState<string | null>(null);
  const [hostsError, setHostsError] = useState<string | null>(null);
  const [capture, setCapture] = useState(true);
  const [memory, setMemory] = useState(true);
  // p15-github-create-repo: open a private GitHub repository for the new project right after it is saved.
  const [newRepo, setNewRepo] = useState(false);
  const tg = useT().githubRepos.wizard;
  useEffect(() => {
    let live = true;
    getKnowledgeDefaults().then(
      (d) => {
        if (!live) return;
        setCapture(d.projectCapture);
        setMemory(d.memoryMode !== 'off');
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, []);

  return (
    <form
      aria-label={t.form}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (!PROJECT_ID.test(id)) {
          setInvalid(t.badId);
          return;
        }
        setInvalid(null);
        const parsed = parseAllowHosts(hosts);
        if (kind === 'workspace' && egress === 'allowlist') {
          const why = parsed.error ?? (parsed.hosts.length === 0 ? t.noHosts : null);
          setHostsError(why);
          if (why !== null) return;
        } else {
          setHostsError(null);
        }
        run(async () => {
          await createProject(id, name.trim() === '' ? id : name.trim(), {
            ...(kind === 'workspace' ? { kind, egress, allowHosts: parsed.hosts } : {}),
            searchCapture: capture,
            memorySuggestions: memory,
          });
          props.onCreated(id, { newRepo: kind === 'repository' && newRepo });
        }, t.stepUp);
      }}
    >
      <FormGrid>
        <DyField
          label={t.id}
          value={id}
          error={invalid}
          autoComplete="off"
          spellCheck={false}
          mono
          hint={t.idHint}
          onChange={setId}
        />
        <DyField label={t.name} value={name} autoComplete="off" hint={t.nameHint} onChange={setName} />
      </FormGrid>
      <DySelect
        label={t.kind}
        value={kind}
        options={[
          ['repository', t.repository],
          ['workspace', t.workspace],
        ]}
        onChange={(v) => {
          setKind(v === 'workspace' ? 'workspace' : 'repository');
        }}
      />
      {kind === 'workspace' ? (
        <div className="flex flex-col gap-3">
          <EgressChoice name="new-project-egress" value={egress} onChange={setEgress} />
          {egress === 'allowlist' ? (
            <DyTextarea
              label={t.hosts}
              rows={4}
              mono
              value={hosts}
              spellCheck={false}
              placeholder={'api.example.com\ndocs.example.org:8443'} // i18n-ignore: example hosts
              hint={t.hostsHint}
              error={hostsError}
              onChange={setHosts}
            />
          ) : null}
          {egress === 'web' ? <WebRisk /> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="m-0 text-[0.8125rem] text-dy-muted">{t.afterSave}</p>
          <DyCheck
            label={tg.offer}
            hint={tg.offerHint}
            checked={newRepo}
            onChange={setNewRepo}
            testId="new-project-github-repo"
          />
        </div>
      )}
      <fieldset className="m-0 flex min-w-0 flex-col gap-1 border-0 p-0">
        <legend className="mb-1 p-0 text-[0.8125rem] font-bold">{t.knowledge}</legend>
        <DyCheck label={t.search} hint={t.searchHint} checked={capture} onChange={setCapture} />
        <DyCheck label={t.memory} hint={t.memoryHint} checked={memory} onChange={setMemory} />
        <p className="m-0 mt-1 text-[0.78125rem] text-dy-muted">{t.later}</p>
      </fieldset>
      <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <DyButton variant="ghost" onClick={props.onCancel}>
          {t.cancel}
        </DyButton>
        <DyButton type="submit" variant="primary" busy={submit.busy}>
          {t.save}
        </DyButton>
      </div>
    </form>
  );
}

export function NewProjectDialog(props: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onCreated: (id: string, then?: { readonly newRepo: boolean }) => void;
}): ReactNode {
  const t = useT().projectTabs.newProject;
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={t.title}
      description={t.description}
      testId="dy-new-project"
    >
      <NewProjectForm onCancel={props.onClose} onCreated={props.onCreated} />
    </DyDialog>
  );
}
