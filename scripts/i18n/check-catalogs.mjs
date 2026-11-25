#!/usr/bin/env node
// p14-i18n-foundation (ADR-0053 §5): TR/EN catalog parity, read from the TypeScript sources (no build):
//   - every namespace file exists in both packages/i18n/src/tr and src/en, with the same keys at every depth;
//   - a message has the same kind in both (string / function / namespace); no empty strings;
//   - string `{placeholders}` are identical; a function's typed parameter object has the same property names
//     (the English side may leave them to `satisfies Shape<typeof tr>`, which `pnpm typecheck` enforces);
//   - English text is not a copy of the Turkish text unless allow-listed (catches untranslated entries);
//   - Turkish copy does not use a word the glossary rejects (`avoid`, packages/i18n/src/glossary.ts);
//   - p14-i18n-errors: every error code `new HttpError(…)` in apps/master/src can send has an `errors` entry, a site's
//     `params.reason` names an existing variant, and a site sends every `{placeholder}` its sentence needs
//     (master-errors.mjs reads the sites; codes of domain error classes are dynamic and only counted);
//   - p14-i18n-reasons: every scheduler REASON_CODES entry (packages/scheduler/src/placement.ts) plus `no_workers`
//     has a `reasons.codes` sentence; every `params.cause` of REASON_CAUSES (packages/protocol/src/reasons.ts) has
//     its variant next to a `default`; no other code has variants; every sentence takes the shared `ReasonVars`
//     parameter (the same in TR and EN — compareTrees).
//   node scripts/i18n/check-catalogs.mjs           check (exit 1 with a list of problems)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import ts from 'typescript';
import { MASTER_SRC, masterErrorCodes, masterErrorSites } from './master-errors.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const SRC = join(root, 'packages/i18n/src');
export const PLACEMENT_SRC = join(root, 'packages/scheduler/src/placement.ts');
export const REASONS_PROTOCOL_SRC = join(root, 'packages/protocol/src/reasons.ts');
/** Reason codes the master adds to the scheduler's (placement summary without any worker). */
const EXTRA_REASON_CODES = ['no_workers'];

/** Keys whose English text may equal the Turkish text (names, bilingual labels). */
export const SAME_TEXT_ALLOWED = new Set([
  // p20-outcome: the origin words of a goal card ("Plan", "Workflow" are the same in both languages, glossary).
  'goals.origin.plan',
  'goals.origin.workflow_run',
  // p18-leftovers: a budget line of placeholders only, and the git term "fork".
  'assistantAdmin.card.gaps.budgetValue',
  'code.pulls.fork',
  // p19-ide W2: git terms kept in English in Turkish copy (glossary).
  // p19-ide W2b: operating system names.
  'ide.platforms.linux',
  'ide.platforms.darwin',
  'ide.platforms.win32',
  'ide.list.branch',
  'ide.list.pullRequest',
  // p18-plan-mode W4: card kind words that are the same technical term in both languages.
  'cardKinds.draft.opsAction',
  'cardKinds.draft.workflow',
  'cardKinds.needs.deploy',
  'cardKinds.ops.deploy',
  'cardKinds.ops.limit',
  // p18-assistant-gaps: glossary words that stay English in Turkish (Workflow, Uptime, Deploy).
  'assistantAdmin.card.groups.workflow',
  'assistantAdmin.card.groups.monitor',
  'assistantAdmin.card.groups.deploy',
  'assistantAdmin.card.gaps.workflow',
  // p18-plan-mode: the panel's landmark name is the same word in both languages.
  'plan.region',
  // p18-plan-mode W3: the estimate sizes (S / M / L) and the empty value (—) read the same in both languages.
  'plan.edit.sizes.S',
  'plan.edit.sizes.M',
  'plan.edit.sizes.L',
  'plan.history.none',
  // p17-coolify-full: Docker's own word, the same in both languages.
  'coolifyApps.storage.mounts.volume',
  // p17-runtime-verify: "<machine>, <when>" and "<machine>: <runtime> <version> (<platform>) — <caps>" are formats.
  'runtimeVerify.platforms.by',
  'runtimeVerify.policy.item',
  // p17-panel-settings: technical words that read the same in both languages.
  'panelSettings.source.panel',
  'panelSettings.mail.source.panel',
  'panelSettings.mail.port',
  'panelSettings.mail.security',
  'panelSettings.fields.search.http.model.label',
  // p16-selfhost-onboarding: operating system and product names.
  'selfhost.wizard.steps.machine.os.linux',
  'selfhost.wizard.steps.machine.os.macos',
  'selfhost.wizard.steps.machine.os.windows',
  'selfhost.wizard.steps.integrations.coolify',
  'selfhost.wizard.steps.integrations.cloudflare',
  // p17-memory-import: assistant product names.
  'memoryImport.source.assistants.claude',
  'memoryImport.source.assistants.chatgpt',
  'memoryImport.source.assistants.gemini',
  'memoryImport.source.assistants.copilot',
  // p17-domain-wizard: the certificate authority's name.
  'selfhost.wizard.steps.domain.tlsModes.letsencrypt.title',
  // p16-workflow-quality: "<schedule> · <zone>" is a format, the same in both languages.
  'workflowQuality.schedule.withZone',
  // p16-ops-safety: product token names that read the same in both languages.
  'opsSafety.expiry.labels.cloudflareToken',
  'opsSafety.expiry.labels.coolifyToken',
  // p17-object-storage: product and encryption-mode names.
  'integrations.storage.providers.aws',
  'integrations.storage.providers.r2',
  'integrations.storage.providers.minio',
  'integrations.storage.sseModes.AES256',
  'integrations.storage.sseModes.kms',
  // p17-host-actions: product names and the S3 term "bucket".
  'hostActions.backups.offsite.providers.aws',
  'hostActions.backups.offsite.providers.r2',
  'hostActions.backups.offsite.providers.minio',
  'hostActions.backups.offsite.bucket',
  // p16-git-providers: product names.
  'gitHosts.kinds.gitlab',
  'gitHosts.kinds.bitbucket',
  // p16-runtime-updates: formats and a technical term that read the same in both languages.
  'runtimeUpdates.skipped.line',
  'runtimeUpdates.candidates.pin',
  'runtimeUpdates.candidates.machine',
  'runtimeUpdates.card.runtime',
  'runtimeUpdates.card.target',
  'nav.landmark',
  'settings.language.label',
  // p14-i18n-shell: product and technical names that read the same in both languages.
  'nav.sections.uptime',
  'auth.frame.product',
  'auth.sso.panel',
  'shared.speaker.assistant',
  // p14-workflow-engine: node type names that read the same in both languages.
  'workflows.nodeTypes.trigger.webhook.label',
  // p15-workflow-ai: the toolbar button reads "AI" in both languages.
  'workflowAi.open',
  'workflows.nodeTypes.code.js.label',
  'workflows.nodeTypes.code.python.label',
  // p14-i18n-screens-c: technical terms and provider names kept in English (glossary).
  'integrations.models.form.providerPlaceholder',
  'integrations.models.form.model',
  'integrations.models.defaults.runtime',
  'integrations.runtimes.canaryWord',
  'integrations.coolify.deploy',
  'integrations.bedrock.model',
  // p14-i18n-screens-c (projects): a role and a product name that read the same in both languages.
  'projects.roles.admin',
  'projects.safeCommands.shells.powershell',
  // p14-i18n-screens-c: separators, a technical term and channel names that read the same in both languages.
  'knowledge.search.model',
  'knowledge.context.provenance.platform',
  'projectTabs.diff.skippedB',
  'settings.devices.here.browserC',
  'settings.chat.assistant.runtime',
  // p15-git-central: a tool name and technical credential kinds that read the same in both languages.
  'gitCentral.card.title',
  'gitCentral.fleet.git',
  'gitCentral.repo.kinds.ssh-key',
  'gitCentral.repo.kinds.https-token',
  'gitCentral.vault.kinds.gitSshKey',
  'gitCentral.vault.kinds.gitHttpsToken',
  // p15-github-create-repo: GitHub's visibility word reads the same in both languages.
  'githubRepos.card.private',
  'settings.notifications.channels.webhook',
  'settings.notifications.channels.push',
  // p14-repo-egress: registry and hosting product names.
  'repoEgress.presets.npm',
  'repoEgress.presets.pypi',
  'repoEgress.presets.crates',
  'repoEgress.presets.maven',
  'repoEgress.presets.github',
  'repoEgress.presets.gitlab',
  // p16-doctor: protocol names and tool versions that read the same in both languages.
  'doctor.settings.securityStarttls',
  'doctor.settings.securityTls',
  'doctor.findings.worker.node.ok.text',
  'doctor.findings.worker.node_npm.ok.text',
  'doctor.findings.worker.git.ok.text',
  // p16-webhooks-out: protocol words and units that read the same in both languages.
  'webhooks.deliveries.code',
  'webhooks.deliveries.latency',
  'webhooks.deliveries.test',
  'webhooks.errors.http',
  'webhooks.card.label',
  'webhooks.card.kind',
  // p16-api-tokens: the settings section "API" reads the same in both languages.
  'apiTokens.pages.docs.label',
  // p15-services: technical names that read the same in both languages.
  'services.fields.port',
  'services.card.port',
  'services.fields.cpu',
  'services.form.healthHttp',
  // p14-i18n-screens-b: technical words kept English in Turkish copy (glossary) and percentile names.
  'workflows.editor.workflow',
  'usage.words.runtime',
  'usage.words.model',
  'usage.words.token',
  'usage.words.p50',
  'usage.words.p90',
  // p15-form-pattern: product names as tab names.
  'forms.tabs.integrations.github',
  'forms.tabs.integrations.bedrock',
]);

function parse(file, text) {
  return ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
}

function unwrap(expr) {
  let e = expr;
  while (
    e &&
    (ts.isSatisfiesExpression(e) ||
      ts.isAsExpression(e) ||
      ts.isParenthesizedExpression(e) ||
      ts.isTypeAssertionExpression(e))
  )
    e = e.expression;
  return e;
}

function propName(name) {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return null;
}

function stringText(e) {
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
  return null;
}

function paramNames(fn) {
  const p = fn.parameters[0];
  if (p === undefined) return [];
  if (p.type === undefined) return null; // contextually typed (English side)
  if (ts.isTypeLiteralNode(p.type))
    return p.type.members
      .map((m) => (m.name ? propName(m.name) : null))
      .filter((n) => n !== null)
      .sort();
  return [p.type.getText()];
}

/**
 * The message tree of `export default { … }` in `text`: path → { kind, text?, params?, line }.
 * Exported for the script tests.
 */
export function messageTree(file, text) {
  const sf = parse(file, text);
  const out = new Map();
  const problems = [];
  let found = false;
  const walk = (obj, prefix) => {
    for (const p of obj.properties) {
      const line = sf.getLineAndCharacterOfPosition(p.getStart()).line + 1;
      const name = p.name ? propName(p.name) : null;
      if (name === null || !(ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p))) {
        problems.push(`${file}:${line}: only plain \`key: value\` entries are allowed in a catalog`);
        continue;
      }
      const path = prefix === '' ? name : `${prefix}.${name}`;
      if (ts.isMethodDeclaration(p)) {
        out.set(path, { kind: 'function', params: paramNames(p), line });
        continue;
      }
      const v = unwrap(p.initializer);
      const s = stringText(v);
      if (s !== null) out.set(path, { kind: 'string', text: s, line });
      else if (ts.isArrowFunction(v) || ts.isFunctionExpression(v))
        out.set(path, { kind: 'function', params: paramNames(v), line });
      else if (ts.isObjectLiteralExpression(v)) walk(v, path);
      else problems.push(`${file}:${line}: ${path} must be a string, a function or a namespace object`);
    }
  };
  sf.forEachChild((n) => {
    if (ts.isExportAssignment(n) && !n.isExportEquals) {
      const v = unwrap(n.expression);
      if (ts.isObjectLiteralExpression(v)) {
        found = true;
        walk(v, '');
      }
    }
  });
  if (!found) problems.push(`${file}: no \`export default { … }\` catalog object`);
  return { tree: out, problems };
}

/** Every string text in a Turkish catalog file (literals and template pieces), for the glossary check. */
export function turkishTexts(file, text) {
  const sf = parse(file, text);
  const texts = [];
  const visit = (n) => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      if (!ts.isImportDeclaration(n.parent) && !ts.isExportDeclaration(n.parent))
        texts.push({ text: n.text, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
    } else if (ts.isTemplateExpression(n)) {
      const parts = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' ');
      texts.push({ text: parts, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1 });
    }
    n.forEachChild(visit);
  };
  visit(sf);
  return texts;
}

const placeholders = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

/** Problems between one Turkish and one English namespace tree. */
export function compareTrees(ns, tr, en) {
  const problems = [];
  for (const [path, a] of tr) {
    const key = `${ns}.${path}`;
    const b = en.get(path);
    if (b === undefined) {
      problems.push(`${key}: missing in en`);
      continue;
    }
    if (a.kind !== b.kind) {
      problems.push(`${key}: ${a.kind} in tr but ${b.kind} in en`);
      continue;
    }
    if (a.kind === 'string') {
      if (a.text.trim() === '') problems.push(`${key}: empty in tr`);
      if (b.text.trim() === '') problems.push(`${key}: empty in en`);
      if (placeholders(a.text).join() !== placeholders(b.text).join())
        problems.push(
          `${key}: placeholders differ (tr {${placeholders(a.text)}} / en {${placeholders(b.text)}})`,
        );
      if (a.text === b.text && !SAME_TEXT_ALLOWED.has(key))
        problems.push(`${key}: en is a copy of tr (“${a.text}”) — translate it or allow-list the key`);
    } else {
      if (a.params === null) problems.push(`${key}: the Turkish message must type its parameter object`);
      else if (b.params !== null && a.params.join() !== b.params.join())
        problems.push(`${key}: parameters differ (tr ${a.params.join(',')} / en ${b.params.join(',')})`);
    }
  }
  for (const path of en.keys()) if (!tr.has(path)) problems.push(`${ns}.${path}: only in en`);
  return problems;
}

/** The glossary's rejected Turkish variants, read from glossary.ts (`avoid: [ … ]`). */
export function avoidedWords(text) {
  const sf = parse('glossary.ts', text);
  const words = [];
  const visit = (n) => {
    if (
      ts.isPropertyAssignment(n) &&
      propName(n.name) === 'avoid' &&
      ts.isArrayLiteralExpression(n.initializer)
    )
      for (const e of n.initializer.elements) if (ts.isStringLiteral(e)) words.push(e.text);
    n.forEachChild(visit);
  };
  visit(sf);
  return words;
}

export function glossaryProblems(file, texts, avoid) {
  const problems = [];
  for (const { text, line } of texts) {
    const lower = text.toLocaleLowerCase('tr-TR');
    for (const w of avoid)
      if (
        new RegExp(`(^|[^\\p{L}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[^\\p{L}])`, 'u').test(lower)
      )
        problems.push(
          `${file}:${line}: “${w}” is not the glossary’s Turkish word (docs/design/i18n-glossary.md)`,
        );
    // Owner style rule (2026-10-24): no circumflex in Turkish copy — "zeka", "hala", "kağıt", never "zekâ", "hâlâ".
    if (/[âÂîÎûÛ]/u.test(text))
      problems.push(
        `${file}:${line}: no circumflex (â, î, û) in Turkish copy — write "zeka", "hala", "kağıt"`,
      );
  }
  return problems;
}

/**
 * p14-i18n-errors: problems between the master's HttpError sites and the `errors` namespace tree (TR; EN has the same
 * keys and placeholders by `compareTrees`). With the English tree, a literal message sent without params must be
 * the English catalog sentence word for word: the console translates such a body only when they match (a code
 * reused by a domain error keeps its own sentence), so a reworded message would silently stay English.
 * Exported for the script tests.
 */
export function masterErrorProblems(sites, tree, enTree = null) {
  const problems = [];
  const where = (s) => `${s.file}:${String(s.line)}`;
  const entry = (code) => {
    if (tree.has(code)) return { kind: 'string', text: tree.get(code).text };
    const variants = new Map();
    for (const [k, v] of tree) if (k.startsWith(`${code}.`)) variants.set(k.slice(code.length + 1), v.text);
    return variants.size > 0 ? { kind: 'variants', variants } : null;
  };
  const sent = masterErrorCodes(sites);
  for (const code of sent) {
    if (entry(code) !== null) continue;
    const first = sites.find((s) => (s.codes ?? s.partial).includes(code));
    problems.push(`errors.${code}: missing — ${first ? where(first) : 'the master'} sends it`);
  }
  const top = new Set([...tree.keys()].map((k) => k.split('.')[0]));
  for (const code of top)
    if (!sent.includes(code))
      problems.push(`errors.${code}: no HttpError in apps/master/src sends this code`);
  for (const s of sites) {
    if (s.codes === null || s.params === null) continue; // dynamic code, or params built elsewhere
    const keys = new Set(s.params.keys.filter((k) => k !== 'reason'));
    const reasons = s.params.reason === null ? [null] : s.params.reason === undefined ? [] : s.params.reason;
    for (const code of s.codes) {
      const e = entry(code);
      if (e === null) continue;
      for (const reason of reasons) {
        let text;
        if (e.kind === 'string') text = e.text;
        else {
          text = e.variants.get(reason ?? 'default');
          if (text === undefined) {
            problems.push(
              reason === null
                ? `errors.${code}: no \`default\` variant for ${where(s)}, which sends no params.reason`
                : `errors.${code}: no variant \`${reason}\` (params.reason of ${where(s)})`,
            );
            continue;
          }
        }
        for (const p of placeholders(text))
          if (!keys.has(p))
            problems.push(
              `errors.${code}${reason === null ? '' : `.${reason}`}: needs {${p}} but ${where(s)} does not send params.${p}`,
            );
        if (enTree !== null && s.text !== null && s.params.keys.length === 0) {
          const en = enTree.get(e.kind === 'string' ? code : `${code}.default`)?.text;
          if (en !== undefined && en !== s.text)
            problems.push(
              `errors.${code}: English “${en}” is not the message of ${where(s)} (“${s.text}”) — give the site a params.reason variant or match the wording`,
            );
        }
      }
    }
  }
  return problems;
}

/** The string elements of `export const <name> = [ … ]` (through `as const` / `satisfies`). */
export function constStringArray(file, text, name) {
  const sf = parse(file, text);
  let out = null;
  sf.forEachChild((n) => {
    if (!ts.isVariableStatement(n)) return;
    for (const d of n.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name || d.initializer === undefined) continue;
      const v = unwrap(d.initializer);
      if (ts.isArrayLiteralExpression(v)) out = v.elements.map(stringText).filter((s) => s !== null);
    }
  });
  return out ?? [];
}

/** `export const <name> = { code: ['a', 'b'], … }` as a Map code → causes. */
export function constStringArrayRecord(file, text, name) {
  const sf = parse(file, text);
  const out = new Map();
  sf.forEachChild((n) => {
    if (!ts.isVariableStatement(n)) return;
    for (const d of n.declarationList.declarations) {
      if (!ts.isIdentifier(d.name) || d.name.text !== name || d.initializer === undefined) continue;
      const v = unwrap(d.initializer);
      if (!ts.isObjectLiteralExpression(v)) continue;
      for (const p of v.properties) {
        if (!ts.isPropertyAssignment(p)) continue;
        const key = propName(p.name);
        const arr = unwrap(p.initializer);
        if (key !== null && ts.isArrayLiteralExpression(arr))
          out.set(
            key,
            arr.elements.map(stringText).filter((s) => s !== null),
          );
      }
    }
  });
  return out;
}

/**
 * p14-i18n-reasons: problems between the `reasons` namespace tree (TR) and the codes / causes producers send.
 * Exported for the script tests.
 */
export function reasonProblems(tree, codes, causes) {
  const problems = [];
  const entries = new Map(); // code → { plain: boolean, variants: Set }
  for (const [path, v] of tree) {
    const parts = path.split('.');
    if (parts[0] !== 'codes') continue;
    const code = parts[1];
    const e = entries.get(code) ?? { plain: false, variants: new Set() };
    if (parts.length === 2) e.plain = true;
    else if (parts.length === 3) e.variants.add(parts[2]);
    else problems.push(`reasons.${path}: a reason sentence nests at most one level of variants`);
    entries.set(code, e);
    if (v.kind !== 'function')
      problems.push(`reasons.${path}: a reason sentence is a function of ReasonVars`);
    else if (v.params !== null && v.params.join() !== 'ReasonVars')
      problems.push(`reasons.${path}: takes (${v.params.join(', ')}), not (v: ReasonVars)`);
  }
  for (const code of codes)
    if (!entries.has(code)) problems.push(`reasons.codes.${code}: missing — the scheduler sends this code`);
  for (const [code, list] of causes) {
    const e = entries.get(code);
    if (e === undefined) {
      problems.push(`reasons.codes.${code}: missing — REASON_CAUSES lists its causes`);
      continue;
    }
    if (e.plain) problems.push(`reasons.codes.${code}: needs variants (default + ${list.join(', ')})`);
    if (!e.plain && !e.variants.has('default'))
      problems.push(`reasons.codes.${code}: no \`default\` variant`);
    for (const c of list)
      if (!e.plain && !e.variants.has(c))
        problems.push(`reasons.codes.${code}.${c}: missing — REASON_CAUSES lists cause \`${c}\``);
  }
  for (const [code, e] of entries) {
    const list = causes.get(code);
    for (const variant of e.variants)
      if (variant !== 'default' && !(list ?? []).includes(variant))
        problems.push(
          `reasons.codes.${code}.${variant}: not a cause in REASON_CAUSES (packages/protocol/src/reasons.ts)`,
        );
  }
  return problems;
}

const namespaces = (dir) =>
  readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && f !== 'index.ts')
    .sort();

export function checkCatalogs(src = SRC, masterSrc = MASTER_SRC, reasonSources = true) {
  const problems = [];
  const trFiles = namespaces(join(src, 'tr'));
  const enFiles = namespaces(join(src, 'en'));
  for (const f of enFiles)
    if (!trFiles.includes(f)) problems.push(`en/${f}: no Turkish namespace of that name`);
  const avoid = avoidedWords(readFileSync(join(src, 'glossary.ts'), 'utf8'));
  let keys = 0;
  let errorCodes = null;
  let reasonCount = null;
  for (const f of trFiles) {
    const ns = f.replace(/\.ts$/, '');
    const trText = readFileSync(join(src, 'tr', f), 'utf8');
    const tr = messageTree(`tr/${f}`, trText);
    problems.push(...tr.problems);
    problems.push(...glossaryProblems(`tr/${f}`, turkishTexts(`tr/${f}`, trText), avoid));
    if (!enFiles.includes(f)) {
      problems.push(`tr/${f}: missing en/${f}`);
      continue;
    }
    const en = messageTree(`en/${f}`, readFileSync(join(src, 'en', f), 'utf8'));
    problems.push(...en.problems);
    problems.push(...compareTrees(ns, tr.tree, en.tree));
    if (ns === 'errors' && masterSrc !== null) {
      const sites = masterErrorSites(masterSrc);
      problems.push(...masterErrorProblems(sites, tr.tree, en.tree));
      errorCodes = {
        codes: masterErrorCodes(sites).length,
        sites: sites.length,
        dynamic: sites.filter((x) => x.codes === null).length,
      };
    }
    if (ns === 'reasons' && reasonSources) {
      const codes = [
        ...constStringArray('placement.ts', readFileSync(PLACEMENT_SRC, 'utf8'), 'REASON_CODES'),
        ...EXTRA_REASON_CODES,
      ];
      if (codes.length <= EXTRA_REASON_CODES.length)
        problems.push('packages/scheduler/src/placement.ts: no REASON_CODES array found');
      const causes = constStringArrayRecord(
        'reasons.ts',
        readFileSync(REASONS_PROTOCOL_SRC, 'utf8'),
        'REASON_CAUSES',
      );
      if (causes.size === 0) problems.push('packages/protocol/src/reasons.ts: no REASON_CAUSES found');
      problems.push(...reasonProblems(tr.tree, codes, causes));
      reasonCount = {
        codes: new Set([...tr.tree.keys()].filter((k) => k.startsWith('codes.')).map((k) => k.split('.')[1]))
          .size,
        causes: [...causes.values()].reduce((n, l) => n + l.length, 0),
      };
    }
    keys += tr.tree.size;
  }
  if (reasonSources && !trFiles.includes('reasons.ts'))
    problems.push('tr/reasons.ts: missing (reason sentences)');
  return { problems, namespaces: trFiles.length, keys, errorCodes, reasonCount };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { problems, namespaces: n, keys, errorCodes: ec, reasonCount: rc } = checkCatalogs();
  if (problems.length > 0) {
    console.error(`i18n: catalog check failed (${String(problems.length)}):\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`i18n: tr/en catalogs match (${String(n)} namespaces, ${String(keys)} messages)`);
  if (ec !== null)
    console.log(
      `i18n: ${String(ec.codes)} master error codes covered (${String(ec.sites)} HttpError sites, ${String(ec.dynamic)} with a dynamic code)`,
    );
  if (rc !== null)
    console.log(
      `i18n: ${String(rc.codes)} reason codes covered (${String(rc.causes)} causes with their own sentence)`,
    );
}
