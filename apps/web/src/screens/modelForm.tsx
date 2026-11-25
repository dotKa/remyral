import { type ModelEntryInput, MODEL_RUNTIMES, type ModelRuntime, type ModelView } from '../api/models';
import type { CredentialRef } from '../api/workerConfig';

const NAME = /^[a-z0-9][a-z0-9_.-]{0,63}$/;

export interface ModelForm {
  id: string;
  displayName: string;
  description: string;
  runtimes: ModelRuntime[];
  provider: string;
  model: string;
  credSource: '' | 'vault' | 'worker-store';
  credName: string;
  credEnv: string;
  params: string;
  contextWindow: string;
  maxOutputTokens: string;
  inputPerMTok: string;
  outputPerMTok: string;
  enabled: boolean;
}

export const EMPTY_MODEL_FORM: ModelForm = {
  id: '',
  displayName: '',
  description: '',
  runtimes: [],
  provider: '',
  model: '',
  credSource: '',
  credName: '',
  credEnv: '',
  params: '',
  contextWindow: '',
  maxOutputTokens: '',
  inputPerMTok: '',
  outputPerMTok: '',
  enabled: true,
};

export function modelFormOf(m: ModelView): ModelForm {
  const ref = m.credentialRef;
  return {
    id: m.id,
    displayName: m.displayName,
    description: m.description ?? '',
    // ADR-0023: a removed runtime (OpenHands) is never offered again.
    runtimes: m.runtimes.filter((r) => (MODEL_RUNTIMES as readonly string[]).includes(r)),
    provider: m.provider,
    model: m.model,
    credSource: ref === undefined ? '' : ref.source,
    credName: ref === undefined ? '' : ref.source === 'vault' ? ref.id : ref.name,
    credEnv: ref?.env ?? '',
    params: Object.entries(m.params)
      .map(([k, v]) => `${k}=${String(v)}`)
      .join('\n'),
    contextWindow: m.limits.contextWindow === undefined ? '' : String(m.limits.contextWindow),
    maxOutputTokens: m.limits.maxOutputTokens === undefined ? '' : String(m.limits.maxOutputTokens),
    inputPerMTok: m.pricing.inputPerMTok === undefined ? '' : String(m.pricing.inputPerMTok),
    outputPerMTok: m.pricing.outputPerMTok === undefined ? '' : String(m.pricing.outputPerMTok),
    enabled: m.enabled,
  };
}

function num(v: string): number | undefined {
  return v.trim() === '' ? undefined : Number(v);
}

/** Form → entry, or field errors. */
export function entryOf(f: ModelForm): { entry: ModelEntryInput | null; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  if (!NAME.test(f.id)) errors.id = 'Lower-case name [a-z0-9_.-].';
  if (f.displayName.trim() === '') errors.displayName = 'Required.';
  if (f.runtimes.length === 0) errors.runtimes = 'Choose at least one runtime.';
  if (!NAME.test(f.provider)) errors.provider = 'Lower-case provider name, e.g. anthropic.';
  if (f.model.trim() === '') errors.model = 'Required.';
  const params: Record<string, string | number | boolean> = {};
  for (const line of f.params.split('\n')) {
    const t = line.trim();
    if (t === '') continue;
    const eq = t.indexOf('=');
    if (eq < 1) {
      errors.params = `“${t}” is not key=value.`;
      continue;
    }
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim();
    params[k] = v === 'true' ? true : v === 'false' ? false : /^-?\d+(\.\d+)?$/.test(v) ? Number(v) : v;
  }
  let credentialRef: CredentialRef | undefined;
  if (f.credSource !== '') {
    if (f.credName.trim() === '') errors.credName = 'Name the credential.';
    const env = f.credEnv.trim();
    if (env !== '' && !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env))
      errors.credEnv = 'An environment variable name, e.g. ANTHROPIC_API_KEY.';
    credentialRef =
      f.credSource === 'vault'
        ? { source: 'vault', id: f.credName.trim(), ...(env === '' ? {} : { env }) }
        : { source: 'worker-store', name: f.credName.trim(), ...(env === '' ? {} : { env }) };
  }
  if (Object.keys(errors).length > 0) return { entry: null, errors };
  const limits = {
    ...(num(f.contextWindow) === undefined ? {} : { contextWindow: num(f.contextWindow) }),
    ...(num(f.maxOutputTokens) === undefined ? {} : { maxOutputTokens: num(f.maxOutputTokens) }),
  };
  const pricing = {
    ...(num(f.inputPerMTok) === undefined ? {} : { inputPerMTok: num(f.inputPerMTok) }),
    ...(num(f.outputPerMTok) === undefined ? {} : { outputPerMTok: num(f.outputPerMTok) }),
  };
  return {
    entry: {
      id: f.id,
      displayName: f.displayName.trim(),
      ...(f.description.trim() === '' ? {} : { description: f.description.trim() }),
      runtimes: f.runtimes,
      provider: f.provider,
      model: f.model.trim(),
      ...(credentialRef === undefined ? {} : { credentialRef }),
      params,
      limits: limits as ModelEntryInput['limits'],
      pricing: pricing as ModelEntryInput['pricing'],
      enabled: f.enabled,
    },
    errors,
  };
}
