import { ROUTES as MACHINES } from './machines';
import { ROUTES as JOBS } from './jobs';
import { ROUTES as USAGE } from './usage';
import { ROUTES as PROJECTS } from './projects';
import { ROUTES as OUTPUTS } from './outputs';
import { ROUTES as UPTIME } from './uptime';
import { ROUTES as SETTINGS } from './settings';
import { ROUTES as COMPOSER } from './composer';
import { ROUTES as TEMPLATES } from './templates';
import { ROUTES as AUTOMATIONS } from './automations';
import { ROUTES as APPROVALS } from './approvals';
import { ROUTES as DEPLOYS } from './deploys';
import { ROUTES as W3_MACHINE_RUNTIMES } from './w3-machine-runtimes';
import { ROUTES as W3_MACHINE_CONFIG } from './w3-machine-config';
import { ROUTES as W3_MACHINE_ADMIN } from './w3-machine-admin';
import { ROUTES as W3_MACHINE_LIST } from './w3-machine-list';
import { ROUTES as W3_PROJECT_POLICY } from './w3-project-policy';
import { ROUTES as W3_PROJECT_DEPLOY } from './w3-project-deploy';
import { ROUTES as W3_PROJECT_REST } from './w3-project-rest';
import { ROUTES as W3_KNOWLEDGE } from './w3-knowledge';
import { ROUTES as W3_CONTEXT } from './w3-context';
import { ROUTES as W3_SETTINGS_ACCOUNT } from './w3-settings-account';
import { ROUTES as W3_SETTINGS_AGENTS } from './w3-settings-agents';
import { ROUTES as W3_SETTINGS_ADMIN } from './w3-settings-admin';
import { ROUTES as W3_SETTINGS_INTEGRATIONS } from './w3-settings-integrations';
import { ROUTES as WORKFLOWS } from './workflows';
import { ROUTES as WORKFLOW_CANVAS } from './workflowCanvas';
import { ROUTES as FLEET_TOOLS } from './fleet-tools';
import { ROUTES as SERVER_SETTINGS } from './server-settings';
import type { ScreenRoute } from './types';

/** p12-diyalog Faz 4: every secondary screen's harness fixtures, by path (several screens may share a path). */
// p12-diyalog wave 2 (W3): one fixture file per work package, consulted first (each answers only what it owns).
const W3 = [
  W3_MACHINE_RUNTIMES,
  W3_MACHINE_CONFIG,
  W3_MACHINE_ADMIN,
  W3_MACHINE_LIST,
  W3_PROJECT_POLICY,
  W3_PROJECT_DEPLOY,
  W3_PROJECT_REST,
  W3_KNOWLEDGE,
  W3_CONTEXT,
  W3_SETTINGS_ACCOUNT,
  W3_SETTINGS_AGENTS,
  W3_SETTINGS_ADMIN,
  W3_SETTINGS_INTEGRATIONS,
];
const ALL = [
  ...W3,
  // p13-workflows-ui: the definitions list answers /workflows before the run-only fixture of İşler.
  // p17-workflow-canvas: the engine-2 canvas tour (answers only with ?engine=2, and its own workflow).
  WORKFLOW_CANVAS,
  WORKFLOWS,
  // p17-ui-review: Araçlar ve sürümler.
  FLEET_TOOLS,
  // p17-ui-polish: Ayarlar → Sunucu ayarları.
  SERVER_SETTINGS,
  MACHINES,
  JOBS,
  USAGE,
  PROJECTS,
  OUTPUTS,
  UPTIME,
  SETTINGS,
  COMPOSER,
  TEMPLATES,
  AUTOMATIONS,
  APPROVALS,
  DEPLOYS,
];

export function screenRoute(path: string): ScreenRoute[] {
  return ALL.flatMap((r) => {
    const f = r[path];
    return f === undefined ? [] : [f];
  });
}
