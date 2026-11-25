import { z } from 'zod';
import { NonNegativeInt, Sha256Hex, Timestamp } from './common.js';

/**
 * Tool inventory and install recipes (p5-machine-admin, ADR-0021, docs/design/p5-machine-admin.md).
 *
 *  - `CAPABILITIES.toolInventory` (additive in 1.0, with the `tools-v1` feature): the tools a worker found on its
 *    machine — browsers (Chrome / Edge / Chromium and the worker-managed Playwright Chromium), Python, git, Docker,
 *    Node, ffmpeg … — with versions, detected cheaply and cached by the worker. The names are what job
 *    requirements (`requirements.tools`, e.g. `browser`) are placed against.
 *  - **Recipes**: versioned, checksummed install steps compiled into the worker release for common tools. An
 *    unprivileged recipe downloads one pinned archive (URL + SHA-256 + size from the signed release, never from
 *    the panel) into the worker-owned `<dataDir>/tools/<tool>/<version>/`; an elevated recipe is a fixed list of
 *    package-manager commands that runs as a machine-admin job (approved command by command).
 *  - `OPS_COMMAND tools.detect | tool.install | tool.remove | machine.inspect` (remote-ops.ts).
 */

export const TOOLS_FEATURE = 'tools-v1';

/** A tool name as reported and as required by jobs (`browser`, `python`, `git`, `docker`, …). */
export const ToolName = z.string().regex(/^[a-z0-9][a-z0-9_.+-]{0,63}$/, 'tool name');
export type ToolName = z.infer<typeof ToolName>;

/** Tools that have a recipe in this release. */
/** p8-preview-tunnels: + `cloudflared` (the preview tunnel connector, a pinned release binary). */
export const ToolRecipeId = z.enum(['browser', 'git', 'python', 'ffmpeg', 'cloudflared', 'uv']);
export type ToolRecipeId = z.infer<typeof ToolRecipeId>;

/** A recipe version (`1248` for the Playwright Chromium revision, `2.56.0.2`, `3.13.16`, `distro`). */
export const ToolVersion = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/, 'tool version');

const Detail = z.union([z.string().max(256), z.number(), z.boolean(), z.null()]);

export const ToolInventoryEntry = z.object({
  name: ToolName,
  found: z.boolean(),
  version: z.string().max(64).optional(),
  /** Absolute path of the executable (or the install directory of a managed tool). */
  path: z.string().max(512).optional(),
  /** `managed`: installed by a recipe into the worker's own data dir; `system`: found on the machine. */
  source: z.enum(['system', 'managed']),
  details: z.record(z.string().max(64), Detail).optional(),
});
export type ToolInventoryEntry = z.infer<typeof ToolInventoryEntry>;

export const ToolRecipeReport = z.object({
  tool: ToolRecipeId,
  version: ToolVersion,
  /** Needs root / Administrator: runs as a machine-admin job (approved command by command). */
  elevated: z.boolean(),
  /** This OS/arch has a recipe step set. */
  supported: z.boolean(),
  unsupportedReason: z.string().max(300).optional(),
  /** A managed install of this version is present and verified. */
  installed: z.boolean(),
  /** Download size of an unprivileged recipe (bytes), for the panel. */
  sizeBytes: NonNegativeInt.optional(),
  /** p17-update-channel: the recipe comes from the accepted version catalog (absent: built into the release). */
  catalog: z.object({ verified: z.boolean(), sequence: z.number().int().min(1) }).optional(),
});
export type ToolRecipeReport = z.infer<typeof ToolRecipeReport>;

/**
 * p13-fleet-tools: which install of a tool jobs use — the worker's own config (`gitBinary`), a worker-managed install
 * or the machine's PATH (`resolveEffectiveTools`, fleet-tools.ts).
 */
export const EffectiveTool = z.object({
  name: ToolName,
  source: z.enum(['config', 'managed', 'system']),
  version: z.string().max(64).optional(),
  path: z.string().max(512).optional(),
});
export type EffectiveTool = z.infer<typeof EffectiveTool>;

/** `CAPABILITIES.toolInventory` (with `tools-v1`). */
export const ToolInventoryReport = z.object({
  detectedAt: Timestamp,
  /** How long the worker keeps this result before it detects again by itself. */
  ttlSec: z
    .number()
    .int()
    .min(0)
    .max(7 * 24 * 3600),
  tools: z.array(ToolInventoryEntry).max(64),
  recipes: z.array(ToolRecipeReport).max(32),
  /** p13-fleet-tools (additive, with `custom-tools-v1`): the effective install per tool name. */
  effective: z.array(EffectiveTool).max(64).optional(),
});
export type ToolInventoryReport = z.infer<typeof ToolInventoryReport>;

/**
 * Names a tool satisfies for placement: a concrete browser also satisfies `browser`; Docker or Podman satisfy
 * `container`. Shared by the worker (what it reports in `tools`) and the master (what it places against).
 */
export function toolAliases(name: string): string[] {
  switch (name) {
    case 'chrome':
    case 'edge':
    case 'chromium':
    case 'playwright-chromium':
      return [name, 'browser'];
    case 'docker':
    case 'podman':
      return [name, 'container'];
    default:
      return [name];
  }
}

/** Every requirement name the inventory satisfies (found tools and their aliases). */
export function satisfiedToolNames(inventory: Pick<ToolInventoryReport, 'tools'>): string[] {
  const out = new Set<string>();
  for (const t of inventory.tools) {
    if (!t.found) continue;
    for (const a of toolAliases(t.name)) out.add(a);
  }
  return [...out].sort();
}

/** One section of `machine.inspect` (read-only, run as the worker's service account). */
export const InspectSection = z.enum(['software', 'services', 'disk', 'logs', 'tools']);
export type InspectSection = z.infer<typeof InspectSection>;

const Line = z.string().max(512);

/** Result of `machine.inspect` (bounded, redacted on the worker and again on the master). */
export const MachineInspectReport = z.object({
  collectedAt: Timestamp,
  platform: z.string().max(32),
  software: z
    .array(z.object({ name: z.string().max(200), version: z.string().max(64).optional() }))
    .max(500)
    .optional(),
  services: z
    .array(
      z.object({
        name: z.string().max(200),
        state: z.string().max(64).optional(),
        startType: z.string().max(64).optional(),
      }),
    )
    .max(500)
    .optional(),
  disk: z
    .array(
      z.object({
        mount: z.string().max(256),
        freeBytes: NonNegativeInt.nullable(),
        totalBytes: NonNegativeInt.nullable(),
      }),
    )
    .max(32)
    .optional(),
  logs: z.array(Line).max(200).optional(),
  tools: ToolInventoryReport.optional(),
  /** Sections that could not be collected and why (never fatal). */
  problems: z
    .array(z.object({ section: InspectSection, message: z.string().max(300) }))
    .max(8)
    .optional(),
  truncated: z.boolean(),
});
export type MachineInspectReport = z.infer<typeof MachineInspectReport>;

/** One downloadable archive of an unprivileged recipe (from the signed release, never from the panel). */
export const RecipeArtifact = z.object({
  url: z.url({ protocol: /^https$/ }),
  sha256: Sha256Hex,
  size: z
    .number()
    .int()
    .min(1)
    .max(1024 * 1024 * 1024),
});
export type RecipeArtifact = z.infer<typeof RecipeArtifact>;

/**
 * Elevated recipes (Linux distribution packages): a fixed list of package-manager commands, part of the release.
 * They never run by themselves: the master turns one into a machine-admin job whose agent runs exactly these
 * commands through the elevated broker (each approved or auto-approved and signed). Shared by master and worker.
 */
export interface ElevatedRecipe {
  readonly tool: ToolRecipeId;
  readonly version: 'distro';
  readonly elevated: true;
  readonly title: string;
  readonly apt: readonly string[];
  readonly dnf: readonly string[];
  /** Command that proves the result. */
  readonly verify: string;
}

export const ELEVATED_RECIPES: readonly ElevatedRecipe[] = [
  {
    tool: 'git',
    version: 'distro',
    elevated: true,
    title: 'git from the distribution packages',
    apt: ['apt-get update', 'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends git'],
    dnf: ['dnf install -y git'],
    verify: 'git --version',
  },
  {
    tool: 'python',
    version: 'distro',
    elevated: true,
    title: 'Python 3 with venv and pip from the distribution packages',
    apt: [
      'apt-get update',
      'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends python3 python3-venv python3-pip',
    ],
    dnf: ['dnf install -y python3 python3-pip'],
    verify: 'python3 --version',
  },
  {
    tool: 'ffmpeg',
    version: 'distro',
    elevated: true,
    title: 'ffmpeg from the distribution packages',
    apt: [
      'apt-get update',
      'DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ffmpeg',
    ],
    dnf: ['dnf install -y ffmpeg-free'],
    verify: 'ffmpeg -version',
  },
];

/** The fixed prompt of the machine-admin job for an elevated recipe (the commands are part of the release). */
export function elevatedRecipePrompt(recipe: ElevatedRecipe): string {
  return [
    `Install ${recipe.title} on this Linux machine using the elevated admin_exec tool (shell "sh").`,
    'Detect the package manager first (`command -v apt-get` / `command -v dnf`), then run exactly these',
    'commands, one admin_exec call each, and nothing else:',
    `- apt: ${recipe.apt.map((c) => `\`${c}\``).join(', ')}`,
    `- dnf: ${recipe.dnf.map((c) => `\`${c}\``).join(', ')}`,
    `Finally verify with \`${recipe.verify}\` and record what was installed with machine_note.`,
    'If neither package manager exists, stop and explain why.',
  ].join('\n');
}
