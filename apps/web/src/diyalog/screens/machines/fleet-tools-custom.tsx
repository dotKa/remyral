import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { ApiError } from '../../../api/client';
import {
  createCustomRecipe,
  type CustomRecipe,
  type CustomRecipeDoc,
  type CustomStep,
  deleteCustomRecipe,
  listCustomRecipes,
  PACKAGE_MANAGERS,
  type PackageManager,
  type RecipeLimits,
  TOOL_PLATFORMS,
  type ToolPlatform,
  updateCustomRecipe,
} from '../../../api/fleetTools';
import { toApiError } from '../../../components/ui';
import { useSubmit } from '../../../screens/useSubmit';
import {
  ConfirmButton,
  DyApiError,
  DyCheck,
  DyDetails,
  DyDialog,
  DyField,
  DyNotice,
  DyTextarea,
  FormActions,
  FormGrid,
} from '../forms';
import { DyButton, DySelect, EmptyLine, Panel, Pill, Row, Rows, SkeletonRows } from '../parts';
import { useGuarded } from './tabs/config-shared';
import type { Messages } from '@remyral/i18n';
import { useT } from '../../../i18n/I18nProvider';

type CustomText = Messages['fleetTools']['custom'];

/**
 * p13-fleet-tools — "Özel araçlar": admin-defined tool recipes. Per platform either a checksummed download (https
 * from an allowed host, sha256, size, zip / tgz / raw, the entry path) installed unprivileged into the worker's own
 * folder, or a package (winget / brew / apt / dnf / npm / pipx) installed by a machine-admin job where every elevated
 * command is approved. Client-side checks mirror the master's; its `recipe_invalid` issues are shown in Turkish.
 * Saving and deleting are machine administration (always-fresh step-up).
 */

// Platform names: the same in every language.
const PLATFORM_WORD: Readonly<Record<ToolPlatform, string>> = {
  'win32-x64': 'Windows x64', // i18n-ignore
  'linux-x64': 'Linux x64', // i18n-ignore
  'linux-arm64': 'Linux arm64', // i18n-ignore
  'darwin-x64': 'macOS Intel', // i18n-ignore
  'darwin-arm64': 'macOS Apple Silicon', // i18n-ignore
};

/** The package managers a platform's OS can use. */
export function managersFor(p: ToolPlatform): PackageManager[] {
  const os = p.split('-')[0];
  const native: PackageManager[] = os === 'win32' ? ['winget'] : os === 'darwin' ? ['brew'] : ['apt', 'dnf'];
  return PACKAGE_MANAGERS.filter((m) => native.includes(m) || m === 'npm' || m === 'pipx');
}

/** A `recipe_invalid` issue code in the user's language (unknown: the raw code). */
export function issueText(t: CustomText, code: string): string {
  return Object.hasOwn(t.issues, code) ? t.issues[code as keyof CustomText['issues']] : code;
}

type Mode = 'none' | 'download' | 'package';

interface PlatformForm {
  readonly mode: Mode;
  readonly url: string;
  readonly sha256: string;
  readonly size: string;
  readonly format: 'zip' | 'tgz' | 'raw';
  readonly strip: string;
  readonly entry: string;
  readonly manager: PackageManager;
  readonly pkg: string;
}

export interface RecipeForm {
  readonly name: string;
  readonly title: string;
  readonly version: string;
  readonly description: string;
  readonly pinPackageVersion: boolean;
  readonly binary: string;
  readonly args: string;
  readonly platforms: Readonly<Record<ToolPlatform, PlatformForm>>;
}

function emptyPlatform(p: ToolPlatform): PlatformForm {
  return {
    mode: 'none',
    url: '',
    sha256: '',
    size: '',
    format: 'zip',
    strip: '',
    entry: '',
    manager: managersFor(p)[0] ?? 'npm',
    pkg: '',
  };
}

function formOf(doc: CustomRecipeDoc | null): RecipeForm {
  const platforms = Object.fromEntries(
    TOOL_PLATFORMS.map((p) => {
      const s = doc?.platforms[p];
      const base = emptyPlatform(p);
      if (s === undefined) return [p, base];
      if (s.kind === 'download')
        return [
          p,
          {
            ...base,
            mode: 'download',
            url: s.url,
            sha256: s.sha256,
            size: String(s.size),
            format: s.format,
            strip: s.strip ?? '',
            entry: s.entry,
          },
        ];
      return [p, { ...base, mode: 'package', manager: s.manager, pkg: s.package }];
    }),
  ) as Record<ToolPlatform, PlatformForm>;
  return {
    name: doc?.name ?? '',
    title: doc?.title ?? '',
    version: doc?.version ?? '',
    description: doc?.description ?? '',
    pinPackageVersion: doc?.pinPackageVersion === true,
    binary: doc?.check.binary ?? '',
    args: doc?.check.args?.join(' ') ?? '--version',
    platforms,
  };
}

function hostOf(url: string): { https: boolean; host: string } | null {
  try {
    const u = new URL(url);
    return { https: u.protocol === 'https:', host: u.hostname.toLowerCase() };
  } catch {
    return null;
  }
}

/** Client-side checks (the master checks the same); keys are field paths. */
export function validateRecipe(f: RecipeForm, limits: RecipeLimits, t: CustomText): Record<string, string> {
  const e: Record<string, string> = {};
  const issue = (code: string): string => issueText(t, code);
  if (!/^[a-z][a-z0-9-]{1,31}$/.test(f.name)) e.name = t.nameBad;
  else if (limits.reservedNames.includes(f.name)) e.name = issue('reserved_name');
  if (f.title.trim() === '') e.title = t.titleMissing;
  if (f.version.trim() === '') e.version = t.versionMissing;
  const hosts = limits.hosts.map((h) => h.toLowerCase());
  let any = false;
  let anyPackage = false;
  for (const p of TOOL_PLATFORMS) {
    const s = f.platforms[p];
    const k = `platforms.${p}`;
    if (s.mode === 'none') continue;
    any = true;
    if (s.mode === 'download') {
      const h = hostOf(s.url);
      if (h === null || !h.https) e[`${k}.url`] = t.urlBad;
      else if (!hosts.includes(h.host))
        e[`${k}.url`] = t.hostBad({ host: h.host, why: issue('host_not_allowed') });
      if (!/^[0-9a-fA-F]{64}$/.test(s.sha256)) e[`${k}.sha256`] = t.shaBad;
      const size = Number(s.size);
      if (!Number.isInteger(size) || size <= 0) e[`${k}.size`] = t.sizeBad;
      if (s.entry.trim() === '') e[`${k}.entry`] = t.entryMissing;
      else if (p.startsWith('win32') && !/\.(exe|cmd|bat)$/i.test(s.entry))
        e[`${k}.entry`] = issue('windows_entry_not_executable');
      if (s.strip !== '' && s.format !== 'zip') e[`${k}.strip`] = issue('strip_zip_only');
    } else {
      anyPackage = true;
      if (!managersFor(p).includes(s.manager)) e[`${k}.manager`] = issue('manager_not_for_os');
      if (!/^[A-Za-z0-9@][A-Za-z0-9@._+/:-]{0,199}$/.test(s.pkg))
        e[`${k}.package`] = issue('package_id_invalid');
    }
  }
  if (!any) e.platforms = issue('no_platform');
  if (anyPackage && f.binary.trim() === '') e['check.binary'] = issue('binary_required');
  return e;
}

export function docOf(f: RecipeForm): CustomRecipeDoc {
  const platforms: Partial<Record<ToolPlatform, CustomStep>> = {};
  for (const p of TOOL_PLATFORMS) {
    const s = f.platforms[p];
    if (s.mode === 'download')
      platforms[p] = {
        kind: 'download',
        url: s.url.trim(),
        sha256: s.sha256.trim().toLowerCase(),
        size: Number(s.size),
        format: s.format,
        ...(s.format === 'zip' && s.strip.trim() !== '' ? { strip: s.strip.trim() } : {}),
        entry: s.entry.trim(),
      };
    else if (s.mode === 'package')
      platforms[p] = { kind: 'package', manager: s.manager, package: s.pkg.trim() };
  }
  const args = f.args.trim() === '' ? ['--version'] : f.args.trim().split(/\s+/);
  return {
    name: f.name,
    title: f.title.trim(),
    version: f.version.trim(),
    ...(f.description.trim() === '' ? {} : { description: f.description.trim() }),
    pinPackageVersion: f.pinPackageVersion,
    platforms,
    check: { ...(f.binary.trim() === '' ? {} : { binary: f.binary.trim() }), args },
  };
}

function PlatformFields(props: {
  readonly platform: ToolPlatform;
  readonly value: PlatformForm;
  readonly errors: Record<string, string>;
  readonly onChange: (v: PlatformForm) => void;
}): ReactNode {
  const { platform: p, value: v, errors } = props;
  const t = useT().fleetTools.custom;
  const k = `platforms.${p}`;
  const set = (patch: Partial<PlatformForm>): void => {
    props.onChange({ ...v, ...patch });
  };
  return (
    <div
      className="grid gap-3 rounded-[10px] border border-dy-line px-3.5 py-3"
      data-testid={`platform-${p}`}
    >
      <DySelect
        label={PLATFORM_WORD[p]}
        value={v.mode}
        options={[
          ['none', t.modes.none],
          ['download', t.modes.download],
          ['package', t.modes.package],
        ]}
        onChange={(m) => {
          set({ mode: m as Mode });
        }}
      />
      {v.mode === 'download' ? (
        <FormGrid>
          <DyField
            label={t.url}
            mono
            value={v.url}
            onChange={(x) => {
              set({ url: x });
            }}
            error={errors[`${k}.url`]}
            wrapClassName="sm:col-span-2"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
          />
          <DyField
            label="sha256"
            mono
            value={v.sha256}
            onChange={(x) => {
              set({ sha256: x });
            }}
            error={errors[`${k}.sha256`]}
            wrapClassName="sm:col-span-2"
            autoComplete="off"
            spellCheck={false}
          />
          <DyField
            label={t.size}
            inputMode="numeric"
            value={v.size}
            onChange={(x) => {
              set({ size: x });
            }}
            error={errors[`${k}.size`]}
          />
          <DySelect
            label={t.format}
            value={v.format}
            options={[
              ['zip', 'zip'],
              ['tgz', 'tgz'],
              ['raw', t.raw],
            ]}
            onChange={(x) => {
              set({ format: x as PlatformForm['format'] });
            }}
          />
          {v.format === 'zip' ? (
            <DyField
              label={t.strip}
              mono
              value={v.strip}
              onChange={(x) => {
                set({ strip: x });
              }}
              error={errors[`${k}.strip`]}
            />
          ) : null}
          <DyField
            label={t.entry}
            mono
            value={v.entry}
            onChange={(x) => {
              set({ entry: x });
            }}
            hint={t.entryHint({ example: p.startsWith('win32') ? 'bin/tool.exe' : 'bin/tool' })}
            error={errors[`${k}.entry`]}
          />
        </FormGrid>
      ) : v.mode === 'package' ? (
        <FormGrid>
          <DySelect
            label={t.manager}
            value={v.manager}
            options={managersFor(p).map((m) => [m, m] as const)}
            onChange={(x) => {
              set({ manager: x as PackageManager });
            }}
          />
          <DyField
            label={t.packageId}
            mono
            value={v.pkg}
            onChange={(x) => {
              set({ pkg: x });
            }}
            error={errors[`${k}.package`] ?? errors[`${k}.manager`]}
            autoComplete="off"
            spellCheck={false}
          />
        </FormGrid>
      ) : null}
    </div>
  );
}

function RecipeDialog(props: {
  readonly open: boolean;
  readonly editing: CustomRecipe | null;
  readonly limits: RecipeLimits;
  readonly onClose: () => void;
  readonly onSaved: (r: CustomRecipe) => void;
}): ReactNode {
  const t = useT().fleetTools.custom;
  const [form, setForm] = useState<RecipeForm>(() => formOf(props.editing?.recipe ?? null));
  const [tried, setTried] = useState(false);
  const submit = useSubmit();
  const guarded = useGuarded();
  const errors = tried ? validateRecipe(form, props.limits, t) : {};
  const serverIssues =
    submit.error instanceof ApiError && submit.error.code === 'recipe_invalid' ? submit.error.issues : [];
  const set = (patch: Partial<RecipeForm>): void => {
    setForm((f) => ({ ...f, ...patch }));
  };
  const save = (): void => {
    setTried(true);
    if (Object.keys(validateRecipe(form, props.limits, t)).length > 0) return;
    const doc = docOf(form);
    const editing = props.editing;
    void submit.run(async () => {
      const saved = await guarded(
        () => (editing === null ? createCustomRecipe(doc) : updateCustomRecipe(editing.id, doc)),
        t.saveWhy({ title: doc.title }),
      );
      if (saved !== null) props.onSaved(saved);
    });
  };
  return (
    <DyDialog
      open={props.open}
      onClose={props.onClose}
      title={props.editing === null ? t.newTitle : t.editTitle({ title: props.editing.recipe.title })}
      size="lg"
      backdropClose={false}
      testId="recipe-dialog"
      footer={
        <FormActions>
          <DyButton variant="primary" busy={submit.busy} onClick={save}>
            {t.save}
          </DyButton>
          <DyButton variant="ghost" onClick={props.onClose}>
            {t.cancel}
          </DyButton>
        </FormActions>
      }
    >
      <div className="grid gap-4">
        <FormGrid>
          <DyField
            label={t.name}
            mono
            value={form.name}
            disabled={props.editing !== null}
            onChange={(x) => {
              set({ name: x });
            }}
            hint={t.nameHint}
            error={errors.name}
            autoComplete="off"
            spellCheck={false}
          />
          <DyField
            label={t.title}
            value={form.title}
            onChange={(x) => {
              set({ title: x });
            }}
            error={errors.title}
          />
          <DyField
            label={t.version}
            mono
            value={form.version}
            onChange={(x) => {
              set({ version: x });
            }}
            error={errors.version}
          />
          <DyCheck
            label={t.pinPackage}
            checked={form.pinPackageVersion}
            onChange={(x) => {
              set({ pinPackageVersion: x });
            }}
            hint={t.pinPackageHint}
          />
        </FormGrid>
        <DyTextarea
          label={t.description}
          rows={2}
          value={form.description}
          onChange={(x) => {
            set({ description: x });
          }}
        />
        <div className="grid gap-2">
          <p className="m-0 text-[0.8125rem] font-bold">{t.platforms}</p>
          <p className="m-0 text-[0.78125rem] text-dy-muted" data-testid="recipe-hosts">
            {t.hosts}{' '}
            {props.limits.hosts.length === 0 ? (
              t.noHosts
            ) : (
              <span className="font-dy-mono">{props.limits.hosts.join(', ')}</span>
            )}
          </p>
          {errors.platforms === undefined ? null : (
            <p className="m-0 text-[0.78125rem] font-medium text-dy-red-ink">{errors.platforms}</p>
          )}
          {TOOL_PLATFORMS.map((p) => (
            <PlatformFields
              key={p}
              platform={p}
              value={form.platforms[p]}
              errors={errors}
              onChange={(v) => {
                set({ platforms: { ...form.platforms, [p]: v } });
              }}
            />
          ))}
        </div>
        <FormGrid>
          <DyField
            label={t.checkBinary}
            mono
            value={form.binary}
            onChange={(x) => {
              set({ binary: x });
            }}
            hint={t.checkBinaryHint}
            error={errors['check.binary']}
          />
          <DyField
            label={t.args}
            mono
            value={form.args}
            onChange={(x) => {
              set({ args: x });
            }}
            hint={t.argsHint}
          />
        </FormGrid>
        {serverIssues.length > 0 ? (
          <DyNotice tone="red" title={t.refused} testId="recipe-issues">
            <ul className="m-0 list-none p-0">
              {serverIssues.map((i) => (
                <li key={`${i.path}-${i.code}`}>
                  <span className="font-dy-mono">{i.path}</span>: {issueText(t, i.code)}
                </li>
              ))}
            </ul>
          </DyNotice>
        ) : (
          <DyApiError error={submit.error} retryLeft={submit.retryLeft} />
        )}
      </div>
    </DyDialog>
  );
}

function stepsText(r: CustomRecipeDoc, t: CustomText): string {
  return TOOL_PLATFORMS.filter((p) => r.platforms[p] !== undefined)
    .map((p) => {
      const s = r.platforms[p];
      return `${PLATFORM_WORD[p]} (${s?.kind === 'package' ? s.manager : t.download})`;
    })
    .join(' · ');
}

export function CustomToolsPanel(props: {
  readonly isAdmin: boolean;
  readonly onChanged: () => void;
}): ReactNode {
  const t = useT().fleetTools.custom;
  const [data, setData] = useState<{ recipes: CustomRecipe[]; limits: RecipeLimits } | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [editing, setEditing] = useState<CustomRecipe | null | 'new'>(null);
  const del = useSubmit();
  const guarded = useGuarded();
  const load = useCallback(async () => {
    try {
      const d = await listCustomRecipes();
      const l = d.limits as Partial<RecipeLimits>;
      setData({
        recipes: d.recipes,
        limits: {
          hosts: Array.isArray(l.hosts) ? l.hosts : [],
          reservedNames: Array.isArray(l.reservedNames) ? l.reservedNames : [],
        },
      });
      setError(null);
    } catch (err) {
      setError(toApiError(err));
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const onChanged = props.onChanged;
  return (
    <Panel
      title={t.panelTitle}
      count={data === null ? undefined : String(data.recipes.length)}
      countLabel={data === null ? undefined : t.count({ n: data.recipes.length })}
      sub={t.sub}
      aside={
        props.isAdmin && data !== null ? (
          <DyButton
            icon="plus"
            onClick={() => {
              setEditing('new');
            }}
          >
            {t.add}
          </DyButton>
        ) : undefined
      }
      flush
      testId="custom-tools"
    >
      <div className="px-4 pb-3">
        <DyDetails summary={t.securityTitle}>
          <p className="m-0 text-[0.84375rem]">{t.security}</p>
        </DyDetails>
      </div>
      <DyApiError error={error ?? del.error} retryLeft={del.retryLeft} />
      {data === null ? (
        error === null ? (
          <SkeletonRows label={t.loading} rows={2} />
        ) : null
      ) : data.recipes.length === 0 ? (
        <EmptyLine>{t.empty}</EmptyLine>
      ) : (
        <Rows label={t.panelTitle}>
          {data.recipes.map((r) => (
            <Row
              key={r.id}
              testId="custom-recipe"
              title={
                <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                  {r.recipe.title}
                  <span className="font-dy-mono text-[0.8125rem] font-normal text-dy-muted">
                    {r.recipe.name} {r.recipe.version}
                  </span>
                  <Pill tone="violet">{t.custom}</Pill>
                </span>
              }
              meta={
                <>
                  <span>{stepsText(r.recipe, t)}</span>
                  {r.recipe.description === undefined ? null : <span>{r.recipe.description}</span>}
                </>
              }
              actions={
                props.isAdmin ? (
                  <>
                    <DyButton
                      onClick={() => {
                        setEditing(r);
                      }}
                    >
                      {t.edit}
                    </DyButton>
                    <ConfirmButton
                      label={t.delete}
                      question={t.deleteQuestion({ title: r.recipe.title })}
                      confirmLabel={t.deleteConfirm}
                      busy={del.busy}
                      ariaLabel={t.deleteLabel({ title: r.recipe.title })}
                      onConfirm={() => {
                        void del.run(async () => {
                          const ok = await guarded(
                            async () => {
                              await deleteCustomRecipe(r.id);
                              return true;
                            },
                            t.deleteWhy({ title: r.recipe.title }),
                          );
                          if (ok !== null) {
                            await load();
                            onChanged();
                          }
                        });
                      }}
                    />
                  </>
                ) : undefined
              }
            />
          ))}
        </Rows>
      )}
      {editing !== null && data !== null ? (
        <RecipeDialog
          open
          editing={editing === 'new' ? null : editing}
          limits={data.limits}
          onClose={() => {
            setEditing(null);
          }}
          onSaved={() => {
            setEditing(null);
            void load();
            onChanged();
          }}
        />
      ) : null}
    </Panel>
  );
}
