import { useErrorText } from '../../../i18n/errors';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router';
import type { ApiError } from '../../../api/client';
import {
  type Candidate,
  createTemplate,
  getTemplate,
  PARAM_TYPES,
  type ParamType,
  type PreviewResult,
  previewTemplate,
  proposalFromDraft,
  proposalFromJob,
  type TemplateParameter,
  updateTemplate,
} from '../../../api/templates';
import { useAuth } from '../../../auth/AuthProvider';
import { toApiError } from '../../../components/ui';
import { runtimeName } from '../../../lib/reasons';
import { toRequest, useRunnableProjects, type Values } from '../../../screens/templates/shared';
import {
  applyCandidate,
  APPROVALS,
  defaultsOf,
  EMPTY,
  type Form,
  formFromDefaults,
  type Meta,
  metaOf,
  RUNTIMES,
  SANDBOXES,
} from '../../../screens/templates/form';
import { isSuggestionPrefill } from '../../../screens/templates/suggestions';
import { APPROVAL_TR, SANDBOX_TR, VERIFY_TR } from '../../compose/labels';
import { DyButton, ErrorLine, Panel, SkeletonRows } from '../parts';
import { ScreenFrame } from '../ScreenFrame';
import { MODEL_RUNTIMES, type ModelRuntime } from '../../../api/models';
import { useT } from '../../../i18n/I18nProvider';
import { DyModelPicker, useRuntimeModels } from '../shared/ModelPicker';
import { AreaField, CheckField, ClassPicker, Field, PARAM_TYPE_TR, ParamFields, SelectField } from './parts';

/**
 * p12-diyalog-w1: `/jobs/templates/new` and `/jobs/templates/:id/edit` in the Diyalog language — the prompt with
 * `{{yer tutucular}}`, the parameter table (type, label, default, required, options, description), the run settings
 * and a live preview the server renders exactly as a run would. Prefilled from a job (`?fromJob=`), a chat draft
 * (`?fromDraft=`) or a suggestion (router state). The state rules are the classic editor's (its pure helpers).
 */

export function TemplateForm(props: { readonly id?: string | undefined }): ReactNode {
  const sayError = useErrorText();
  const { id } = props;
  const editing = id !== undefined;
  const [params] = useSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const { state: auth } = useAuth();
  const isAdmin = auth.kind === 'signedIn' && (auth.user.role === 'owner' || auth.user.role === 'admin');
  const projects = useRunnableProjects();
  const [form, setForm] = useState<Form>(EMPTY);
  const [meta, setMeta] = useState<Meta>({});
  const [source, setSource] = useState<Record<string, unknown> | undefined>(undefined);
  const [version, setVersion] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<ApiError | null>(null);
  const mp = useT().modelPicker;
  const catalog = useRuntimeModels(form.project === '' ? undefined : form.project);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [sample, setSample] = useState<Values>({});
  const [candidates, setCandidates] = useState<readonly Candidate[]>([]);
  const fromJob = params.get('fromJob');
  const fromDraft = params.get('fromDraft');
  const suggestion = isSuggestionPrefill(location.state) ? location.state.suggestion : null;
  const loadedOnce = useRef(false);

  useEffect(() => {
    if (loadedOnce.current) return;
    loadedOnce.current = true;
    const set = (p: Partial<Form>): void => {
      setForm((f) => ({ ...f, ...p }));
    };
    const done = (): void => {
      setLoading(false);
    };
    const fail = (err: unknown): void => {
      setLoadError(toApiError(err));
      done();
    };
    if (editing) {
      getTemplate(id).then((t) => {
        set({
          project: t.project ?? '',
          title: t.title,
          description: t.description,
          tags: t.tags.join(', '),
          prompt: t.current.prompt,
          ...formFromDefaults(t.current.defaults),
        });
        setMeta(metaOf(t.current.parameters));
        setVersion(t.version);
        done();
      }, fail);
      return;
    }
    if (suggestion !== null) {
      set({
        project: suggestion.project,
        title: suggestion.title,
        prompt: suggestion.prompt,
        runtime: suggestion.defaults.runtime ?? 'claude-code',
        modelProfile: suggestion.defaults.modelProfile ?? '',
        sandboxProfile: suggestion.defaults.sandboxProfile ?? '',
        approvalPolicy: suggestion.defaults.approvalPolicy ?? '',
      });
      setMeta(metaOf(suggestion.parameters));
      setSource({
        kind: 'suggestion',
        id: suggestion.id,
        members: suggestion.members.map((m) => `${m.kind}:${m.id}`),
      });
      done();
      return;
    }
    const proposal = fromJob ? proposalFromJob(fromJob) : fromDraft ? proposalFromDraft(fromDraft) : null;
    if (proposal === null) {
      done();
      return;
    }
    proposal.then((p) => {
      set({ project: p.project, title: p.title, prompt: p.prompt, ...formFromDefaults(p.defaults) });
      setCandidates(p.candidates);
      setSource(p.source);
      done();
    }, fail);
  }, [editing, id, fromJob, fromDraft, suggestion]);

  const declared = useMemo(
    () => Object.entries(meta).map(([name, m]) => ({ ...m, name, type: m.type ?? 'string' })),
    [meta],
  );

  // Live preview (debounced): the server merges the placeholders with the definitions and renders the prompt.
  useEffect(() => {
    if (form.prompt.trim() === '') {
      setPreview(null);
      return;
    }
    const ctl = new AbortController();
    const t = setTimeout(() => {
      previewTemplate(
        {
          prompt: form.prompt,
          parameters: declared.filter((d) => d.type === 'file' || form.prompt.includes(`{{${d.name}`)),
          values: toRequest(declared, sample),
          title: form.title || 'Template',
        },
        { signal: ctl.signal },
      ).then(
        (r) => {
          setPreview(r);
          if (r.candidates.length > 0 && candidates.length === 0) setCandidates(r.candidates);
        },
        () => undefined,
      );
    }, 350);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [form.prompt, form.title, declared, sample, candidates.length]);

  const merged = preview?.parameters ?? [];
  const setParam = (name: string, p: Partial<TemplateParameter>): void => {
    const base = merged.find((x) => x.name === name);
    setMeta((m) => ({ ...m, [name]: { ...(base ?? {}), ...(m[name] ?? {}), ...p } }));
  };
  const set = (p: Partial<Form>): void => {
    setForm((f) => ({ ...f, ...p }));
  };

  const save = async (): Promise<void> => {
    setSaving(true);
    setSaveError(null);
    const body = {
      title: form.title.trim(),
      description: form.description.trim(),
      tags: form.tags
        .split(',')
        .map((t) => t.trim())
        .filter((t) => t !== ''),
      prompt: form.prompt,
      parameters: merged.map((p) => {
        const { examples: _e, ...rest } = p;
        return rest;
      }),
      defaults: defaultsOf(form),
      ...(form.changeNote.trim() === '' ? {} : { changeNote: form.changeNote.trim() }),
    };
    try {
      const t =
        editing && version !== null
          ? await updateTemplate(id, { ...body, expectedVersion: version })
          : await createTemplate({
              ...body,
              project: form.project === '' ? null : form.project,
              ...(source === undefined ? {} : { source }),
            });
      void navigate(`/jobs/templates/${encodeURIComponent(t.id)}`);
    } catch (err) {
      setSaveError(toApiError(err));
    } finally {
      setSaving(false);
    }
  };

  const title = editing ? 'Şablonu düzenle' : 'Yeni şablon';
  const back = editing
    ? { to: `/jobs/templates/${encodeURIComponent(id)}`, label: 'Şablon' }
    : { to: '/jobs/templates', label: 'Şablonlar' };
  const purpose =
    'İşi bir kez {{yer tutucularla}} yaz; parametreler çalıştırırken doldurulur ve alıntılanmış veri olarak eklenir — aşağıdaki ayarları asla değiştiremezler.';

  if (loading)
    return (
      <ScreenFrame title={title} back={back} purpose={purpose} testId="dy-template-form">
        <SkeletonRows label="Yükleniyor" />
      </ScreenFrame>
    );

  const scopeOptions: (readonly [string, string])[] = [
    ...(isAdmin || form.project === '' ? [['', 'Genel (her proje — yöneticiler)'] as const] : []),
    ...(projects ?? []).map((p) => [p.id, p.name] as const),
    ...(form.project !== '' && projects !== null && !projects.some((p) => p.id === form.project)
      ? [[form.project, form.project] as const]
      : []),
  ];
  const missing = [
    form.title.trim() === '' ? 'başlık' : null,
    form.prompt.trim() === '' ? 'istem' : null,
  ].filter((x): x is string => x !== null);

  return (
    <ScreenFrame title={title} back={back} purpose={purpose} testId="dy-template-form">
      <ErrorLine error={loadError} what="Şablon" />
      <form
        className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(320px,400px)] lg:items-start"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <div className="grid min-w-0 gap-4">
          <Panel title="Şablon">
            <div className="grid gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <SelectField
                  label="Kapsam"
                  value={form.project}
                  disabled={editing}
                  testId="template-project"
                  options={scopeOptions}
                  onChange={(v) => {
                    set({ project: v });
                  }}
                  hint={editing ? 'Kapsam kaydedildikten sonra değişmez.' : undefined}
                />
                <Field
                  label="Başlık"
                  value={form.title}
                  maxLength={200}
                  required
                  onChange={(e) => {
                    set({ title: e.target.value });
                  }}
                />
              </div>
              <Field
                label="Açıklama"
                value={form.description}
                maxLength={4000}
                onChange={(e) => {
                  set({ description: e.target.value });
                }}
              />
              <Field
                label="Etiketler"
                hint="Virgülle ayır"
                value={form.tags}
                onChange={(e) => {
                  set({ tags: e.target.value });
                }}
              />
              <AreaField
                label="İstem"
                rows={10}
                value={form.prompt}
                maxLength={64 * 1024}
                required
                data-testid="template-prompt"
                onChange={(e) => {
                  set({ prompt: e.target.value });
                }}
                hint={
                  <>
                    <span className="font-dy-mono">
                      {'{{url}}'}, {'{{audience_count:int}}'}, {'{{tone:enum(formal|casual)}}'},{' '}
                      {'{{brief:text}}'}
                    </span>
                    . Türler: string, text, int, number, url, bool, enum, file.
                  </>
                }
              />
              {candidates.length > 0 ? (
                <div className="flex flex-wrap items-center gap-2" data-testid="candidates">
                  <span className="text-[0.8125rem] text-dy-muted">Parametre yap:</span>
                  {candidates.map((c) => (
                    <DyButton
                      key={c.text}
                      className="min-h-8 px-2 text-[0.8125rem]"
                      disabled={!form.prompt.includes(c.text)}
                      onClick={() => {
                        set({ prompt: applyCandidate(form.prompt, c) });
                        setMeta((m) => ({ ...m, [c.name]: { name: c.name, type: c.type } }));
                      }}
                    >
                      <span className="max-w-[16rem] truncate">
                        {c.text.length > 40 ? `${c.text.slice(0, 39)}…` : c.text}
                      </span>
                      <span className="font-dy-mono">{`→ {{${c.name}}}`}</span>
                    </DyButton>
                  ))}
                </div>
              ) : null}
            </div>
          </Panel>

          <Panel
            title="Parametreler"
            count={merged.length === 0 ? undefined : String(merged.length)}
            countLabel={`${String(merged.length)} parametre`}
          >
            {merged.length === 0 ? (
              <p className="m-0 text-[0.875rem] text-dy-muted">
                Parametre için isteme {'{{yer tutucu}}'} ekle.
              </p>
            ) : (
              <div className="grid gap-3" data-testid="param-table">
                {merged.map((p) => (
                  <fieldset
                    key={p.name}
                    className="m-0 grid min-w-0 gap-2.5 rounded-[12px] border border-dy-line bg-dy-sunk/50 p-3 sm:grid-cols-3"
                  >
                    <legend className="px-1 font-dy-mono text-[0.84375rem] font-medium">{`{{${p.name}}}`}</legend>
                    <SelectField
                      label="Tür"
                      value={p.type}
                      options={PARAM_TYPES.map((t) => [t, PARAM_TYPE_TR[t]] as const)}
                      onChange={(v) => {
                        setParam(p.name, { type: v as ParamType });
                      }}
                    />
                    <Field
                      label="Etiket"
                      value={p.label ?? ''}
                      maxLength={100}
                      onChange={(e) => {
                        setParam(p.name, { label: e.target.value });
                      }}
                    />
                    <Field
                      label="Varsayılan"
                      value={p.default === undefined ? '' : String(p.default)}
                      onChange={(e) => {
                        const v = e.target.value;
                        const { default: _d, ...rest } = meta[p.name] ?? p;
                        if (v === '') setMeta((m) => ({ ...m, [p.name]: { ...rest } }));
                        else
                          setParam(p.name, {
                            default: p.type === 'int' || p.type === 'number' ? Number(v) : v,
                          });
                      }}
                    />
                    <CheckField
                      label="Zorunlu"
                      checked={p.required !== false}
                      onChange={(c) => {
                        setParam(p.name, { required: c });
                      }}
                      className="sm:col-span-3"
                    />
                    {p.type === 'enum' ? (
                      <Field
                        label="Seçenekler (| ile ayır)"
                        wrapClass="sm:col-span-3"
                        mono
                        value={(p.options ?? []).join('|')}
                        onChange={(e) => {
                          setParam(p.name, {
                            options: e.target.value
                              .split('|')
                              .map((o) => o.trim())
                              .filter((o) => o !== ''),
                          });
                        }}
                      />
                    ) : null}
                    <Field
                      label="Açıklama"
                      wrapClass="sm:col-span-3"
                      value={p.description ?? ''}
                      maxLength={500}
                      onChange={(e) => {
                        setParam(p.name, { description: e.target.value });
                      }}
                    />
                  </fieldset>
                ))}
              </div>
            )}
          </Panel>

          <Panel
            title="Çalışma ayarları"
            sub="“Proje varsayılanı” bırakılanı proje belirler (iş formundaki gibi). Parametreler bunları asla değiştiremez."
          >
            <div className="grid gap-3 sm:grid-cols-3">
              <SelectField
                label="Runtime"
                value={form.runtime}
                options={RUNTIMES.map((r) => [r, runtimeName(r)] as const)}
                onChange={(v) => {
                  set({ runtime: v });
                }}
              />
              <SelectField
                label="Kum havuzu"
                value={form.sandboxProfile}
                options={[
                  ['', 'Proje varsayılanı'],
                  ...SANDBOXES.map((s) => [s, SANDBOX_TR[s]?.label ?? s] as const),
                ]}
                onChange={(v) => {
                  set({ sandboxProfile: v });
                }}
              />
              <SelectField
                label="Onay"
                value={form.approvalPolicy}
                options={[
                  ['', 'Proje varsayılanı'],
                  ...APPROVALS.map((a) => [a, APPROVAL_TR[a]?.label ?? a] as const),
                ]}
                onChange={(v) => {
                  set({ approvalPolicy: v });
                }}
              />
              {/* p15-model-picker: the template's model from the runtime's list ('' = the project's default). */}
              <DyModelPicker
                label={mp.composerLabel}
                runtimes={
                  (MODEL_RUNTIMES as readonly string[]).includes(form.runtime)
                    ? [form.runtime as ModelRuntime]
                    : []
                }
                value={form.modelProfile}
                catalog={catalog}
                testId="template-model-picker"
                onChange={(v) => {
                  set({ modelProfile: v });
                }}
              />
              <Field
                label="Süre sınırı (dakika)"
                inputMode="numeric"
                value={form.maxDurationMin}
                onChange={(e) => {
                  set({ maxDurationMin: e.target.value });
                }}
              />
              <SelectField
                label="Bitince yayınla"
                value={form.deployTarget}
                options={[
                  ['', 'Hayır'],
                  ['pages', 'Cloudflare Pages'],
                  ['coolify', 'Coolify'],
                ]}
                onChange={(v) => {
                  set({ deployTarget: v === 'pages' || v === 'coolify' ? v : '' });
                }}
              />
              {form.deployTarget !== '' ? (
                <SelectField
                  label="Nereye"
                  value={form.deployEnv}
                  options={[
                    ['preview', 'Önizleme'],
                    ['production', 'Canlı'],
                  ]}
                  onChange={(v) => {
                    set({ deployEnv: v === 'production' ? 'production' : 'preview' });
                  }}
                />
              ) : null}
              <SelectField
                label="Bitince doğrula"
                value={form.verify}
                testId="template-verify"
                options={[
                  ['', 'Proje varsayılanı'],
                  ['off', VERIFY_TR.off ?? 'off'],
                  ['report', VERIFY_TR.report ?? 'report'],
                  ['gate', VERIFY_TR.gate ?? 'gate'],
                ]}
                onChange={(v) => {
                  set({ verify: v === 'off' || v === 'report' || v === 'gate' ? v : '' });
                }}
              />
              <CheckField
                label="Bu şablonun bir çalışması bitince sohbette haber ver"
                checked={form.watch}
                onChange={(c) => {
                  set({ watch: c });
                }}
                className="sm:col-span-3"
              />
              <div className="sm:col-span-3">
                <ClassPicker
                  label="Öncelik sınıfı"
                  testId="template-priority"
                  value={form.priorityClass}
                  onChange={(v) => {
                    set({ priorityClass: v });
                  }}
                />
              </div>
            </div>
          </Panel>

          <Panel title={editing ? 'Kaydet' : 'Oluştur'}>
            <div className="grid gap-3">
              {editing ? (
                <Field
                  label="Değişiklik notu"
                  hint="Sürüm geçmişinde kalır"
                  value={form.changeNote}
                  maxLength={500}
                  onChange={(e) => {
                    set({ changeNote: e.target.value });
                  }}
                />
              ) : null}
              {saveError === null ? null : (
                <p
                  role="alert"
                  className="m-0 rounded-[10px] bg-dy-red-soft px-3.5 py-2 text-[0.875rem] text-dy-red-ink"
                >
                  {sayError(saveError)}
                </p>
              )}
              <div className="flex flex-wrap items-center gap-2">
                <DyButton
                  type="submit"
                  variant="primary"
                  icon="check"
                  busy={saving}
                  disabled={missing.length > 0}
                >
                  {editing ? 'Yeni sürümü kaydet' : 'Şablonu oluştur'}
                </DyButton>
                <DyButton
                  variant="ghost"
                  onClick={() => {
                    void navigate(back.to);
                  }}
                >
                  Vazgeç
                </DyButton>
                {missing.length > 0 ? (
                  <span className="text-[0.8125rem] text-dy-muted" data-testid="template-missing">
                    {`Eksik: ${missing.join(', ')}`}
                  </span>
                ) : null}
              </div>
            </div>
          </Panel>
        </div>

        <div className="min-w-0 lg:sticky lg:top-[69px]">
          <Panel
            title="Önizleme"
            sub="Örnek değerlerle, sunucunun bir çalışmada işleyeceği haliyle."
            testId="dy-template-preview"
          >
            <div className="grid gap-3">
              {merged.length === 0 ? null : (
                <ParamFields params={merged} values={sample} onChange={setSample} idPrefix="sample" />
              )}
              {preview !== null && preview.issues.length > 0 ? (
                <ul
                  className="m-0 grid list-none gap-1 rounded-[10px] bg-dy-amber-soft px-3.5 py-2 text-[0.84375rem] text-dy-amber-ink"
                  data-testid="template-issues"
                >
                  {preview.issues.map((i, n) => (
                    <li key={n}>{i.message}</li>
                  ))}
                </ul>
              ) : null}
              <pre
                className="m-0 max-h-[28rem] overflow-auto rounded-[10px] bg-dy-sunk px-3 py-2.5 font-dy-mono text-[0.78125rem] leading-relaxed whitespace-pre-wrap [overflow-wrap:anywhere]"
                data-testid="template-preview"
                aria-live="polite"
              >
                {preview?.prompt ?? 'Önizleme için bir istem yaz.'}
              </pre>
            </div>
          </Panel>
        </div>
      </form>
    </ScreenFrame>
  );
}
