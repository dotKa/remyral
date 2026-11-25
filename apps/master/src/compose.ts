import { ChatDirectActions } from './chat/direct.js';
import { GoalGrants } from './chat/goal-grants.js';
import { UntrustedAllows } from './chat/untrusted.js';
import { WatchThenRunner } from './chat/watch-then.js';
import { TimeLimitService } from './jobs/time-limit.js';
import { JobClockService } from './jobs/job-clock.js';
import { timeLimitRoutes } from './jobs/time-limit-routes.js';
import { AutoFixService } from './self-heal/auto-fix.js';
import { ConflictResolveService } from './self-heal/conflict-resolve.js';
import { BaseRefHealer } from './self-heal/base-ref.js';
import { AutoRetryService } from './self-heal/retry.js';
import { selfHealRoutes } from './self-heal/routes.js';
import type { RemoteProbe } from './self-heal/remote-probe.js';
import { RepoAccessPreflight } from './self-heal/repo-access.js';
import { SelfHealService } from './self-heal/service.js';
import { ChatSettings } from './chat/settings-actions.js';
import { ChatAdmin } from './chat/admin-actions.js';
import { ChatOpsTools } from './chat/ops-tools.js';
import { ChatProjectSetup } from './chat/project-setup.js';
import { ChatCodeTools } from './chat/code-tools.js';
import { ThreadProjects } from './chat/thread-projects.js';
import { JobBatchRunner, ThreadProjectsRunner, WorkflowAttachRunner } from './chat/multi-project-actions.js';
import { JobBatchService } from './jobs/batches.js';
import { jobBatchRoutes } from './jobs/batch-routes.js';
import { AutomationGroupService } from './automations/groups.js';
import { ChatFailoverStore } from './chat/failover.js';
import { ChatShares } from './chat/share.js';
import { SecurityPolicyService, securityPolicyRoutes } from './security-policy/index.js';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { buildApp, type RoutePlugin } from './app.js';
import { ApprovalService, approvalRoutes, ProjectPolicyStore } from './approvals/index.js';
import { requestJson as approvalRequestJson } from './approvals/routes.js';
import { ApprovalPauseService } from './approvals/pause.js';
import { approvalPauseRoutes } from './approvals/pause-routes.js';
import { UsageLimitService } from './usage-limits/service.js';
import { RuntimeAccountService } from './runtime-accounts/service.js';
import { AccountSwitchService } from './runtime-accounts/switch.js';
import { runtimeAccountRoutes } from './runtime-accounts/routes.js';
import { usageLimitRoutes } from './usage-limits/routes.js';
import { SessionContinuityService } from './continuity/service.js';
import { continuityRoutes } from './continuity/routes.js';
import {
  type ContinuityPolicy,
  defaultContinuityPolicy,
  MCP_INSTALL_SCRIPTS_FEATURE,
  OUTPUT_LIMITS,
  type RuntimeKind,
} from '@remyral/protocol';
import { UsageRefreshService } from './runtime-usage/refresh.js';
import { runtimeUsageRoutes } from './runtime-usage/routes.js';
import { RuntimeUsageService } from './runtime-usage/service.js';
import { AccessGate, type AccessLimits } from './audit/access.js';
import { AuditLog } from './audit/audit.js';
import { backupRoutes } from './backups/routes.js';
import { BackupStatusService } from './backups/service.js';
import { auditRoutes } from './audit/routes.js';
import { createSessionAuthenticator } from './auth/hooks.js';
import { ApiTokenService } from './api-tokens/service.js';
import { withBearerTokens } from './api-tokens/authenticator.js';
import { apiTokenRoutes } from './api-tokens/routes.js';
import { TokenUsageCounter } from './api-tokens/usage.js';
import {
  FallbackConcurrencyGuard,
  RedisConcurrencyGuard,
  TOKEN_REQUEST_LIMITS,
  type TokenLimitPolicy,
} from './api-tokens/limits.js';
import { DEFAULT_STEP_UP_POLICY, type StepUpPolicy } from './auth/step-up.js';
import type { ScryptParams } from './auth/password.js';
import { FallbackRateLimiter, type RateLimiter, RedisRateLimiter } from './auth/rate-limit.js';
import { DependencyHealth } from './infra/dependency-health.js';
import { WorkerInboxRetention } from './orchestration/inbox-retention.js';
import type { ConnectionCapRule } from './http/connection-caps.js';
import {
  DEFAULT_REQUEST_LIMITS,
  type RequestLimitPolicy,
  type SlowRequestTimeouts,
  type WindowRule,
} from './http/rate-policy.js';
import { authRoutes } from './auth/routes.js';
import { createAuthorizer } from './authz/authorizer.js';
import { Directory } from './authz/directory.js';
import { directoryRoutes } from './authz/routes.js';
import type { SecretBox } from './auth/secret-box.js';
import { AuthService, type RateLimits } from './auth/service.js';
import {
  DEFAULT_LOGIN_PERSISTENCE,
  type LoginPersistencePolicy,
  loginPersistenceFromDays,
} from './auth/trusted-devices.js';
import { ContextPolicyService, contextPolicyRoutes, ContextStore, contextRoutes } from './context/index.js';
import type { Pool } from './db/pool.js';
import { JobQuery } from './jobs/query.js';
import { jobReadRoutes, summaryJson as jobSummaryJson } from './jobs/read-routes.js';
import { jobTitleRoutes } from './jobs/title-routes.js';
import { JobTitles } from './jobs/titles.js';
import { JobStore } from './jobs/store.js';
import type { LogLevel } from './logging.js';
import type { RedisClient } from './redis.js';
import { healthRoutes, postgresProbe, redisProbe, statusRoutes } from './routes/health.js';
import { timeRoutes } from './routes/time.js';
import { UserLocaleService } from './me/locale.js';
import { meRoutes } from './me/routes.js';
import { UserThemeService } from './me/theme.js';
import { DecisionDeferralService } from './me/deferrals.js';
import type { GatewayLimits, GatewayTiming } from './workers/connection.js';
import { type ConnectRateLimit, workerGatewayRoutes } from './workers/gateway.js';
import { WorkerHub } from './workers/hub.js';
import { type PairingPolicy, PgDeviceDirectory } from './workers/directory.js';
import { FleetService } from './workers/fleet.js';
import { RotationService } from './workers/rotation.js';
import { RuntimePolicyService, runtimePolicyRoutes } from './runtime-policy/index.js';
import { PreferredWorkersService, WorkerConfigService, workerConfigRoutes } from './worker-config/index.js';
import { CapacityService } from './capacity/service.js';
import { capacityRoutes } from './capacity/routes.js';
import { VaultService, vaultRoutes } from './vault/index.js';
import { RemoteOpsService, remoteOpsRoutes, type RemoteOpsLimits } from './remote-ops/index.js';
import { CapabilityEvidenceService, capabilityEvidenceRoutes } from './capability-evidence/index.js';
import { WorkerRemovalService } from './worker-removal/service.js';
import { workerRemovalRoutes } from './worker-removal/routes.js';
import {
  CATALOG,
  CustomRecipeStore,
  type FeedFetch,
  FleetToolsService,
  fleetToolsRoutes,
  RuntimeReleases,
  RuntimeVerificationService,
  VersionFeedService,
} from './fleet-tools/index.js';
import { SandboxOpsService, sandboxOpsRoutes } from './sandbox-ops/index.js';
import { ModelCatalogService, modelRoutes } from './models/index.js';
import { fleetRoutes } from './workers/routes.js';
import {
  ChatService,
  ChatSettingsStore,
  ChatStore,
  ChatBus,
  ChatStreams,
  type ChatStreamLimits,
  ChatTools,
  chatRoutes,
  DraftExecutor,
  ChatWatchService,
} from './chat/index.js';
import { ChatAssets } from './chat/assets.js';
import type { MessageView } from './chat/store.js';
import { WatchChecks } from './chat/watch-checks.js';
import { WatchFollowUps } from './chat/watch-follow-up.js';
import { GoalLedger } from './chat/goals.js';
import { goalRoutes } from './chat/goal-routes.js';
import { ChatCredentials } from './chat/credentials.js';
import { SandboxPool } from '@remyral/workflow-expr';
import { ChatOrganizer } from './chat/organize.js';
import { ChatJobActions } from './chat/job-actions.js';
import { chatOrganizeRoutes } from './chat/organize-routes.js';
import { JobMessageService, type JobMessageLimits } from './jobs/messages.js';
import type { DeviceDirectory, WorkerSessionHandler } from './workers/types.js';
import {
  type RetirementResult,
  retireOpenHands,
  retiredInteractiveRoutes,
} from './runtime-retirement/index.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Live worker connections (tests and admin actions). */
    readonly workerHub: WorkerHub;
    /** p17-object-storage: the blob store, its panel settings, upload grants and share links (tests). */
    readonly blobs: BlobService;
    readonly blobUploads: BlobUploads;
    /** Master-side worker state (heartbeats, capabilities, offline sweep) + job control messages. */
    readonly fleetSessions: OrchestrationSessionHandler;
    /** p4: dispatch, scheduling and recovery (tests drive `tick()` directly). */
    readonly orchestrator: Orchestrator;
    /** p11-session-continuity: checkpoints and worker-restart resumes. */
    readonly continuity: SessionContinuityService;
    /** p4-dispatch: transactional outbox → BullMQ hints / worker outbox. */
    readonly outboxRelay: OutboxRelay;
    /** p5-notifications: producers, delivery queue and the REST backing (tests drive runOnce()). */
    readonly notifications: NotificationService;
    /** p4-quotas: admission, run limits, provider pauses, kill switch. */
    readonly quotas: QuotaService;
    /** p4-dag: workflow definitions, runs, dependency-aware dispatch (tests drive progress()). */
    readonly workflows: WorkflowService;
    /** p5-composer: scheduled submissions — since p6-automations an alias over automations. */
    readonly schedules: ScheduleService;
    /** p6-automations: triggers → runs (the sweeper/start/sync passes run as an orchestrator tick step). */
    readonly automations: AutomationService;
    /** p5-research-workspace-next: workspace file retention + storage quota sweeper (tests drive sweep()). */
    readonly workspaceStorage: StorageSweeper;
    /** p4-git-flow: verification, conflict checks, approved merges (tests drive tick()/execute()). */
    readonly gitflow: GitFlowService;
    /** ADR-0023: the OpenHands retirement step (also run once when the app is ready; tests re-run it). */
    readonly retireRuntimes: () => Promise<RetirementResult>;
    /** p6-otel: state gauges + transition tailer (null without telemetry). */
    readonly metrics: MasterMetrics | null;
    /** p16-observability: the status page snapshot (tests read it directly). */
    readonly systemStatus: SystemStatusService;
    /** p16-selfhost-onboarding: the signed control-plane update feed (tests drive refresh()). */
    readonly updates: UpdateFeedService;
    /** p17-host-actions: requests the remyral-ctl host applier runs (tests drive reconcile()). */
    readonly hostActions: HostActionService;
    /** p17-panel-settings Part 0: owner notices of backup changes waiting for the host time lock (tests drive tick()). */
    readonly backupChanges: BackupChangeWatch;
    /** p17-panel-settings: the master-stored settings (tests read and reload them). */
    readonly panelSettings: PanelSettingsService;
    /** p17-panel-settings Part 7: maintenance jobs (tests wait for them). */
    readonly maintenance: MaintenanceService;
    /** p17-update-channel: the worker release feed / policy / rollout (tests drive tick()). */
    readonly updateChannel: UpdateChannelService;
    /** p17-update-channel: the version catalog (tests drive refresh()). */
    readonly versionCatalog: VersionCatalogService;
    /** p17-update-channel: runtime policies (tests run the pin mode migration). */
    readonly runtimePolicies: RuntimePolicyService;
    /** p17-domain-wizard: the console's public address (tests drive tick() / reconcile()). */
    readonly consoleDomain: ConsoleDomainService;
    /** p16-selfhost-onboarding: one-time setup tokens for the first owner (tests issue tokens through it). */
    readonly setup: SetupService;
    /** p16-git-providers: GitLab / Bitbucket connections (tests issue push credentials through it). */
    readonly gitHosts: GitHostService;
    /** p16-observability: the log search store (null without a log sink; tests drive flush() / purge()). */
    readonly logStore: LogStore | null;
    /** p16-observability: the assistant's administration reads (tests call read()). */
    readonly chatAdmin: ChatAdmin;
    /** p18-assistant-gaps: workflow runs, job outputs, backups / updates … of the assistant (tests call read / plan). */
    readonly chatOpsTools: ChatOpsTools;
    /** p18-project-bootstrap: a project's readiness, network and machines through the chat (tests call it). */
    readonly chatProjectSetup: ChatProjectSetup;
    /** p19-ide W4: the assistant's code tools (tests call read / plan). */
    readonly chatCodeTools: ChatCodeTools;
    /** p18-multi-project W3: the conversations' working projects (tests drive forTurn / set). */
    readonly threadProjects: ThreadProjects;
    /** p18-multi-project W5: job fan-out batches (null until the orchestration services are up). */
    readonly jobBatches: JobBatchService | null;
    /** p6-agentmagnify: optional lifecycle forwarder (null when disabled). */
    readonly agentmagnify: AgentMagnifyForwarder | null;
    /** p6-alerts: operational alarm evaluator (tests drive evaluate()). */
    readonly alerts: AlertEvaluator;
    /** p8-cost-efficiency: weekly reports (the scheduler runs as an orchestrator tick step; tests drive tick()). */
    readonly reports: ReportService;
    /** p6-vector: optional semantic search (tests drive sync()). */
    readonly semanticSearch: SearchService;
    /** p10-semantic-memory: project memory suggestions (tests drive pass()). */
    readonly memorySuggestions: MemorySuggestionService;
    /** p17-embeddings: similar jobs, solved failures, duplicate checks (tests drive sync()). */
    readonly relatedWork: RelatedWorkService;
    /** p11-memory-layers: typed memory records (tests drive sweep()). */
    readonly memoryRecords: MemoryRecordService;
    /** p10-semantic-defaults-chat: project knowledge defaults and the one-time backfill (tests drive backfill()). */
    readonly semanticDefaults: SemanticDefaultsService;
    /** p10-semantic-defaults-chat: chat as knowledge (tests drive pass()). */
    readonly chatKnowledge: ChatKnowledge;
    /** p5-live: live rows (events/log chunks), the SSE streams and their wake-up bus. */
    readonly live: { readonly store: LiveStore; readonly streams: LiveStreams; readonly bus: LiveBus };
    /** p5-ops-chat: turn orchestration (tests drive sweep()), thread streams. */
    readonly chat: ChatService;
    /** p6-skills / p5-machine-admin: skills (tests drive the panel-signed flow). */
    readonly skills: SkillService;
    /** p14-mcp-core: external MCP servers for jobs (tests drive issue / recordCall). */
    readonly mcp: McpService;
    /** p19-project-env: a project's environment credentials (tests drive placementFor / assignment). */
    readonly projectEnv: ProjectEnvService;
    /** p6-deploy-integrations: ops actions (deploy, DNS, Pages) with master-held tokens. */
    readonly ops: OpsService;
    /** p6-deploy-on-success: pre-approved deploys of succeeded jobs (tests drive tick()). */
    readonly deployOnSuccess: DeployOnSuccessService;
    /** p8-outputs-folders: own folders (tests drive linkTick()). */
    readonly outputFolders: OutputFolders;
    /** p6-chat-notify: "let me know when …" watches of the ops chat (tests drive tick()). */
    readonly chatWatches: ChatWatchService;
    /** p17-chat-flow: approvals / results / job questions into conversations (tests drive tick()). */
    readonly chatFlow: ChatFlowService;
    /** p18-plan-mode: plans of the conversations (tests drive tick()). */
    readonly chatPlans: ChatPlanService;
    /** p20-outcome: the goal ledger (tests drive tick() / evaluate()). */
    readonly chatGoals: GoalLedger;
    /** p8-uptime: monitors and their checks (tests drive tick() + drain()). */
    readonly uptime: UptimeService;
    /** p8-preview-tunnels: preview links (tests drive sweep()). */
    readonly previews: PreviewService;
    /** p15-services: services workers own (tests drive sweep() and subscribe to events). */
    readonly services: ServiceRegistry;
    /** p19-ide W2: Tam IDE workspaces (tests drive sweep()). */
    readonly ide: IdeService;
    /** p15-workspace-retention: kept working directories (tests drive sweep(true)). */
    readonly workfiles: WorkfilesService;
    /** p16-zip-job-input: job input bundles (tests drive sweep(true)). */
    readonly inputUploads: InputUploadService;
    /** p15-workspace-retention: "Repoya aktar" / site uploads from kept files (tests drive the chat runner). */
    readonly workfilesExport: WorkfilesExport;
    /** p14-ask-user: question cards of the assistant and job agents (tests drive tick()). */
    readonly questions: QuestionService;
    /** p10-backup-restore: backup service status and its notifications (tests drive tick()). */
    readonly backups: BackupStatusService;
    /** p10-verify-health: "Verify when done" (tests drive tick() + drain()). */
    readonly verification: VerificationService;
    /** p11-merge-pipeline: master-managed integration (tests drive tick()/drain()). */
    readonly integration: IntegrationService;
    /** p10-verify-health: post-deploy health checks (tests drive tick() + drain()). */
    readonly deployHealth: DeployHealthService;
    /** p12-deploy-feedback: deploy logs, fix plans, in-job deploy tools, auto-fix (tests drive tick()). */
    readonly deployFeedback: DeployFeedbackService;
    /** p13-fleet-tools: fleet matrix, bulk actions, digest (tests drive tick() / digest()). */
    readonly fleetTools: FleetToolsService;
    /** p13-fleet-tools: version feeds (tests drive refresh()). */
    readonly fleetToolFeed: VersionFeedService;
    /** p16-ops-safety: keys and expiry, the cost brake, the rollout breaker (tests drive their passes). */
    readonly opsSafety: {
      readonly expiry: ExpiryService;
      readonly brake: CostBrakeService;
      readonly breaker: () => RolloutBreaker | null;
    };
  }
}

/** p5-ops-chat settings (docs/design/p5-ops-chat.md). */
export interface ChatConfig {
  /** Turn timeout sweep period (default 15 s; 0 = no loop, tests call `app.chat.sweep()`). */
  readonly sweepIntervalMs?: number;
  /** p22-slow-tools: when a running tool call is answered "still running" (default 45 s). */
  readonly slowToolMs?: number;
  readonly turnTimeoutMs?: number;
  readonly streams?: Partial<ChatStreamLimits>;
  readonly jobMessageLimits?: JobMessageLimits;
  /** p15-watches: how long the dry test waits for a worker's first check (default 25 s), and the check-job queue timeout. */
  readonly watchChecks?: { readonly dryWaitMs?: number; readonly queueTimeoutSec?: number };
  /**
   * p5-ops-chat-next: coordination of master replicas over Postgres NOTIFY (turn dispatch to the replica holding
   * the assistant worker, Stop / kill switch forwarding, stream fan-out). On by default; with one replica it only
   * announces itself. `presenceMs` (default 5 s) and `dispatchAckMs` (default 5 s) are for tests.
   */
  readonly replicas?: {
    readonly enabled?: boolean;
    readonly presenceMs?: number;
    readonly dispatchAckMs?: number;
  };
  /** p15-chat-failover: how long a returning machine must stay connected before it takes the chat back (60 s). */
  readonly failoverStableMs?: number;
  /** p17-chat-reconnect: how long a turn waits for its worker process to reconnect (45 s; tests shorten it). */
  readonly reconnectGraceMs?: number;
  /** p16-chat-complete: the restart re-run of turns a stopped master left open (window, age, count, grace). */
  readonly restartRecovery?: {
    readonly windowMs?: number;
    readonly maxAgeMs?: number;
    readonly maxReruns?: number;
    readonly graceMs?: number;
  };
}

/** p4-git-flow settings (docs/design/p4-git-flow.md, docs/ops/github-app.md). */
export interface GitFlowConfig {
  /** `keyRef` → GitHub App (from GITHUB_APP_ID / GITHUB_APP_PRIVATE_KEY_FILE); empty: GitHub unavailable. */
  readonly githubApps?: ReadonlyMap<string, GitHubAppAuth>;
  /** Host repository URLs of GitHub projects must use (default github.com). */
  readonly githubHost?: string;
  /**
   * p5-github-connect: GitHub REST base (default https://api.github.com; GHES `https://<host>/api/v3`) and web
   * origin (default https://github.com) for the panel-connected App; the console origin GitHub sends the owner
   * back to (default: installers.publicOrigin / PUBLIC_ORIGIN; unset = "Connect GitHub" unavailable).
   */
  readonly githubApiUrl?: string;
  readonly githubWebUrl?: string;
  readonly consoleOrigin?: string | null;
  /** Test seam: fetch used for GitHub (a local fake GitHub). */
  readonly githubFetch?: FetchFn;
  /** Plain git remotes (the master fetches objects into a bare cache): off by default (AGENTS.md rule 1). */
  readonly allowPlainGit?: boolean;
  readonly cacheDir?: string;
  /** Test seam: replaces the provider factory (e.g. local bare repositories). */
  readonly providers?: ProviderFactory;
  readonly timing?: Partial<GitFlowTiming>;
  /** p16-git-providers test seams: fetch for GitLab / Bitbucket (local fakes) and the merge status poll wait. */
  readonly gitHostFetch?: FetchFn;
  readonly gitHostPollMs?: number;
}

/** p4 orchestration settings (docs/design/p4-orchestration.md). */
export interface OrchestrationConfig {
  /** Lease-signing key; default: an ephemeral per-process key (development/tests only). */
  readonly signer?: LeaseSigner;
  /** BullMQ delivery hints on this Redis URL; null/absent = in-process hints (no BullMQ). */
  readonly redisUrl?: string | null;
  /** BullMQ key prefix (per environment / test). */
  readonly hintPrefix?: string;
  /** Relay + reconciliation loop period; 0 disables the loop (tests call tick()). Default 2 s. */
  readonly tickIntervalMs?: number;
  readonly timing?: Partial<OrchestratorTiming>;
  readonly inspector?: RemoteBranchInspector;
  readonly credentials?: GitCredentialProvider;
  /**
   * p22-git-preflight: the repository access preflight before dispatch and base ref healing of repositories without a
   * git configuration, through this (cached, anonymous) view of repositories. Absent / null: off.
   */
  readonly repoAccess?: { readonly probe: RemoteProbe } | null;
  /** p4-dag integrator merges (p4-git-flow plugs in its gateway; default: record and wait). */
  readonly merge?: MergeGateway;
  /**
   * p11-session-continuity (ADR-0042): checkpoint policy sent to capable workers; null disables it. Absent: the
   * protocol defaults.
   */
  readonly continuity?: ContinuityPolicy | null;
  /** p14-workflow-engine (ADR-0055): engine-2 flags (default off: every workflow runs on engine 1). */
  readonly workflowEngine?: { readonly v2?: boolean; readonly v2ForV1?: boolean };
  /** p17-output-limits: JOB_OUTPUT_MAX_FILES — output files per workspace job (default 500; the panel overrides it). */
  readonly outputMaxFiles?: number;
  /** p14-workflow-engine 14.2 (tests): fakes of the existing integrations behind the integration nodes. */
  readonly workflowIntegrations?: WorkflowIntegrations;
}

export interface WorkerGatewayConfig {
  readonly timing?: Partial<GatewayTiming>;
  readonly limits?: Partial<GatewayLimits>;
  readonly connectRateLimit?: ConnectRateLimit;
  /** p7-rate-limit: concurrent worker sockets per IP / total, sessions per worker id. */
  readonly connectionCaps?: ConnectionCapRule;
  readonly sessionRateLimit?: WindowRule;
  readonly pairing?: Partial<PairingPolicy>;
  /** Missed-heartbeat window before a worker is offline (default 45 s) and how often it is checked. */
  readonly heartbeatTimeoutMs?: number;
  /**
   * Background offline sweep period (default 5 s). 0 disables the background sweeper (tests that call
   * `fleetSessions.sweep()` themselves must not race a timer-driven sweep).
   */
  readonly sweepIntervalMs?: number;
  /** ADR-0005 §5 policy: rotated keys wait for an administrator (default false: old key vouches). */
  readonly rotationRequiresApproval?: boolean;
  /** Test seams: replace the Postgres-backed directory / fleet session handler. */
  readonly directory?: DeviceDirectory;
  readonly handler?: WorkerSessionHandler;
}
import { UsageStore, usageRoutes } from './usage/index.js';
import { QuotaEffects, QuotaService, QuotaStore, quotaRoutes } from './quotas/index.js';
import { QuotaSchedulingService, quotaSchedulingRoutes } from './quota-scheduling/index.js';
import { QueueService } from './queue/service.js';
import { queueRoutes } from './queue/routes.js';
import { PackageCacheService, packageCacheRoutes } from './package-caches/index.js';
import { ProjectEnvService, projectEnvRoutes } from './project-env/index.js';
import {
  GitFlowMergeGateway,
  type MergeGateway,
  WorkflowContextProvider,
  WorkflowService,
  workflowRoutes,
} from './workflows/index.js';
import { ServiceEffects, StoreContextProvider } from './orchestration/effects.js';
import { OrchestrationInbox } from './orchestration/inbox.js';
import { LeaseSigner } from './orchestration/lease-signer.js';
import {
  Orchestrator,
  type OrchestratorPause,
  type OrchestratorTiming,
} from './orchestration/orchestrator.js';
import { BullHintQueue, DirectHintQueue, type HintQueue, OutboxRelay } from './orchestration/relay.js';
import { GitLsRemoteInspector, type RemoteBranchInspector } from './orchestration/remote-branch.js';
import { jobWriteRoutes } from './orchestration/routes.js';
import { InputUploadService, inputUploadRoutes } from './input-uploads/index.js';
import { ApprovalModeService } from './approvals/mode-switch.js';
import { approvalModeRoutes } from './approvals/mode-routes.js';
import { workspaceRoutes } from './workspaces/routes.js';
import { folderRoutes } from './outputs/folder-routes.js';
import { OutputFolders } from './outputs/folders.js';
import { outputRoutes } from './outputs/routes.js';
import { OutputTree } from './outputs/tree.js';
import { previewRoutes } from './previews/routes.js';
import { serviceRoutes } from './services/routes.js';
import { ServiceRegistry } from './services/service.js';
import { WorkfilesExport } from './workfiles/export.js';
import { ChatWorkfiles } from './chat/workfiles-actions.js';
import { ChatImageTools } from './chat/image-tools.js';
import { ChatSiteCoolify } from './chat/site-coolify.js';
import { ChatSiteUploads } from './chat/site-uploads.js';
import { ChatInputUploads } from './chat/input-uploads.js';
import { workfilesRoutes } from './workfiles/routes.js';
import { codeRoutes } from './code/routes.js';
import { CodeService } from './code/service.js';
import { WorkfilesService } from './workfiles/service.js';
import { PreviewService } from './previews/service.js';
import { OutputsService } from './outputs/service.js';
import { templateRoutes, TemplateService } from './templates/index.js';
import { createProbe, type PageFetcher, type Probe } from './uptime/probe.js';
import { createWorkflowIntegrations } from './workflows/integrations.js';
import { WorkflowTriggerService } from './workflows/triggers.js';
import { WorkflowEgressService } from './workflows/egress.js';
import { workflowEgressRoutes } from './workflows/egress-routes.js';
import { SharedWorkflowService } from './workflows/sharing.js';
import { workflowSharingRoutes } from './workflows/sharing-routes.js';
import { repoEgressRoutes } from './repo-egress/routes.js';
import { RepoEgressService } from './repo-egress/service.js';
import { tlsPinRoutes } from './tls-pins/routes.js';
import { TlsPinService } from './tls-pins/service.js';
import { GitCentralService } from './git-central/service.js';
import { gitCentralRoutes } from './git-central/routes.js';
import { workflowTemplateRoutes } from './workflows/template-routes.js';
import { WorkflowAiService } from './workflows/ai.js';
import { workflowAiRoutes } from './workflows/ai-routes.js';
import type { WorkflowIntegrations } from './workflows/v2/integrations.js';
import { createProviderChecks, type ProviderChecks } from './uptime/providers.js';
import { uptimeRoutes } from './uptime/routes.js';
import { DeployHealthService, type HealthTiming } from './verify/health.js';
import { verifyRoutes } from './verify/routes.js';
import { VerificationService } from './verify/service.js';
import { VerifySettingsStore } from './verify/settings.js';
import { UptimeService } from './uptime/service.js';
import { ChatAttachments } from './chat/attachments.js';
import { ChatMentions } from './chat/mentions.js';
import { GitIdentityService, gitIdentityRoutes } from './git-identity/index.js';
import { WorkspaceService } from './workspaces/service.js';
import { StorageSweeper } from './workspaces/storage.js';
import { composerRoutes } from './composer/routes.js';
import { ResultReuseService, reuseRoutes } from './reuse/index.js';
import { RelatedContextProvider, relatedRoutes, RelatedWorkService } from './related/index.js';
import { ProjectDefaults } from './composer/defaults.js';
import { outcomesFor, RoutingService, routingRoutes } from './routing/index.js';
import { RuntimeAdviceService, runtimeAdviceRoutes } from './runtime-advice/index.js';
import { ScheduleService } from './schedules/service.js';
import {
  AutomationContextProvider,
  automationHookRoutes,
  automationRoutes,
  AutomationService,
} from './automations/index.js';
import { scheduleRoutes } from './schedules/routes.js';
import { fleetViewRoutes } from './fleetview/routes.js';
import { fleetOverview } from './fleetview/overview.js';
import { EfficiencyService, efficiencyRoutes, ReportService } from './efficiency/index.js';
import { type GitCredentialProvider, OrchestrationSessionHandler } from './orchestration/session.js';
import {
  bitbucketRepoProject,
  firstCredential,
  GitHostService,
  gitHostRoutes,
  HostedWorkerCredentials,
  createProviderFactory,
  type GitFlowTiming,
  GitFlowService,
  gitFlowRoutes,
  type FetchFn,
  type GitHubAppAuth,
  GitHubConnectService,
  githubConnectRoutes,
  GitHubWorkerCredentials,
  PANEL_KEY_REF,
  ProjectGitConfigStore,
  ProviderBranchInspector,
  type ProviderFactory,
} from './gitflow/index.js';
import { tmpdir } from 'node:os';
import { setBlobService } from './blobs/registry.js';
import { blobDownloadRoutes, blobUploadRoutes, storageRoutes } from './blobs/routes.js';
import { StorageSettings } from './blobs/settings.js';
import { ShareLinks } from './blobs/shares.js';
import { BlobService } from './blobs/store.js';
import { BlobUploads } from './blobs/uploads.js';
import {
  OUTPUT_INLINE_INFO,
  OutputLimitsService,
  type OutputServerLimits,
} from './workspaces/output-limits.js';
import { loadSubject } from './authz/authorizer.js';
import { authorize, type Role } from './authz/model.js';
import { join } from 'node:path';
import {
  CLOUDFLARE_API,
  createGuardedFetch,
  DeployFeedbackService,
  DeployOnSuccessService,
  type OpsFetch,
  OpsIntegrations,
  type OpsKind,
  type OpsLimits,
  opsRoutes,
  OpsService,
} from './ops/index.js';
import { SiteUploadService, siteUploadRoutes } from './site-uploads/index.js';
import { deployFeedbackRoutes } from './ops/feedback-routes.js';
import { CoolifyAppService } from './ops/coolify-apps.js';
import { ChatCoolify } from './chat/coolify-actions.js';
import { ChatGitHubRepo } from './chat/github-repo-actions.js';
import { ChatProjectCreate } from './chat/project-create-actions.js';
import { ChatHostRepo } from './chat/host-repo-actions.js';
import { GitHubRepoService } from './gitflow/github-repos.js';
import { githubRepoRoutes } from './gitflow/github-repo-routes.js';
import { coolifyAppRoutes } from './ops/coolify-app-routes.js';
import { coolifyResourceRoutes } from './ops/coolify-resource-routes.js';
import { CoolifyResourceService } from './ops/coolify-resources.js';
import { GitHubRepoLayout } from './ops/coolify-detect.js';
import {
  LiveBus,
  type LiveLimits,
  liveRoutes,
  LiveStore,
  LiveStreams,
  type StreamLimits,
} from './live/index.js';
import { releaseDownloadRoutes, releaseRoutes } from './releases/routes.js';
import { skillRoutes } from './skills/routes.js';
import { SkillService } from './skills/service.js';
import { GITHUB_API, type GitHubFetch, GitHubSkillSource } from './skills/github-source.js';
import { skillImportRoutes } from './skills/import-routes.js';
import { SkillImportService } from './skills/import-service.js';
import { SkillCatalogService } from './skills/catalog.js';
import { McpService } from './mcp/service.js';
import { mcpRoutes } from './mcp/routes.js';
import { installScriptRoutes } from './mcp/install-script-routes.js';
import { InstallScriptApprovals, InstallScriptCardRunner } from './mcp/install-scripts.js';
import { McpDiscovery } from './mcp/discovery.js';
import { McpPreviewService } from './mcp/previews.js';
import { mcpPreviewRoutes } from './mcp/preview-routes.js';
import type { McpFetch } from './mcp/stdio.js';
import { PanelSkillsKey } from './skills/panel-key.js';
import { MachineAdminService } from './machine-admin/service.js';
import { SubtaskService } from './subtasks/service.js';
import { IntegrationService } from './integration/service.js';
import { IntegrationMergeGateway } from './integration/gateway.js';
import { integrationRoutes } from './integration/routes.js';
import { OpsThreadService, opsThreadRoutes } from './ops-thread/index.js';
import { ChatFlowService } from './chat/flow.js';
import { ChatPlanService } from './chat/plans.js';
import { planRoutes } from './chat/plan-routes.js';
import { flowRoutes } from './chat/flow-routes.js';
import { subtaskRoutes } from './subtasks/routes.js';
import { QuestionService } from './questions/service.js';
import { questionRoutes } from './questions/routes.js';
import { machineAdminRoutes } from './machine-admin/routes.js';
import { createReleaseServices } from './releases/factory.js';
import type { ReleaseService } from './releases/service.js';
import { ReleaseUploadService } from './releases/uploads.js';
import { RolloutBreaker } from './releases/breaker.js';
import { CostBrakeService } from './ops-safety/cost-brake.js';
import { ExpiryService, type KeyFileSpec } from './ops-safety/expiry.js';
import { TurnGuard } from './ops-safety/guard.js';
import { OpsSafetyReader } from './ops-safety/index.js';
import { opsSafetyRoutes } from './ops-safety/routes.js';
import { createWebhookSender, type WebhookSender } from './webhooks-out/sender.js';
import { type WebhookOptions, WebhookService } from './webhooks-out/service.js';
import { webhookRoutes } from './webhooks-out/routes.js';
import { DoctorService } from './doctor/service.js';
import { SupportService } from './doctor/support.js';
import { doctorRoutes } from './doctor/routes.js';
import type { SmtpConfig } from './notifications/smtp.js';
import { type CertificateReader, readServedCertificate } from './ops-safety/tls.js';
import { DEFAULT_LIMITS } from './security-policy/model.js';
import { installerDownloadRoutes, installerRoutes } from './installers/routes.js';
import type { InstallerService } from './installers/service.js';
import type { ClientIpHeaderConfig } from './http/client-ip.js';
import type { MetricHistory, RecentTraces, Telemetry } from '@remyral/observability/telemetry';
import {
  chatTurnTelemetry,
  instrumentHints,
  instrumentSessionHandler,
  stepInstrument,
} from './telemetry/instrument.js';
import { DEFAULT_LOG_STORE, LogSink, LogStore, type LogStoreConfig } from './system/logs.js';
import { systemRoutes } from './system/routes.js';
import { OnboardingService } from './onboarding/service.js';
import { onboardingRoutes } from './onboarding/routes.js';
import { SetupService } from './setup/service.js';
import { setupRoutes } from './setup/routes.js';
import { UpdateFeedService } from './updates/service.js';
import {
  OwnerUpgradeService,
  ownerUpgradeRoutes,
  UpdateChannelService,
  updateChannelRoutes,
  VersionCatalogService,
} from './update-channel/index.js';
import { ConsoleDomainService } from './console-domain/service.js';
import { consoleDomainRoutes } from './console-domain/routes.js';
import type { Resolver } from './console-domain/dns.js';
import { updateRoutes } from './updates/routes.js';
import { HostActionService } from './host-actions/service.js';
import { hostActionRoutes } from './host-actions/routes.js';
import { BackupManageService } from './backups/manage.js';
import { backupManageRoutes } from './backups/manage-routes.js';
import { BackupChangeWatch } from './backups/time-lock.js';
import { mailRoutes } from './notifications/mail-routes.js';
import { UserRecoveryService } from './users/recovery.js';
import { recoveryRoutes } from './users/recovery-routes.js';
import { KeyRotationService, keyRoutes } from './panel-settings/keys.js';
import { MaintenanceService } from './maintenance/service.js';
import { maintenanceRoutes } from './maintenance/routes.js';
import { workflowCheckRoutes } from './panel-settings/workflow-check.js';
import { checkStoredDefinitions } from './workflows/v2/normalise-check.js';
import { createHash, createPrivateKey } from 'node:crypto';
import { actorOf } from './workers/routes.js';
import {
  DynamicSmtpNotifier,
  DynamicWebhookNotifier,
  MailSettings,
  type WebhookSettings,
} from './notifications/dynamic.js';
import { type VapidKeys, vapidKeysFromPem } from './notifications/push/webpush.js';
import type { PushVapid } from './notifications/service.js';
import { panelEnvFrom, type PanelEnvDeps } from './panel-settings/env.js';
import { panelSettingsRoutes, type PanelRouteHooks } from './panel-settings/routes.js';
import { PanelSettingsService } from './panel-settings/service.js';
import {
  LiveSet,
  listOf,
  liveList,
  networkClientIp,
  networkRules,
  notificationRules,
  searchRules,
  sessionRules,
  workflowRules,
} from './panel-settings/consumers.js';
import { HttpError } from './http/errors.js';
import type { SettingValue } from './panel-settings/registry.js';
import { clientIpUnder } from './http/client-ip.js';
import { SystemStatusService } from './system/status.js';
import { MasterMetrics } from './telemetry/metrics.js';
import { type AlertEvent, AlertEvaluator, type AlertThresholds } from './alerts/index.js';
import { AgentMagnifyForwarder } from './integrations/agentmagnify.js';
import { CoolifyGate, OidcProvider, Sealer, type SsoConfig, ssoRoutes } from './oidc/index.js';
import {
  BedrockEmbedder,
  BedrockIntegration,
  bedrockRoutes,
  type Embedder,
  HttpEmbedder,
  type SearchEnvMode,
  SearchService,
  searchRoutes,
} from './search/index.js';
import { MemorySuggestionService, memorySuggestionRoutes } from './memory-suggestions/index.js';
import { MemoryRecordService, memoryRecordRoutes } from './memory-records/index.js';
import { MemoryImportService, memoryImportRoutes } from './memory-import/index.js';
import { IdeAccess } from './ide/access.js';
import { ideProxyRoutes } from './ide/proxy.js';
import { ideRoutes } from './ide/routes.js';
import { ideExtensionRoutes, ideWorkerDownloadRoutes } from './ide/extension-routes.js';
import { IdeExtensions } from './ide/extensions.js';
import { createGuardedWebFetch } from './ops/web-fetch.js';
import { OpenVsxClient } from './ide/openvsx.js';
import { IdeService } from './ide/service.js';
import { TunnelRegistry } from './ide/tunnel.js';
import { ChatKnowledge, SemanticDefaultsService, semanticDefaultsRoutes } from './search/index.js';
import {
  type NotificationOptions,
  NotificationService,
  notificationRoutes,
  type Notifier,
  type PushChannelDeps,
} from './notifications/index.js';

export interface NotificationsDeps {
  /** Configured outbound channels (none: in-app only). */
  readonly notifiers?: readonly Notifier[];
  readonly publicUrl?: string;
  /** Background producer/delivery interval (0 or unset: no loop, e.g. tests call runOnce()). */
  readonly intervalMs?: number;
  readonly options?: Partial<NotificationOptions>;
  /** p8-pwa: Web Push (VAPID keys + subject); absent = push unavailable (unless the panel configures it). */
  readonly push?: PushDeps | undefined;
  /** p17-panel-settings (tests): seams of the panel-configured webhook channel (a loopback http receiver). */
  readonly webhookTestSeams?: { readonly allowInsecureHttp?: boolean; readonly fetchImpl?: typeof fetch };
}

/** p8-pwa: the push channel's VAPID configuration (main.ts reads the key file). */
export type PushDeps = NonNullable<PushChannelDeps['vapid']>;

export interface MasterDeps {
  readonly pool: Pool;
  readonly redis: RedisClient;
  readonly box: SecretBox;
  readonly logLevel: LogLevel;
  readonly trustProxyHops: number;
  readonly clientIpHeader?: ClientIpHeaderConfig;
  readonly bodyLimitBytes: number;
  readonly logStream?: NodeJS.WritableStream;
  /** Test seams. */
  readonly clock?: () => Date;
  readonly passwordParams?: ScryptParams;
  readonly totpSecretFactory?: () => Buffer;
  readonly limiter?: RateLimiter;
  readonly rateLimits?: RateLimits;
  readonly rateLimitPrefix?: string;
  /** p5-remember-device: remember-me / trusted-device lifetimes (default 7 d idle / 30 d, 30 d). */
  readonly loginPersistence?: LoginPersistencePolicy;
  /**
   * p17-panel-settings: the environment's values that only main.ts knows (webhook / push channels, the HTTP search
   * provider) and the secrets read from their files; the panel overrides them.
   */
  readonly panelEnv?: PanelEnvDeps;
  /** p5-stepup-window: step-up windows per session type (default 10 min / whole long-lived session). */
  readonly stepUp?: StepUpPolicy;
  /** p15-autonomy: how long the security policy is cached per process (default 5 s; tests use 0). */
  readonly securityPolicyCacheMs?: number;
  /** p7-rate-limit: central request budgets per route class (default DEFAULT_REQUEST_LIMITS). */
  readonly requestLimits?: RequestLimitPolicy;
  /** p16-api-tokens: per-token budgets and concurrency (default TOKEN_REQUEST_LIMITS). */
  readonly tokenLimits?: TokenLimitPolicy;
  /** p16-api-tokens: flush interval of token use counters (default 60 s; 0 = no timer, tests flush). */
  readonly tokenUsageFlushMs?: number;
  /** p7-rate-limit: slow-request timeouts (default SLOW_REQUEST_TIMEOUTS). */
  readonly httpTimeouts?: Partial<SlowRequestTimeouts>;
  readonly extraRoutes?: readonly RoutePlugin[];
  /** Expire/cancel stale approval requests this often (0 or unset: no background sweeper, e.g. tests). */
  readonly approvalSweepIntervalMs?: number;
  /** Hard-purge expired soft-deleted context documents this often (0 or unset: no sweeper). */
  readonly contextPurgeIntervalMs?: number;
  /** p5-search-audit: per-user export/verify rate limits and export size limits (test seams). */
  readonly accessLimits?: AccessLimits;
  readonly exportLimits?: { readonly maxRecords?: number; readonly maxBytes?: number };
  /** p5-rbac authorization matrix test seam (see AppOptions.authzProbe). Never set in production. */
  readonly authzProbe?: boolean;
  readonly workers?: WorkerGatewayConfig;
  readonly orchestration?: OrchestrationConfig;
  /** p2-signed-updates: release public keys (RELEASE_PUBLIC_KEYS) and download rate limit. */
  /** p5-remote-ops: per-worker / per-user operation limits (tests tighten them). */
  readonly remoteOpsLimits?: RemoteOpsLimits;
  readonly releases?: {
    readonly publicKeys?: readonly string[];
    readonly downloadRateLimit?: { readonly perIp: number; readonly windowMs: number };
    /** p6-release-upload: sweep expired chunked uploads this often (default 10 min; 0 = no timer). */
    readonly uploadSweepIntervalMs?: number;
    /**
     * p6-release-import: check the channels for changes made outside this process (host-side
     * `release-import --rollout`, another replica) and offer them to connected workers (default 30 s; 0 = no timer).
     */
    readonly channelPollIntervalMs?: number;
  };
  /** p19-ide W2: the IDE origin (IDE_ORIGIN; null / absent: Tam IDE is not configured). */
  readonly ide?: {
    readonly origin: string | null;
    /** p19-ide W3: the Open VSX client (tests inject one with a fake registry). */
    readonly openVsx?: OpenVsxClient;
  };
  /** p5-worker-onboarding: Fleet → Add machine (PUBLIC_ORIGIN, INSTALLER_PUBLIC_DOWNLOADS). */
  readonly installers?: {
    readonly publicOrigin?: string | null;
    readonly publicDownloads?: boolean;
    readonly downloadRateLimit?: { readonly perIp: number; readonly windowMs: number };
  };
  /** p6-skills: skills public keys (SKILLS_PUBLIC_KEYS). Empty/unset: uploads refused, jobs get no skills. */
  readonly skills?: {
    readonly publicKeys?: readonly string[];
    /** p5-machine-admin: the panel-held skills key (SKILLS_PANEL_KEY_FILE). */
    readonly panelKey?: PanelSkillsKey | null;
    /** p14-skill-import: fetch for GitHub imports (api.github.com only); null / absent: GitHub import off. */
    readonly githubFetch?: GitHubFetch | null;
  };
  /** p14-mcp-chat: registry fetch for MCP discovery and package lookups (tests); absent: the global fetch. */
  readonly mcp?: { readonly registryFetch?: McpFetch | null };
  readonly notifications?: NotificationsDeps;
  readonly gitflow?: GitFlowConfig;
  readonly live?: LiveConfig;
  /** p6-otel: traces/metrics (docs/design/p6-observability.md); absent = no instrumentation. */
  readonly telemetry?: Telemetry;
  /**
   * p16-observability (docs/design/p16-observability.md): the status page, the log search and the recent traces.
   * `logSink` is the capture queue `redactingLogStream` feeds (main.ts); without it the log search answers "off".
   */
  readonly observability?: {
    readonly logSink?: LogSink;
    readonly logStore?: LogStoreConfig;
    /** Flush / purge periods of the log store (default 1 s / 10 min; 0 = no timer, tests call flush / purge). */
    readonly logFlushMs?: number;
    readonly logPurgeMs?: number;
    readonly recentTraces?: RecentTraces | null;
    readonly history?: MetricHistory | null;
    /** Sampling period of the metric history (default 60 s; 0 = no timer, tests call sample()). */
    readonly historyIntervalMs?: number;
    readonly releaseTag?: string | null;
    readonly webUrl?: string | null;
    readonly webFetch?: (url: string, init: RequestInit) => Promise<Response>;
    readonly diskPaths?: { readonly data: string | null; readonly root: string | null };
    readonly statusCacheMs?: number;
    /** Status thresholds (queue backlog seconds, disk warning / failing percent); defaults 300 / 85 / 95. */
    readonly statusThresholds?: {
      readonly queueSec?: number;
      readonly diskWarn?: number;
      readonly diskFail?: number;
    };
  };
  /** ADR-0023: run the OpenHands retirement step when the app is ready (default true; tests may turn it off). */
  readonly retireRuntimes?: boolean;
  /** p6-alerts: evaluation period (0/unset: no loop, tests call `app.alerts.evaluate()`), thresholds, listeners. */
  readonly alerts?: {
    readonly intervalMs?: number;
    readonly thresholds?: Partial<AlertThresholds>;
    readonly cooldownMs?: number;
    /** p22-ops-hygiene: how long a condition stays clear before its alert resolves (default 15 min; 0: at once). */
    readonly resolveAfterMs?: number;
    readonly listeners?: readonly ((e: AlertEvent) => void)[];
  };
  /** p10-backup-restore: status directory of the backup service (absent/null: "not configured"). */
  readonly backups?: { readonly statusDir: string | null; readonly intervalMs?: number };
  /**
   * p17-object-storage: the local blob directory (BLOB_DATA_DIR; default: a directory below the OS temp dir, for tests)
   * and test seams of the S3 client (an extra CA, a timeout) and the settings cache.
   */
  readonly blobs?: {
    readonly dataDir?: string;
    readonly s3?: { readonly ca?: string | Buffer; readonly timeoutMs?: number };
    readonly settingsTtlMs?: number;
  };
  /**
   * p17-domain-wizard (ADR-0063 amendment 2026-10-24): the console's public address — the directory shared with a
   * remyral-ctl host applier (HOST_APPLIER_DIR; absent / null: setting only) and test seams (DNS resolver, timings).
   */
  readonly consoleDomain?: {
    readonly hostDir?: string | null;
    readonly resolver?: Resolver;
    readonly heartbeatMaxAgeMs?: number;
    readonly requestTtlMs?: number;
    readonly applyingTimeoutMs?: number;
  };
  /**
   * p16-selfhost-onboarding (ADR-0063): the installed version and the signed update feed (absent: not configured —
   * the banner stays off). `intervalMs` / `fileIntervalMs`: refresh periods (tests call `app.updates.refresh()`).
   */
  readonly updates?: {
    readonly currentVersion: string | null;
    readonly keys: readonly string[];
    readonly feedUrl: string | null;
    readonly feedFile: string | null;
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
    readonly intervalMs?: number;
    readonly fileIntervalMs?: number;
  };
  /**
   * p17-update-channel (ADR-0065): the worker release feed and the version catalog (sources null: not configured).
   * `intervalMs` / `fileIntervalMs` / `retryMs`: periods (tests call `app.updateChannel.tick()`).
   */
  readonly updateChannel?: {
    readonly feedUrl: string | null;
    readonly feedFile: string | null;
    readonly catalogUrl: string | null;
    readonly catalogFile: string | null;
    readonly catalogKeys: readonly string[];
    readonly catalog: boolean;
    readonly fetch?: (url: string, init: RequestInit) => Promise<Response>;
    readonly intervalMs?: number;
    readonly fileIntervalMs?: number;
    readonly retryMs?: number;
  };
  /** p6-agentmagnify: disabled when absent. `intervalMs` 0/unset: no loop (tests call runOnce()). */
  readonly agentmagnify?: {
    readonly apiUrl: string;
    readonly token: string;
    readonly projectName?: string;
    readonly intervalMs?: number;
    readonly fetch?: typeof fetch;
  };
  /**
   * p6-vector: optional semantic search. Absent (the default): no provider — the routes answer 409
   * search_unavailable and consent cannot be enabled. `intervalMs` 0/unset: no indexer loop (tests call
   * `app.semanticSearch.sync()`).
   */
  readonly search?: {
    /** The provider built from env (SEARCH_PROVIDER); null: none from env. */
    readonly embedder: Embedder | null;
    readonly intervalMs?: number;
    readonly searchesPerMinute?: number;
    /**
     * p10-bedrock-integration-panel: SEARCH_PROVIDER as configured. Default: derived from `embedder` (`unset` when
     * null, else its provider label). `off` is the kill switch (the panel is ignored).
     */
    readonly envMode?: SearchEnvMode;
    /** With an env Bedrock provider: keys in the environment (`environment`, default) or none (`instance role`). */
    readonly envCredentialSource?: 'environment' | 'instance role';
    /** Tests: fake Bedrock endpoint for the panel's provider and its connection test. */
    readonly bedrockEndpoint?: string;
    readonly bedrockTestTimeoutMs?: number;
  };
  /**
   * p10-semantic-memory: the memory-suggestion pass over finished jobs of opted-in projects. `intervalMs` 0/unset: no
   * loop (tests call `app.memorySuggestions.pass()`).
   */
  readonly memorySuggestions?: {
    readonly intervalMs?: number;
    readonly duplicateThreshold?: number;
    /** p10-chat-memory-suggestions: chat-pass suggestions per thread per day (default 5, 0 = chat not read). */
    readonly chatPerThreadPerDay?: number;
    /** p17-auto-learning: false turns automatic acceptance and merging off (MEMORY_AUTO_LEARN=off; default on). */
    readonly autoLearn?: boolean;
  };
  /**
   * p17-embeddings: `enabled` false = RELATED_WORK=off (similar jobs, solved failures, duplicate checks and the context
   * block all off); `context` false = RELATED_WORK_CONTEXT=off (only the block in job contexts). Default: both on. The
   * indexer pass runs on the search indexer's interval.
   */
  readonly relatedWork?: { readonly enabled?: boolean; readonly context?: boolean };
  /**
   * p10-semantic-defaults-chat. `backfillOnStart`: turn project knowledge on for existing projects that never made a
   * choice, once (main.ts: true; tests call `app.semanticDefaults.backfill()`). The chat pass runs on the search
   * indexer's interval. `related*`: the per-turn related-knowledge bounds.
   */
  readonly semanticDefaults?: {
    readonly backfillOnStart?: boolean;
    readonly relatedMinScore?: number;
    readonly relatedLimit?: number;
    readonly relatedMaxBytes?: number;
  };
  /** Transition tailer period (default 5 s; 0 = no loop, tests call `app.metrics.tailTransitions()`). */
  readonly metricsTailIntervalMs?: number;
  /** p5-coolify-sso: OIDC provider for Coolify and the forward-auth gate (absent: routes answer 404). */
  readonly sso?: SsoConfig;
  /** p5-ops-chat: sweep period, turn timeout, stream limits. */
  readonly chat?: ChatConfig;
  /** p6-deploy-integrations (ADR-0028): Coolify / Cloudflare ops actions. */
  readonly ops?: OpsConfig;
  /** p8-uptime: test seams (probe, provider checks, exact origins exempt from the SSRF guard) and limits. */
  readonly uptime?: UptimeConfig;
  /**
   * p13-fleet-tools: `fetch` reads the version feeds (null / absent: feeds off — tests and offline masters); `feedTtlMs`
   * how often (default 6 h).
   */
  readonly fleetTools?: { readonly fetch?: FeedFetch | null; readonly feedTtlMs?: number };
  /**
   * p16-ops-safety: keys and expiry (public origin, key files, TLS reader seam, check period), the cost brake's cache
   * and the background pass (expiry checks + notices, cost brake crossings, rollout breaker; 0 = off, tests drive it).
   */
  readonly opsSafety?: {
    readonly publicOrigin?: string | null;
    readonly keyFiles?: readonly KeyFileSpec[];
    readonly readCertificate?: CertificateReader;
    readonly mtime?: (path: string) => Promise<Date | null>;
    readonly checkEveryMs?: number;
    readonly brakeCacheMs?: number;
    readonly intervalMs?: number;
  };
  /** p10-verify-health: test seams (guarded page fetcher, retry timing); the SSRF exceptions are uptime's. */
  readonly verify?: VerifyConfig;
  /**
   * p16-webhooks-out: outgoing webhooks — the producer / deliverer pass (0 or unset: no loop; tests call runOnce()),
   * options (retry schedule, jitter, auto-disable threshold) and test seams (the sender, a jitter source).
   */
  readonly webhooksOut?: {
    readonly intervalMs?: number;
    readonly sender?: WebhookSender;
    readonly options?: Partial<WebhookOptions>;
    readonly random?: () => number;
  };
  /**
   * p16-doctor: diagnostics and the support report — the daily pass (0 or unset: no loop; tests call daily()), the
   * master configuration (only allowlisted keys reach the report), the notification SMTP (the support mail's fallback
   * sender) and test seams (extra SMTP trust anchors, timeouts, caps, the machines' wait, the migrations directory).
   */
  readonly doctor?: {
    readonly intervalMs?: number;
    readonly config?: unknown;
    readonly notificationSmtp?: SmtpConfig | null;
    readonly smtpCa?: string | Buffer;
    readonly smtpTimeoutMs?: number;
    readonly maxAttachmentBytes?: number;
    readonly maxLogLines?: number;
    readonly workerWaitMs?: number;
    readonly dailyEveryMs?: number;
    readonly migrationsDir?: string;
  };
}

/** p10-verify-health settings (test seams only). */
export interface VerifyConfig {
  readonly probe?: Probe & PageFetcher;
  readonly timing?: Partial<HealthTiming>;
}

/** p8-uptime settings (test seams only: production uses the guarded probe and the ops integrations). */
export interface UptimeConfig {
  readonly probe?: Probe;
  readonly providers?: ProviderChecks;
  /** Exact `scheme://host:port` / `tcp://host:port` the probe may reach although not public (tests). */
  readonly allowOrigins?: readonly string[];
  readonly limits?: Partial<{ perProject: number; total: number; concurrency: number }>;
}

/** p6-deploy-integrations settings (OPS_* env; test seams). */
export interface OpsConfig {
  /** Exact origins the ops HTTP client may reach over http / private addresses (OPS_INTERNAL_ORIGINS). */
  readonly internalOrigins?: readonly string[];
  readonly controlPlaneResources?: readonly string[];
  readonly controlPlaneAddresses?: readonly string[];
  /** Host names protected like the console host (OPS_PROTECTED_HOSTS; default none). */
  readonly protectedHosts?: readonly string[];
  /** Cloudflare API base (default https://api.cloudflare.com/client/v4; tests: a local fake). */
  readonly cloudflareApi?: string;
  /** Test seam: replaces the guarded HTTP client. */
  readonly fetch?: OpsFetch;
  readonly limits?: Partial<OpsLimits>;
}

/** p5-live settings (docs/design/p5-live.md). */
export interface LiveConfig {
  readonly limits?: Partial<LiveLimits>;
  readonly stream?: Partial<StreamLimits>;
  /** Retention of live rows of ended jobs (days; default 30) and the sweep period (0/unset: no sweeper). */
  readonly retentionDays?: number;
  readonly sweepIntervalMs?: number;
}

/** Wires the production object graph; used by main.ts and by the integration tests. */
export async function createMasterApp(deps: MasterDeps): Promise<FastifyInstance> {
  const clock = deps.clock ?? (() => new Date());
  const audit = new AuditLog(deps.pool, clock);
  // p17-panel-settings: master-stored settings over the environment (read at use time; reloaded by the tick).
  const panelSettings = new PanelSettingsService({
    pool: deps.pool,
    audit,
    clock,
    sealKey: deps.box.deriveKey('panel-settings'),
    env: panelEnvFrom({
      trustProxyHops: deps.trustProxyHops,
      clientIpHeader: deps.clientIpHeader ?? null,
      ...(deps.loginPersistence === undefined ? {} : { loginPersistence: deps.loginPersistence }),
      ...(deps.workers?.rotationRequiresApproval === undefined
        ? {}
        : { rotationRequiresApproval: deps.workers.rotationRequiresApproval }),
      ...(deps.orchestration?.timing?.loginWaitMs === undefined
        ? {}
        : { loginWaitMs: deps.orchestration.timing.loginWaitMs }),
      ...(deps.observability?.logStore === undefined ? {} : { logStore: deps.observability.logStore }),
      ...(deps.memorySuggestions === undefined ? {} : { memory: deps.memorySuggestions }),
      ...(deps.orchestration?.workflowEngine === undefined
        ? {}
        : { workflowEngine: deps.orchestration.workflowEngine }),
      ...(deps.ops === undefined ? {} : { ops: deps.ops }),
      ...(deps.orchestration?.outputMaxFiles === undefined
        ? {}
        : { outputMaxFiles: deps.orchestration.outputMaxFiles }),
      ...(deps.panelEnv?.values === undefined ? {} : { extra: deps.panelEnv.values }),
    }),
    ...(deps.panelEnv?.secrets === undefined ? {} : { envSecrets: deps.panelEnv.secrets }),
  });
  await panelSettings.load();
  const stepUpPolicy = deps.stepUp ?? DEFAULT_STEP_UP_POLICY;
  // p15-autonomy (ADR-0056): the owner-configurable security policy (step-up window, per-event codes, autonomy).
  let securityLog: FastifyBaseLogger | null = null;
  const securityPolicy = new SecurityPolicyService({
    pool: deps.pool,
    audit,
    clock,
    ...(deps.securityPolicyCacheMs === undefined ? {} : { cacheMs: deps.securityPolicyCacheMs }),
    onInvalid: (err) => {
      securityLog?.error({ err }, 'security policy unreadable; the strict preset applies');
    },
  });
  // p16-zip-job-input (ADR-0060): job input bundles (a .zip unpacked in the browser, pulled into a job's in/).
  const inputUploads = new InputUploadService({
    pool: deps.pool,
    audit,
    clock,
    allowExecutables: async () => (await securityPolicy.current()).inputs.executables,
  });
  const limiter = deps.limiter ?? new RedisRateLimiter(deps.redis, deps.rateLimitPrefix);
  const inboxRetention = new WorkerInboxRetention({ db: deps.pool, clock });
  // p22-ops-hygiene: the shared dependency-health gate (created with the app's logger after buildApp). Background
  // sweeps go through it: a Redis / Postgres outage is one warning and one recovery line, sweeps that need the
  // missing dependency skip (one debug line) until a probe says it answers again.
  let dependencyHealth: DependencyHealth | null = null;
  const gated = <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> =>
    dependencyHealth === null ? fn() : dependencyHealth.run(name, fn);
  const gatedError =
    (name: string, fallback: (err: unknown) => void) =>
    (err: unknown): void => {
      if (dependencyHealth === null) fallback(err);
      else dependencyHealth.onError(name, fallback)(err);
    };
  // p17-object-storage: job outputs and other blobs in object storage or the local blob directory (never Postgres).
  let blobLog: FastifyBaseLogger | null = null;
  const blobLogger = {
    warn: (o: Record<string, unknown>, m: string): void => blobLog?.warn(o, m),
    error: (o: Record<string, unknown>, m: string): void => blobLog?.error(o, m),
  };
  const blobService = new BlobService({
    pool: deps.pool,
    box: deps.box,
    clock,
    audit,
    log: blobLogger,
    localDir: deps.blobs?.dataDir ?? join(tmpdir(), 'remyral-blobs'),
    ...(deps.blobs?.s3 === undefined ? {} : { s3: deps.blobs.s3 }),
    ...(deps.blobs?.settingsTtlMs === undefined ? {} : { settingsTtlMs: deps.blobs.settingsTtlMs }),
  });
  setBlobService(blobService);
  const storageSettings = new StorageSettings({ blobs: blobService, audit, clock, pool: deps.pool });
  const blobUploads = new BlobUploads({ pool: deps.pool, blobs: blobService, audit, clock, log: blobLogger });
  // p17-output-limits: output files per workspace job (panel jobs.outputMaxFiles → JOB_OUTPUT_MAX_FILES → 500).
  const outputLimits = new OutputLimitsService({
    pool: deps.pool,
    serverMaxFiles: () => panelSettings.get<number>('jobs.outputMaxFiles', OUTPUT_LIMITS.defaultMaxFiles),
  });
  /** p17-output-limits: the server's output limits and whether the blob store is usable now (settings views). */
  const outputServer = async (): Promise<OutputServerLimits> => {
    const [info, limits] = await Promise.all([blobService.modeInfo(), blobService.limits()]);
    return {
      maxFiles: outputLimits.serverMaxFiles(),
      maxJobBytes: limits.maxJobBytes,
      maxFileBytes: limits.maxFileBytes,
      thresholdBytes: limits.thresholdBytes,
      storage: info.mode === 's3' && info.s3Error !== null ? 'unavailable' : info.mode,
    };
  };
  const shareLinks = new ShareLinks({ pool: deps.pool, blobs: blobService, audit, clock });
  // The blob GC runs as a tick step at most every 10 minutes (bounded passes; failures stay for the next pass).
  let lastBlobGc = Number.NEGATIVE_INFINITY;
  const blobGc = async (): Promise<number> => {
    const now = clock().getTime();
    if (now - lastBlobGc < 10 * 60_000) return 0;
    lastBlobGc = now;
    return (await blobService.gc()).deleted;
  };
  // p16-api-tokens (ADR-0058): personal tokens and service accounts; hashes keyed with an HKDF sub-key of the master key.
  const apiTokens = new ApiTokenService({
    pool: deps.pool,
    audit,
    hashKey: deps.box.deriveKey('api-token'),
    securityPolicy,
    clock,
  });
  let tokenLog: FastifyBaseLogger | null = null;
  let tokenWarnAt = Number.NEGATIVE_INFINITY;
  const tokenWarn = (what: string) => (err: unknown) => {
    const t = Date.now();
    if (t - tokenWarnAt < 60_000) return;
    tokenWarnAt = t;
    tokenLog?.warn({ errName: err instanceof Error ? err.name : 'error' }, what);
  };
  const tokenUsage = new TokenUsageCounter(
    apiTokens,
    tokenWarn('api token usage flush failed'),
    deps.tokenUsageFlushMs,
  );
  const service = new AuthService({
    pool: deps.pool,
    audit,
    box: deps.box,
    limiter,
    clock,
    ...(deps.passwordParams ? { passwordParams: deps.passwordParams } : {}),
    ...(deps.totpSecretFactory ? { totpSecretFactory: deps.totpSecretFactory } : {}),
    // p17-panel-settings: remember-me / trusted-device lifetimes from the panel (default: the environment).
    persistence: () =>
      ['auth.trustedDeviceDays', 'auth.rememberIdleDays', 'auth.rememberAbsoluteDays'].some(
        (k) => panelSettings.source(k) === 'panel',
      )
        ? loginPersistenceFromDays({
            trustedDeviceDays: panelSettings.get<number>('auth.trustedDeviceDays', 30),
            rememberIdleDays: panelSettings.get<number>('auth.rememberIdleDays', 7),
            rememberAbsoluteDays: panelSettings.get<number>('auth.rememberAbsoluteDays', 30),
          })
        : (deps.loginPersistence ?? DEFAULT_LOGIN_PERSISTENCE),
    stepUp: stepUpPolicy,
    ...(deps.rateLimits ? { rateLimits: deps.rateLimits } : {}),
  });
  // p14-i18n-foundation (ADR-0053): the per-user console language.
  const userLocales = new UserLocaleService({ pool: deps.pool, audit });
  const userThemes = new UserThemeService({ pool: deps.pool, audit });
  // p20-decisions: the put-off / ignored decisions of each person (badge, home and /needs on every device).
  const decisionDeferrals = new DecisionDeferralService({ pool: deps.pool, audit, now: clock });
  let routingLog: FastifyBaseLogger | null = null;
  const jobs = new JobStore({
    pool: deps.pool,
    audit,
    clock,
    // p6-smart-routing: the job_stats rollup is advisory; a failure is logged, the transition still commits.
    onStatsError: (err, jobId) => routingLog?.warn({ err, jobId }, 'job_stats rollup update failed'),
  });
  // p15-job-titles: editable short job titles (job_titles) and the back-fill of older jobs.
  const jobTitles = new JobTitles({ pool: deps.pool, audit, clock });
  let gitflow: GitFlowService | null = null;
  // p15-auto-mode: automatic retries of transient failures (inbox, git flow verification, lost attempts).
  const autoRetry = new AutoRetryService({ audit, securityPolicy, clock });
  let selfHeal: SelfHealService | null = null;
  // p22-conflict-resolve: conflicting verified results carried onto the target by one follow-up job.
  let conflictResolve: ConflictResolveService | null = null;
  // p6-result-reuse: read-only lookup of an identical finished job (composer / chat offers, opt-in policies).
  const resultReuse = new ResultReuseService({
    db: deps.pool,
    clock,
    baseCommit: (project, repository) =>
      gitflow === null ? Promise.resolve(null) : gitflow.resolveBaseCommit(project, repository),
  });
  // p5-research-workspace: settings, inputs and artifacts of workspace projects (needs the app logger).
  let workspaces: WorkspaceService | null = null;
  // p10-approval-pause: long in-run approval waits → stale → paused (slot freed, workspace kept) → resumed.
  const approvalPause = new ApprovalPauseService({
    pool: deps.pool,
    audit,
    jobs,
    replay: () => requireSessions().replay,
    clock,
    dispatch: (jobId) => {
      void orchestrator?.dispatch(jobId).catch(() => undefined);
    },
  });
  const approvals = new ApprovalService({
    pool: deps.pool,
    audit,
    jobs,
    clock,
    // p15-autonomy: master approvals of "never ask" jobs that pass by the security policy.
    securityPolicy,
    gateHook: () => gitflow,
    pauseHook: () => approvalPause,
  });
  const gf = deps.gitflow ?? {};
  // Live map: `default` from the key file, `panel` added/replaced/removed by Settings → Integrations (p5-github-connect).
  const githubApps = new Map<string, GitHubAppAuth>(gf.githubApps ?? []);
  // Assigned in beforeRoutes (needs the app logger); the cast keeps the type wide for the checks after buildApp.
  let githubConnect = null as GitHubConnectService | null;
  // Administrator-configured outbound destinations (self-managed GitLab, Open VSX registry) go through the egress
  // guard; the operator's `ops.internalOrigins` are the exact origins allowed on a private address.
  const egressInternalOrigins = new LiveSet(() => listOf(panelSettings, 'ops.internalOrigins'));
  const gitHostFetch =
    gf.gitHostFetch ??
    createGuardedWebFetch({ redirects: 'same-origin', internalOrigins: egressInternalOrigins });
  // p16-git-providers (ADR-0061): master-held GitLab / Bitbucket tokens (encrypted; never returned or logged).
  const gitHosts = new GitHostService({
    pool: deps.pool,
    audit,
    clock,
    box: deps.box,
    fetch: gitHostFetch,
  });
  const providers =
    gf.providers ??
    createProviderFactory({
      githubApps,
      ...(gf.githubFetch === undefined ? {} : { githubFetch: gf.githubFetch }),
      plainGit: {
        enabled: gf.allowPlainGit === true,
        cacheDir: gf.cacheDir ?? join(tmpdir(), `remyral-gitflow-${String(process.pid)}`),
      },
      gitHosts,
      gitHostFetch,
      ...(gf.gitHostPollMs === undefined ? {} : { gitHostPollMs: gf.gitHostPollMs }),
    });
  const gitConfigs = new ProjectGitConfigStore({
    pool: deps.pool,
    audit,
    clock,
    policy: {
      githubAppId: (keyRef) => githubApps.get(keyRef)?.appId,
      defaultKeyRef: () =>
        githubConnect?.defaultKeyRef() ?? (githubApps.has(PANEL_KEY_REF) ? PANEL_KEY_REF : 'default'),
      checkInstallation: (keyRef, installationId) =>
        githubConnect === null
          ? Promise.resolve(null)
          : githubConnect.checkInstallation(keyRef, installationId),
      githubHost: gf.githubHost ?? 'github.com',
      allowPlainGit: gf.allowPlainGit === true || gf.providers !== undefined,
      hostConnection: async (id) => {
        try {
          return await gitHosts.ref(id);
        } catch {
          return null;
        }
      },
      checkHostRepository: async (conn, repoPath) => {
        if (conn.kind !== 'bitbucket' || conn.tokenKind !== 'project') return null;
        const key = await bitbucketRepoProject(
          conn,
          await gitHosts.apiToken(conn.id),
          repoPath,
          gitHostFetch,
        );
        return key === null ? null : key.toLowerCase() === (conn.scope.split('/')[1] ?? '').toLowerCase();
      },
    },
  });
  const policies = new ProjectPolicyStore({ pool: deps.pool, audit, clock });
  const context: ContextStore = new ContextStore({
    pool: deps.pool,
    audit,
    clock,
    // p11-memory-layers: memories most relevant to the job prompt win the budget (semantic search, when consented).
    relevance: (project: string, prompt: string): Promise<ReadonlyMap<string, number> | null> =>
      search.promptRelevance(project, prompt),
  });
  // p17-panel-settings Part 5: the skills panel key the master generated (sealed in the panel settings), else
  // SKILLS_PANEL_KEY_FILE; earlier panel keys stay trusted until the owner retires them.
  const envPanelKey = deps.skills?.panelKey ?? null;
  let panelKeyCache: { pem: string; key: PanelSkillsKey } | null = null;
  const currentPanelKey = (): PanelSkillsKey | null => {
    const pem =
      panelSettings.secretSource('skills.panelKey') === 'panel'
        ? panelSettings.secret('skills.panelKey')
        : null;
    if (pem === null) return envPanelKey;
    if (panelKeyCache?.pem !== pem) {
      try {
        panelKeyCache = { pem, key: new PanelSkillsKey(createPrivateKey(pem)) };
      } catch {
        panelKeyCache = null;
      }
    }
    return panelKeyCache?.key ?? envPanelKey;
  };
  const retiredPanelKeys = (): readonly string[] => listOf(panelSettings, 'skills.panelKeyRetired');
  const panelSkillKeysNow = (): readonly string[] => {
    const k = currentPanelKey();
    return [...new Set([...(k === null ? [] : [k.publicKey]), ...retiredPanelKeys()])];
  };
  const skills = new SkillService({
    pool: deps.pool,
    audit,
    context,
    publicKeys: deps.skills?.publicKeys ?? [],
    panelKey: currentPanelKey,
    retiredPanelKeys,
    clock,
    // p14-skill-import: every panel-signed publish is a critical notification to the owners.
    notify: () => notifications,
  });
  const skillGithubFetch = deps.skills?.githubFetch ?? null;
  // A private repository: the panel GitHub App's read-only token, when the App is installed there.
  // p17-chat-github: every connected App is asked (panel Apps first); a panel App mints only for accepted installations.
  const panelRepoToken = async (owner: string, repo: string): Promise<string | null> => {
    const apps = [...githubApps]
      .sort(([a], [b]) => (a === PANEL_KEY_REF ? -1 : b === PANEL_KEY_REF ? 1 : a.localeCompare(b)))
      .map(([, a]) => a);
    for (const app of apps) {
      if (app.apiBaseUrl !== GITHUB_API) continue;
      try {
        const inst = await app.appRequest(
          'GET',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/installation`,
        );
        const id = (inst.json as { id?: unknown } | null)?.id;
        if (inst.status !== 200 || typeof id !== 'number') continue;
        const t = await app.installationToken(id, repo, { contents: 'read', metadata: 'read' });
        return t.token;
      } catch {
        // the next App
      }
    }
    return null;
  };
  const skillGithub =
    skillGithubFetch === null
      ? null
      : new GitHubSkillSource({ fetch: skillGithubFetch, token: panelRepoToken });
  // p15-coolify-create: the build suggestion reads the repository root through the same fetch and token.
  const coolifyLayout =
    skillGithubFetch === null
      ? null
      : new GitHubRepoLayout({ fetch: skillGithubFetch, token: panelRepoToken });
  // p14-skill-catalogs: configured catalog repositories (listing cached on the master, imports pinned to its commit).
  const skillCatalog = new SkillCatalogService({ pool: deps.pool, audit, github: skillGithub, clock });
  const skillImports = new SkillImportService({
    pool: deps.pool,
    audit,
    skills,
    clock,
    github: skillGithub,
    catalog: () => skillCatalog,
  });
  // p14-mcp-core (ADR-0054): external MCP servers for jobs (panel-signed specs, vault-bound secrets, probes on workers).
  const mcp = new McpService({
    pool: deps.pool,
    audit,
    panelKey: currentPanelKey,
    retiredPanelKeys,
    publicKeys: deps.skills?.publicKeys ?? [],
    clock,
    probes: () => remoteOps,
    // p14-mcp-stdio: local package installs go through the fleet-tools pipeline.
    fleetTools: () => fleetTools,
    connected: (workerId) => (hub?.get(workerId)?.session ?? undefined) !== undefined,
    notify: () => notifications,
    meter: deps.telemetry?.meter ?? null,
    ...(deps.mcp?.registryFetch === undefined ? {} : { registryFetch: deps.mcp.registryFetch }),
  });
  // p19-install-scripts (ADR-0068): npm install scripts an admin reviewed and approved for the whole platform.
  const installScriptApprovals = new InstallScriptApprovals({
    pool: deps.pool,
    audit,
    clock,
    ...(deps.mcp?.registryFetch === undefined ? {} : { fetch: deps.mcp.registryFetch }),
  });
  const installScriptCards = new InstallScriptCardRunner(() => installScriptApprovals);
  // p14-mcp-chat (ADR-0054 P5): MCP Registry / npm / PyPI read as data; install previews shared by chat and Keşfet.
  const mcpDiscovery = new McpDiscovery({
    clock,
    ...(deps.mcp?.registryFetch === undefined ? {} : { fetch: deps.mcp.registryFetch }),
  });
  const mcpPreviews = new McpPreviewService({
    pool: deps.pool,
    audit,
    clock,
    mcp,
    discovery: mcpDiscovery,
    fleetTools: () => fleetTools,
  });
  const usage = new UsageStore({ pool: deps.pool, audit, clock });
  const contextPolicy = new ContextPolicyService({ pool: deps.pool, audit, clock }, context);
  const search = new SearchService({
    pool: deps.pool,
    audit,
    policy: contextPolicy,
    // p10-bedrock-integration-panel: the resolver below sets the active provider before the app serves requests.
    embedder: null,
    clock,
    ...(deps.search?.searchesPerMinute === undefined
      ? {}
      : { searchesPerMinute: deps.search.searchesPerMinute }),
  });
  // p10-bedrock-integration-panel: Settings → Integrations → AWS Bedrock; panel settings take precedence over env.
  const envEmbedder = deps.search?.embedder ?? null;
  const bedrock = new BedrockIntegration({
    pool: deps.pool,
    audit,
    box: deps.box,
    clock,
    search,
    env: {
      mode:
        deps.search?.envMode ??
        (envEmbedder === null
          ? 'unset'
          : envEmbedder.provider === 'bedrock' ||
              envEmbedder.provider === 'http' ||
              envEmbedder.provider === 'local-hash'
            ? envEmbedder.provider
            : 'http'),
      embedder: envEmbedder,
      region: envEmbedder instanceof BedrockEmbedder ? envEmbedder.region : null,
      credentialSource: deps.search?.envCredentialSource ?? 'environment',
    },
    // p17-panel-settings Part 2: the HTTP embedding provider from the panel (SEARCH_HTTP_* as its default).
    panelChoice: () => {
      const choice = panelSettings.value<string>('search.provider');
      if (choice === 'bedrock') return { kind: 'bedrock' as const };
      if (choice !== 'http') return null;
      const url = panelSettings.value<string>('search.http.url');
      const model = panelSettings.value<string>('search.http.model');
      const apiKey = panelSettings.secret('search.http.key');
      const dims = panelSettings.value<number>('search.http.dimensions');
      const panelUsed =
        ['search.provider', 'search.http.url', 'search.http.model', 'search.http.dimensions'].some(
          (k) => panelSettings.source(k) === 'panel',
        ) || panelSettings.secretSource('search.http.key') === 'panel';
      return {
        kind: 'http' as const,
        key: `${url ?? ''}|${model ?? ''}|${String(dims ?? '')}|${createHash('sha256')
          .update(apiKey ?? '')
          .digest('hex')
          .slice(0, 16)}`,
        source: panelUsed ? ('panel' as const) : ('environment' as const),
        build: () =>
          url === null || model === null || apiKey === null
            ? null
            : new HttpEmbedder({ url, model, apiKey, ...(dims === null ? {} : { dimensions: dims }) }),
      };
    },
    ...(deps.search?.bedrockEndpoint === undefined ? {} : { endpoint: deps.search.bedrockEndpoint }),
    ...(deps.search?.bedrockTestTimeoutMs === undefined
      ? {}
      : { testTimeoutMs: deps.search.bedrockTestTimeoutMs }),
  });
  await bedrock.refresh();
  // p11-memory-layers: typed memory records (rules, facts, decisions, lessons) with lifecycle and conflicts.
  const memoryRecords = new MemoryRecordService({
    pool: deps.pool,
    audit,
    context,
    clock,
    similar: async (project, text) => (await search.similarDocs(project, [text]))?.[0] ?? null,
  });
  // p17-memory-import: importing what a person's own AI assistant knows about them (reviewed, then records).
  const memoryImports = new MemoryImportService({
    pool: deps.pool,
    audit,
    records: memoryRecords,
    search,
    clock,
  });
  const memorySuggestions = new MemorySuggestionService({
    pool: deps.pool,
    audit,
    context,
    search,
    records: memoryRecords,
    clock,
    ...(deps.memorySuggestions?.duplicateThreshold === undefined
      ? {}
      : { duplicateThreshold: deps.memorySuggestions.duplicateThreshold }),
    ...(deps.memorySuggestions?.chatPerThreadPerDay === undefined
      ? {}
      : { chatPerThreadPerDay: deps.memorySuggestions.chatPerThreadPerDay }),
    ...(deps.memorySuggestions?.autoLearn === undefined
      ? {}
      : { autoLearn: deps.memorySuggestions.autoLearn }),
    // p17-panel-settings: the panel's memory settings, read at use time (only keys set in the panel override).
    tune: () => ({
      duplicateThreshold:
        panelSettings.source('memory.duplicateThreshold') === 'panel'
          ? (panelSettings.value<number>('memory.duplicateThreshold') ?? undefined)
          : undefined,
      chatPerThreadPerDay:
        panelSettings.source('memory.chatPerThreadDay') === 'panel'
          ? (panelSettings.value<number>('memory.chatPerThreadDay') ?? undefined)
          : undefined,
      autoLearn:
        panelSettings.source('memory.autoLearn') === 'panel'
          ? (panelSettings.value<boolean>('memory.autoLearn') ?? undefined)
          : undefined,
    }),
  });
  // p17-embeddings: the embedding index beyond search (similar jobs, solved failures, duplicate checks).
  const relatedWork = new RelatedWorkService({
    pool: deps.pool,
    search,
    audit,
    clock,
    ...(deps.relatedWork?.enabled === undefined ? {} : { enabled: deps.relatedWork.enabled }),
    ...(deps.relatedWork?.context === undefined ? {} : { contextEnabled: deps.relatedWork.context }),
  });
  // p10-semantic-defaults-chat.
  const semanticDefaults = new SemanticDefaultsService({ pool: deps.pool, audit, clock });
  const sd = deps.semanticDefaults ?? {};
  const chatKnowledge = new ChatKnowledge({
    pool: deps.pool,
    audit,
    search,
    clock,
    ...(sd.relatedMinScore === undefined ? {} : { relatedMinScore: sd.relatedMinScore }),
    ...(sd.relatedLimit === undefined ? {} : { relatedLimit: sd.relatedLimit }),
    ...(sd.relatedMaxBytes === undefined ? {} : { relatedMaxBytes: sd.relatedMaxBytes }),
  });
  if (sd.backfillOnStart === true) await semanticDefaults.backfill();
  const gate = new AccessGate({
    audit,
    limiter,
    clock,
    ...(deps.accessLimits ? { limits: deps.accessLimits } : {}),
  });
  const exportLimits = deps.exportLimits ?? {};
  // p5-coolify-sso: sealed redirect state keyed from the master key file (HKDF sub-key).
  const ssoSealer = new Sealer(deps.box.deriveKey('sso-state'));
  const oidcProvider =
    deps.sso?.oidc === undefined
      ? null
      : new OidcProvider({
          config: deps.sso.oidc,
          pool: deps.pool,
          audit,
          sealer: ssoSealer,
          clock,
          stepUp: stepUpPolicy,
        });
  const coolifyGate =
    deps.sso?.gate === undefined
      ? null
      : new CoolifyGate({
          config: deps.sso.gate,
          pool: deps.pool,
          audit,
          sealer: ssoSealer,
          clock,
          ...(deps.sso.gateCacheMs === undefined ? {} : { cacheMs: deps.sso.gateCacheMs }),
        });
  const quotaStore = new QuotaStore({ pool: deps.pool, audit, clock });
  // p13-runtime-accounts (ADR-0049): several Claude Code / Codex accounts per machine; added accounts travel in the
  // machine's panel configuration (a new generation, delivered at once).
  const runtimeAccounts = new RuntimeAccountService({
    pool: deps.pool,
    audit,
    clock,
    syncConfig: async (workerId, actor, note) => {
      if (workerConfigs === null) return;
      await workerConfigs.syncAccounts(
        workerId,
        actor === null
          ? null
          : { userId: actor.userId, ip: actor.ip ?? '', userAgent: actor.userAgent ?? null },
        note,
      );
    },
    managed: (workerId) =>
      workerConfigs === null ? Promise.resolve(false) : workerConfigs.managed(workerId),
  });
  // p11-usage-limit-fallback: usage limits wait (parked / requeued), fall back or fail per the project's policy.
  const usageLimits = new UsageLimitService({
    pool: deps.pool,
    audit,
    jobs,
    quotas: quotaStore,
    replay: () => requireSessions().replay,
    clock,
    dispatch: (jobId) => {
      void orchestrator?.dispatch(jobId).catch(() => undefined);
    },
    accounts: () => runtimeAccounts,
  });
  // p13-runtime-accounts: "Hesabı değiştir" — pin / resume / pause-and-resume with another account.
  const accountSwitch = new AccountSwitchService({
    pool: deps.pool,
    audit,
    clock,
    jobs,
    accounts: runtimeAccounts,
    replay: () => requireSessions().replay,
    restartElsewhere: (pauseId, why) => usageLimits.restartElsewhere(pauseId, why),
    dispatch: (jobId) => {
      void orchestrator?.dispatch(jobId).catch(() => undefined);
    },
  });
  // p11-session-continuity (ADR-0042): checkpoints, worker-restart detection and resume.
  const continuityService = new SessionContinuityService({
    pool: deps.pool,
    audit,
    jobs,
    replay: () => requireSessions().replay,
    clock,
    policy:
      deps.orchestration?.continuity === undefined
        ? defaultContinuityPolicy()
        : (deps.orchestration.continuity satisfies ContinuityPolicy | null),
  });
  // The orchestrator resumes every kind of pause: approval decisions (p10), usage-limit waits and worker restarts (p11).
  // p11-limit-visibility: the runtimes' usage windows (HEARTBEAT), merged with the known limit hits above.
  const runtimeUsage = new RuntimeUsageService({
    pool: deps.pool,
    clock,
    audit,
    episodes: () => usageLimits.status(),
    // p19-limit-clear: a reading under all limits ends that login's open limit; its waiting jobs move on.
    clearLimits: (tx, reading) => usageLimits.clearWithin(tx, { kind: 'reading', ...reading }, null),
    limitsCleared: () => {
      void usageLimits.tick().catch(() => undefined);
    },
  });
  const pauses: OrchestratorPause = {
    resumable: async (limit) => [
      ...(await continuityService.resumable(limit)),
      ...(await approvalPause.resumable(limit)),
      ...(await usageLimits.resumable(limit)),
    ],
    prepareResume: async (id) =>
      (await continuityService.owns(id))
        ? continuityService.prepareResume(id)
        : (await usageLimits.owns(id))
          ? usageLimits.prepareResume(id)
          : approvalPause.prepareResume(id),
    markResumed: (id, epoch) => approvalPause.markResumed(id, epoch),
    blockResume: async (id, reason) =>
      (await continuityService.owns(id))
        ? continuityService.blockResume(id, reason)
        : (await usageLimits.owns(id))
          ? usageLimits.blockResume(id, reason)
          : approvalPause.blockResume(id, reason),
    restartElsewhere: (id, reason) => usageLimits.restartElsewhere(id, reason),
    lapsedResume: (jobId) => approvalPause.lapsedResume(jobId),
    approvalWait: (project) => approvalPause.approvalWait(project),
  };
  let quotas: QuotaService | null = null;
  // p9-queue-priority: queue screen, per-user / per-automation limits, urgent reserve, long-wait notices.
  let queue: QueueService | null = null;
  // p6-quota-scheduling: off-peak deferral (admission) and "Run now".
  const quotaScheduling = new QuotaSchedulingService({
    pool: deps.pool,
    audit,
    clock,
    dispatch: (jobId) => (orchestrator === null ? Promise.resolve() : orchestrator.dispatch(jobId)),
  });
  // p6-warm-caches: the project setting for shared package caches.
  const packageCaches = new PackageCacheService({ pool: deps.pool, audit, clock });
  // p19-project-env: vault credentials a project gives its jobs as environment variables.
  const projectEnv = new ProjectEnvService({ pool: deps.pool, audit, clock });
  // p14-repo-egress: a repository project's network access for its jobs (Projects → Policy → Network access).
  const repoEgress = new RepoEgressService({
    pool: deps.pool,
    audit,
    clock,
    // p21-service-egress: running services and IDEs of the project get the new network policy.
    // Each re-send logs its own failure; a failure here never fails the change.
    onChanged: async (project) => {
      await services?.onEgressChanged(project).catch(() => undefined);
    },
  });
  // p22-runtime-diagnostics: certificates a project trusts for its function jobs (Trust this certificate).
  const tlsPins = new TlsPinService({ pool: deps.pool, audit, clock });
  // p18-project-bootstrap: a project's preferred machines (a soft placement preference of all its jobs).
  const preferredWorkers = new PreferredWorkersService({ pool: deps.pool, audit, clock });
  let workflows: WorkflowService | null = null;
  let workflowEgress: WorkflowEgressService | null = null;
  // p18-multi-project: shared workflows (offers, attachments, credential slots).
  let sharedWorkflows: SharedWorkflowService | null = null;
  let schedules: ScheduleService | null = null;
  let automations: AutomationService | null = null;
  // p18-multi-project W4: automation groups ("Projeler", "Tümüne uygula"; the console and the chat's group card).
  let automationGroups: AutomationGroupService | null = null;

  let hub: WorkerHub | null = null;
  let fleet: FleetService | null = null;
  let fleetSessions: OrchestrationSessionHandler | null = null;
  // p6-approval-mode-switch: built with the worker sessions (needs their replay); routes registered below.
  let approvalModes: ApprovalModeService | null = null;
  // p15-autonomy: a job's time limit changed from a card / the chat while it waits or runs.
  let timeLimits: TimeLimitService | null = null;
  // p20-job-clock: run clock reports, the time warning, "continue after a timeout".
  let jobClock: JobClockService | null = null;
  const o = deps.orchestration ?? {};
  const signer = o.signer ?? LeaseSigner.ephemeral();
  // p17-panel-settings Part 7: blobs:migrate / search:backfill / memory:autolearn as background jobs from the panel.
  const maintenance = new MaintenanceService({
    pool: deps.pool,
    audit,
    clock,
    blobs: blobService,
    search,
    related: relatedWork,
    relatedEnabled: deps.relatedWork?.enabled ?? true,
    memory: () => memorySuggestions,
  });
  // p17-panel-settings Part 5: key rotation where it is safe (webhook HMAC, skills panel key); the procedures for the rest.
  const keyRotation = new KeyRotationService({
    pool: deps.pool,
    audit,
    settings: panelSettings,
    panelKey: currentPanelKey,
    leaseKeyId: () => signer.key.kid,
    managedWorkers: async () =>
      (await deps.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM worker_configs')).rows[0]?.n ?? 0,
  });
  // p17-domain-wizard: the console's public address — the saved setting, else PUBLIC_ORIGIN / NOTIFY_PUBLIC_URL. Link
  // builders below read it live; host domain changes are signed with the lease key (ADR-0063 amendment).
  const cdc = deps.consoleDomain ?? {};
  const consoleDomain = new ConsoleDomainService({
    pool: deps.pool,
    audit,
    clock,
    envOrigin: deps.installers?.publicOrigin ?? null,
    envNotifyUrl: deps.notifications?.publicUrl ?? null,
    hostDir: cdc.hostDir ?? null,
    signer,
    ...(cdc.resolver === undefined ? {} : { resolver: cdc.resolver }),
    ...(cdc.heartbeatMaxAgeMs === undefined ? {} : { heartbeatMaxAgeMs: cdc.heartbeatMaxAgeMs }),
    ...(cdc.requestTtlMs === undefined ? {} : { requestTtlMs: cdc.requestTtlMs }),
    ...(cdc.applyingTimeoutMs === undefined ? {} : { applyingTimeoutMs: cdc.applyingTimeoutMs }),
  });
  let orchestrator: Orchestrator | null = null;
  let relay: OutboxRelay | null = null;
  let hintQueue: HintQueue | null = null;
  const requireSessions = (): OrchestrationSessionHandler => {
    if (fleetSessions === null) throw new Error('fleet sessions not initialised');
    return fleetSessions;
  };
  let rotation: RotationService | null = null;
  let releases: ReleaseService | null = null;
  let installers: InstallerService | null = null;
  // p17-update-channel: the worker release feed, the owner's policy, canary-first rollouts, the version catalog.
  let updateChannel: UpdateChannelService | null = null;
  let versionCatalog: VersionCatalogService | null = null;
  let ownerUpgrades: OwnerUpgradeService | null = null;
  let runtimePolicies: RuntimePolicyService | null = null;
  let workerConfigs: WorkerConfigService | null = null;
  // p8-capacity-auto: capacity modes and the controller (an orchestrator step).
  let capacity: CapacityService | null = null;
  // p8-uptime: monitors (an orchestrator step runs the due checks); built with the app logger.
  let uptime: UptimeService | null = null;
  let vault: VaultService | null = null;
  let remoteOps: RemoteOpsService | null = null;
  // p17-runtime-verify: "Doğrula" — capability verification runs and their signed evidence.
  let capabilityEvidence: CapabilityEvidenceService | null = null;
  // p17-worker-managed: removing a worker from the panel and managing its machine-admin helper.
  let workerRemovals: WorkerRemovalService | null = null;
  // p15-usage-refresh: "Şimdi kontrol et" — usage.refresh remote operations.
  const usageRefresh = new UsageRefreshService({ pool: deps.pool, clock, limiter, ops: () => remoteOps });
  let sandboxOps: SandboxOpsService | null = null;
  let machineAdmin: MachineAdminService | null = null;
  // p13-fleet-tools (ADR-0052): fleet tool / runtime versions, bulk actions, custom recipes, weekly digest.
  let fleetToolFeed: VersionFeedService | null = null;
  const customToolRecipes = new CustomRecipeStore({ pool: deps.pool, audit, clock });
  let fleetTools: FleetToolsService | null = null;
  // p8-orchestration (ADR-0031): agent-requested sub-jobs.
  let subtasks: SubtaskService | null = null;
  // p14-ask-user: question cards of the assistant and of job agents.
  let questions: QuestionService | null = null;
  // p11-runtime-advice (ADR-0044): advice, auto routing, outcome matrix, ratings (preview facts resolved lazily).
  const runtimeAdvice = new RuntimeAdviceService({
    pool: deps.pool,
    audit,
    clock,
    preview: () => {
      if (quotas === null || runtimePolicies === null || orchestrator === null) {
        throw new Error('services not initialised');
      }
      const q = quotas;
      const rp = runtimePolicies;
      const orch = orchestrator;
      return {
        db: deps.pool,
        candidates: (project) => orch.candidates(project),
        quotas: (project, runtime) => q.preview(project, runtime),
        policyOf: async (workerId) => (await rp.forWorker(workerId)).effective?.document ?? null,
        outcomes: (key) => outcomesFor(deps.pool, key),
      };
    },
  });
  let models: ModelCatalogService | null = null;
  let chat: ChatService | null = null;
  let chatWatches: ChatWatchService | null = null;
  // p17-chat-flow: workflow approvals / results and job questions in the conversations they came from.
  let chatFlow: ChatFlowService | null = null;
  // p18-plan-mode: plan mode, plans, their review and execution (continuation turns).
  let chatPlans: ChatPlanService | null = null;
  // p20-outcome: the goal ledger ("sonuç ya da açık müdahale").
  let chatGoals: GoalLedger | null = null;
  // p15-watches: the chat tools (the `then` card of a check watch uses the assistant's draft tools).
  let chatToolsRef: ChatTools | null = null;
  let chatStreams: ChatStreams | null = null;
  let drafts: DraftExecutor | null = null;
  // p15-autonomy: the assistant's direct actions and its settings tools.
  let chatDirect: ChatDirectActions | null = null;
  // p20-scope-preview: the goal-bound grants ("Hedefe bağlı yetki").
  let goalGrants: GoalGrants | null = null;
  // oss-sec3: remembered confirmations of cards held because a turn read untrusted content.
  const untrustedAllows = new UntrustedAllows({ pool: deps.pool, audit, clock });
  const chatSettingsTools = new ChatSettings({
    db: deps.pool,
    securityPolicy,
    sandboxOps: () => sandboxOps,
    projectPolicies: policies,
    runtimePolicies: () => runtimePolicies,
  });
  // p16-assistant-admin: the console's administration services, for the assistant's admin tools and cards.
  let directory: Directory | null = null;
  let gitCentral: GitCentralService | null = null;
  // p18-assistant-gaps: the assistant's workflow run, job output, backup / update, template, uptime, memory review,
  // Outputs library, weekly report, health re-check, job question and cost brake tools (the console's services).
  // p18-project-bootstrap: a project's readiness, network access and machines through the chat.
  const chatProjectSetup = new ChatProjectSetup({
    db: deps.pool,
    preview: () => {
      if (quotas === null || runtimePolicies === null || orchestrator === null) return null;
      const q = quotas;
      const rp = runtimePolicies;
      const orch = orchestrator;
      return {
        db: deps.pool,
        candidates: (project) => orch.candidates(project),
        quotas: (project, runtime) => q.preview(project, runtime),
        policyOf: async (workerId) => (await rp.forWorker(workerId)).effective?.document ?? null,
        outcomes: (key) => outcomesFor(deps.pool, key),
      };
    },
    repoState: () => {
      const flow = gitflow;
      return flow === null ? null : (project) => flow.repositoryState(project);
    },
    egress: () => repoEgress,
    workers: () => workerConfigs,
    preferred: () => preferredWorkers,
  });
  // p19-ide W4: the assistant's code tools (made once the code service exists, below).
  let chatCodeTools: ChatCodeTools | null = null;
  const chatOpsTools = new ChatOpsTools({
    projectSetup: () => chatProjectSetup,
    codeTools: () => chatCodeTools,
    db: deps.pool,
    clock,
    workflows: () => workflows,
    flow: () => chatFlow,
    workspaces: () => workspaces,
    uptime: () => uptime,
    memoryRecords: () => memoryRecords,
    outputs: () => outputsService,
    folders: () => outputFolders,
    reports: () => reports,
    health: () => deployHealth,
    questions: () => questions,
    templates: () => templates,
    backups: () => backupManage,
    hostActions: () => hostActions,
    updates: () => updateFeed,
    costBrake: () => costBrake,
    // p18-leftovers: budgets through the chat (draft_budget_change) — the console's store, checks and audit.
    usage: () => usage,
  });
  // p18-multi-project W3: the conversation's working projects (header, knowledge, the assistant's block and rules).
  const threadProjects = new ThreadProjects({ pool: deps.pool, audit, clock });
  // p18-multi-project W5: job fan-out batches (set up with the composer's defaults and quota preview below).
  let jobBatches: JobBatchService | null = null;
  const chatAdmin = new ChatAdmin({
    db: deps.pool,
    ops: () => chatOpsTools,
    // p16-runtime-updates: worker_release_status lists runtime versions per machine and verified candidates.
    fleetTools: () => fleetTools,
    clock,
    directory: () => directory,
    fleet: () => fleet,
    rotation: () => rotation,
    releases: () => releases,
    backups: () => backupStatus,
    vault: () => vault,
    notifications: () => notifications,
    integrations: () => opsIntegrations,
    github: () => githubConnect,
    gitHosts: () => gitHosts,
    quotas: () => quotas,
    schedules: () => schedules,
    previews: () => previews,
    gitCentral: () => gitCentral,
    system: () => systemStatus,
    logs: () => logStore,
    // p19-chat-machine-admin: draft_machine_prepare (the machine's Sandbox prepare, admin card `machine.prepare`).
    sandboxOps: () => sandboxOps,
  });
  // p6-deploy-integrations: tokens held by the master; ops actions (constructed with the app logger).
  const opsCfg = deps.ops ?? {};
  // p17-panel-settings: OPS_* from the panel, read at use time (live set / lists over the effective values).
  const opsInternalOrigins = new LiveSet(() => listOf(panelSettings, 'ops.internalOrigins'));
  const opsControlPlaneResources = liveList(() => listOf(panelSettings, 'ops.controlPlaneUuids'));
  const opsControlPlaneAddresses = liveList(() => listOf(panelSettings, 'ops.controlPlaneAddresses'));
  // OPS_PROTECTED_HOSTS: host names protected like the console host (none by default; the PUBLIC_ORIGIN host always is).
  const opsExtraProtectedHosts = (opsCfg.protectedHosts ?? []).map((h) => h.toLowerCase());
  const opsConsoleHost = (() => {
    const o = deps.installers?.publicOrigin ?? null;
    try {
      return o === null ? null : new URL(o).hostname.toLowerCase();
    } catch {
      return null;
    }
  })();
  const opsIntegrations = new OpsIntegrations({
    pool: deps.pool,
    audit,
    box: deps.box,
    clock,
    fetch: opsCfg.fetch ?? createGuardedFetch({ internalOrigins: opsInternalOrigins }),
    internalOrigins: opsInternalOrigins,
    cloudflareApi: opsCfg.cloudflareApi ?? CLOUDFLARE_API,
    controlPlaneResources: opsControlPlaneResources,
    protectedHosts: [
      ...new Set([...opsExtraProtectedHosts, ...(opsConsoleHost === null ? [] : [opsConsoleHost])]),
    ],
    coolifySsoHost: deps.sso?.gate?.host ?? null,
  });
  let ops: OpsService | null = null;
  // p15-coolify-create (ADR-0057): Coolify applications created / changed from Remyral.
  let coolifyApps: CoolifyAppService | null = null;
  // p17-coolify-full: the whole Coolify of a connection (storages, lifecycle, databases, services, projects).
  let coolifyResources: CoolifyResourceService | null = null;
  const chatCoolify = new ChatCoolify({ apps: () => coolifyApps, resources: () => coolifyResources });
  // p15-github-create-repo: GitHub repositories opened from Remyral (panel + create_repository).
  let githubRepos: GitHubRepoService | null = null;
  const chatHostRepo = new ChatHostRepo({ hosts: () => gitHosts, configs: () => gitConfigs });
  const chatGitHubRepo = new ChatGitHubRepo({
    repos: () => githubRepos,
    // p16-git-providers: create_repository with provider gitlab / bitbucket.
    hosted: () => chatHostRepo,
  });
  // p17-chat-github: a project from the chat (draft_project_create, list_git_repositories, list_dns_zones).
  const chatProjectCreate = new ChatProjectCreate({
    db: deps.pool,
    directory: () => directory,
    github: () => githubConnect,
    configs: () => gitConfigs,
    integrations: () => opsIntegrations,
    ops: () => ops,
    // p18-project-bootstrap: the linked repository's state on the card's result (empty repository).
    repoState: () => {
      const flow = gitflow;
      return flow === null ? null : (project) => flow.repositoryState(project);
    },
  });
  // p10-site-upload (ADR-0037): static sites uploaded through Project → Deploy (pages.deploy with uploadId).
  let siteUploads: SiteUploadService | null = null;
  // p8-preview-tunnels (ADR-0032): preview links through Cloudflare Tunnel (ops kinds tunnel.*).
  let previews: PreviewService | null = null;
  // p15-services: long-running services the workers own (no job slot).
  let services: ServiceRegistry | null = null;
  // p19-ide W2 (ADR-0066): Tam IDE — workspaces on Linux machines, the STREAM_* plane, the IDE origin's proxy.
  const ideOrigin = (): string | null => deps.ide?.origin ?? null;
  let ide: IdeService | null = null;
  // p19-ide W3: IDE extensions (Open VSX allowlist + cache, project / user lists) and settings sync.
  let ideExtensions: IdeExtensions | null = null;
  let ideTunnels: TunnelRegistry | null = null;
  let ideProxy: ReturnType<typeof ideProxyRoutes> | null = null;
  // p15-workspace-retention: kept working directories of workspace jobs (records, reads, seeds, sweep, exports).
  let workfiles: WorkfilesService | null = null;
  let workfilesExport: WorkfilesExport | null = null;
  const chatWorkfiles = new ChatWorkfiles({
    service: () => workfiles,
    exporter: () => workfilesExport,
    db: deps.pool,
  });
  // p20-chat-images: show_image (job outputs and kept working files inline in the conversation).
  const chatImageTools = new ChatImageTools({ db: deps.pool, workfiles: () => workfiles });
  // p15-chat-zip: a .zip from the chat as a site upload linked to its message; list_site_uploads / publish_site_upload.
  const chatSiteUploads = new ChatSiteUploads({ db: deps.pool });
  // p22-site-coolify: publish_site_coolify — a site upload to a live Coolify application from ONE card.
  const chatSiteCoolify = new ChatSiteCoolify({
    db: deps.pool,
    clock,
    chatUploads: () => chatSiteUploads,
    siteUploads: () => siteUploads,
    projects: () => chatProjectCreate,
    repos: () => chatGitHubRepo,
    gitConfig: () => (project) => gitConfigs.get(project),
    providers: () => providers,
    coolify: () => chatCoolify,
    coolifyApps: () => coolifyApps,
    ops: () => ops,
    watches: () => chatWatches,
  });
  // p16-zip-job-input: input bundles a chat message carries / list_input_bundle_files / draft_job inputUpload.
  const chatInputUploads = new ChatInputUploads({ service: inputUploads, db: deps.pool });
  let deployOnSuccess: DeployOnSuccessService | null = null;
  // p10-verify-health: "Verify when done" and the post-deploy health check (constructed with the app logger).
  let verification: VerificationService | null = null;
  // p11-merge-pipeline: assigned once git flow exists (the workflow gateway and git flow's PR policy ask it lazily).
  let integration: IntegrationService | null = null;
  let deployHealth: DeployHealthService | null = null;
  let deployFeedback: DeployFeedbackService | null = null;
  let jobMessages: JobMessageService | null = null;
  const chatStore = new ChatStore({ pool: deps.pool, clock });
  // p15-workflow-ai: the assistant inside the workflow editor (created with the chat service).
  let workflowAi: WorkflowAiService | null = null;
  const chatOrganizer = new ChatOrganizer({ pool: deps.pool, clock });
  const chatAssets = new ChatAssets({ pool: deps.pool, clock });
  // p8-cost-efficiency: dashboard, suggestions and the weekly report (notifications / chat bound once they exist).
  const efficiency = new EfficiencyService({
    pool: deps.pool,
    usage,
    clock,
    workers: async () => {
      if (runtimePolicies === null) return [];
      const rp = runtimePolicies;
      const names = new Map(
        (
          await deps.pool.query<{ id: string; display_name: string }>('SELECT id, display_name FROM workers')
        ).rows.map((r) => [r.id, r.display_name]),
      );
      return (await fleetOverview(deps.pool, (id) => rp.forWorker(id))).map((wo) => ({
        id: wo.id,
        name: names.get(wo.id) ?? wo.id,
        effective: wo.parallelism.effective,
        recommended: wo.advice?.recommended ?? null,
        mode: wo.capacityMode?.mode ?? null,
      }));
    },
  });
  let reportNotifier: NotificationService | null = null;
  const reports = new ReportService({
    pool: deps.pool,
    efficiency,
    usage,
    audit,
    clock,
    notify: () => reportNotifier,
    chat: () =>
      chatStreams === null
        ? null
        : {
            addNote: (db, threadId, content, meta) =>
              chatStore.addMessage(threadId, { role: 'assistant', content, meta }, db),
            publish: (threadId, message) => {
              chatStreams?.publish(threadId, 'message', message);
            },
          },
  });
  // p6-outputs read model (also the source of chat @mentions of outputs, p8-chat-attachments-mentions).
  const outputsService = new OutputsService({
    pool: deps.pool,
    audit,
    clock,
    liveRetentionDays: (deps.live?.sweepIntervalMs ?? 0) > 0 ? (deps.live?.retentionDays ?? 30) : null,
    // p8-uptime: site items carry their monitors.
    uptime: () => uptime,
    // p10-verify-health: site items carry their latest health check (and its screenshot).
    health: () => deployHealth,
  });
  const verifySettings = new VerifySettingsStore({ pool: deps.pool, audit, clock });
  // p8-templates: parameterised job templates (CRUD, rendering, suggestions, run attribution).
  const templates = new TemplateService({ pool: deps.pool, audit, clock });
  const chatAttachments = new ChatAttachments({ pool: deps.pool, audit, clock, limiter });
  // p8-outputs-folders: own folders and the automatic tree on top of the read model.
  const outputFolders = new OutputFolders({ pool: deps.pool, audit, clock, outputs: outputsService });
  const outputTree = new OutputTree({ pool: deps.pool, outputs: outputsService, folders: outputFolders });
  // p15-chat-vault: vault credentials in the chat by reference (mentions, tokens, run_http_request, saving cards).
  const chatCredentials = new ChatCredentials({
    db: deps.pool,
    store: chatStore,
    audit,
    clock,
    jobs: () => ({
      create: async (input) => {
        const { job } = await jobs.create({
          project: input.project,
          spec: input.spec,
          actor: { type: 'user', id: input.userId },
          function: true,
          submit: true,
        });
        return job.id;
      },
    }),
    egress: () => workflowEgress,
  });
  // p19-ide W1: the code viewer / diff reviewer (read-only on the repository) and `code` chat references.
  const codeService = new CodeService({
    pool: deps.pool,
    audit,
    providers: () => gitflow,
    workfiles: () => workfiles,
    // p19-ide W2: `ide:` references ("Sohbete ekle" in the IDE), re-read from the machine at send time.
    ide: () => ide,
    jobMessages: () => jobMessages,
    jobs,
    dispatch: (jobId) => {
      void orchestrator?.dispatch(jobId).catch(() => undefined);
    },
    clock,
    // p18-last-gaps: a compare view's "Değişiklik iste" on a pull request starts a job with the project's defaults.
    defaults: new ProjectDefaults({
      db: deps.pool,
      preview: () => {
        if (quotas === null || runtimePolicies === null || orchestrator === null) {
          throw new Error('services not initialised');
        }
        const q = quotas;
        const rp = runtimePolicies;
        const orch = orchestrator;
        return {
          db: deps.pool,
          candidates: (project) => orch.candidates(project),
          quotas: (project, runtime) => q.preview(project, runtime),
          policyOf: async (workerId) => (await rp.forWorker(workerId)).effective?.document ?? null,
          outcomes: (key) => outcomesFor(deps.pool, key),
        };
      },
    }),
  });
  // p19-ide W4: read_code / list_code / read_workspace_diff / open_code / open_diff / draft_review_changes.
  chatCodeTools = new ChatCodeTools({ db: deps.pool, code: () => codeService, ide: () => ide });
  const chatMentions = new ChatMentions({
    db: deps.pool,
    outputs: () => outputsService,
    folders: () => outputFolders,
    credentials: () => chatCredentials,
    code: () => codeService,
    audit,
  });
  const chatSettings = new ChatSettingsStore({ pool: deps.pool, audit, clock });
  const chatFailover = new ChatFailoverStore({ pool: deps.pool, audit, clock });
  const jobQuery = new JobQuery(deps.pool, jobs);
  const w = deps.workers ?? {};
  const workerRoutes: RoutePlugin = async (app) => {
    if (hub === null) throw new Error('worker hub not initialised');
    if (fleetSessions === null) throw new Error('fleet sessions not initialised');
    const sessionHandler = w.handler ?? fleetSessions;
    // Offline detection by missed heartbeats (p2-heartbeat-caps).
    const sessions = fleetSessions;
    const sweepEvery = w.sweepIntervalMs ?? 5_000;
    if (sweepEvery > 0) {
      const sweeper = setInterval(() => {
        gated('worker-heartbeat', () => sessions.sweep()).catch((err: unknown) => {
          app.log.error({ err }, 'worker heartbeat sweep failed');
        });
      }, sweepEvery);
      sweeper.unref();
      app.addHook('onClose', () => {
        clearInterval(sweeper);
      });
    }
    await workerGatewayRoutes({
      hub,
      directory:
        w.directory ??
        new PgDeviceDirectory({
          pool: deps.pool,
          audit,
          limiter,
          clock,
          ...(w.pairing ? { policy: w.pairing } : {}),
        }),
      handler: deps.telemetry ? instrumentSessionHandler(sessionHandler, deps.telemetry) : sessionHandler,
      leaseKeys: () => signer.keys(),
      audit,
      limiter,
      clock,
      ...(w.timing ? { timing: w.timing } : {}),
      ...(w.limits ? { limits: w.limits } : {}),
      ...(w.connectRateLimit ? { connectRateLimit: w.connectRateLimit } : {}),
      ...(w.connectionCaps ? { connectionCaps: w.connectionCaps } : {}),
      ...(w.sessionRateLimit ? { sessionRateLimit: w.sessionRateLimit } : {}),
      // p19-ide W2 (ADR-0066): the STREAM_* plane of IDE workspaces.
      ...(ideTunnels === null ? {} : { streams: ideTunnels }),
    })(app);
  };
  const fleetApi: RoutePlugin = (app) => {
    if (fleet === null || rotation === null) throw new Error('fleet service not initialised');
    fleetRoutes(fleet, rotation, clock)(app);
  };

  const runtimePolicyApi: RoutePlugin = (app) => {
    if (runtimePolicies === null) throw new Error('runtime policy service not initialised');
    runtimePolicyRoutes(runtimePolicies, clock)(app);
    const rp = runtimePolicies;
    fleetViewRoutes({ db: deps.pool, policyOf: (id) => rp.forWorker(id) })(app);
  };

  const workerConfigApi: RoutePlugin = (app) => {
    if (workerConfigs === null) throw new Error('worker config service not initialised');
    workerConfigRoutes(workerConfigs, clock, preferredWorkers)(app);
    if (capacity === null) throw new Error('capacity service not initialised');
    capacityRoutes(capacity, clock)(app);
  };

  // p5-credentials-models: credential vault (ciphertext only) and model catalog.
  const vaultApi: RoutePlugin = (app) => {
    if (vault === null || models === null) throw new Error('vault / model catalog not initialised');
    vaultRoutes(vault, clock)(app);
    modelRoutes(models, clock)(app);
    routingRoutes(new RoutingService({ pool: deps.pool, audit, clock }), deps.pool, clock)(app);
    runtimeAdviceRoutes({ service: runtimeAdvice, clock })(app);
    // p11-runtime-advice: classify back-filled history after start (bounded batches; never blocks start-up).
    app.addHook('onReady', () => {
      void runtimeAdvice.backfill().catch((err: unknown) => {
        app.log.warn({ err, component: 'runtime-advice' }, 'runtime advice backfill failed');
      });
    });
  };

  // p5-remote-ops: runtime installs, login relay, restart, logs, diagnostics (signed OPS_COMMAND).
  const remoteOpsApi: RoutePlugin = (app) => {
    if (remoteOps === null) throw new Error('remote ops service not initialised');
    remoteOpsRoutes(remoteOps, clock)(app);
    // p17-runtime-verify: "Doğrula", evidence views, policy dependence, catalog marks.
    if (capabilityEvidence === null) throw new Error('capability evidence service not initialised');
    capabilityEvidenceRoutes(capabilityEvidence, clock)(app);
    if (sandboxOps === null) throw new Error('sandbox ops service not initialised');
    sandboxOpsRoutes(sandboxOps, clock)(app);
    if (machineAdmin === null) throw new Error('machine admin service not initialised');
    machineAdminRoutes(machineAdmin, remoteOps, deps.pool, clock)(app);
    // p17-worker-managed: removal from the panel and the machine-admin helper's install / removal.
    if (workerRemovals !== null) workerRemovalRoutes(workerRemovals, clock)(app);
    if (fleetTools === null || fleetToolFeed === null) throw new Error('fleet tools service not initialised');
    fleetToolsRoutes(fleetTools, customToolRecipes, fleetToolFeed, clock)(app);
    // p17-update-channel: the owner's upgrade to an exact upstream version (Araçlar ve sürümler).
    if (ownerUpgrades !== null) ownerUpgradeRoutes({ service: ownerUpgrades, clock })(app);
    // p15-git-central: the machines' Git card, its fix, the fleet-wide fix and projects' repository credentials.
    const ops = remoteOps;
    gitCentral = new GitCentralService({
      pool: deps.pool,
      audit,
      clock,
      connected: (workerId) => hub?.get(workerId) !== undefined,
      ops: () => ops,
    });
    gitCentralRoutes(gitCentral, clock)(app);
  };

  const releaseApi: RoutePlugin = (app) => {
    if (releases === null) throw new Error('release service not initialised');
    if (installers === null) throw new Error('installer service not initialised');
    // p6-release-upload: resumable chunked upload of release.json (bytes kept in Postgres until complete).
    const uploads = new ReleaseUploadService({ pool: deps.pool, audit, clock });
    const uploadSweepMs = deps.releases?.uploadSweepIntervalMs ?? 10 * 60_000;
    if (uploadSweepMs > 0) {
      const timer = setInterval(() => {
        gated('release-uploads', () => uploads.sweep()).catch((err: unknown) => {
          app.log.error({ err }, 'release upload sweep failed');
        });
      }, uploadSweepMs);
      timer.unref();
      app.addHook('onClose', () => {
        clearInterval(timer);
      });
    }
    const channelPollMs = deps.releases?.channelPollIntervalMs ?? 30_000;
    if (channelPollMs > 0) {
      const r = releases;
      const poll = (): void => {
        gated('release-channels', () => r.offerIfChannelsChanged()).catch((err: unknown) => {
          app.log.error({ err }, 'release channel poll failed');
        });
      };
      // Records the channels at start-up, so a change from outside after that is offered.
      app.addHook('onReady', async () => {
        await r.offerIfChannelsChanged().catch((err: unknown) => {
          app.log.error({ err }, 'release channel poll failed');
        });
      });
      const timer = setInterval(poll, channelPollMs);
      timer.unref();
      app.addHook('onClose', () => {
        clearInterval(timer);
      });
    }
    releaseRoutes(releases, clock, installers, uploads)(app);
    if (updateChannel !== null && versionCatalog !== null) {
      updateChannelRoutes({ service: updateChannel, catalog: versionCatalog, clock })(app);
    }
    releaseDownloadRoutes(releases, limiter, deps.releases?.downloadRateLimit)(app);
    installerRoutes(installers)(app);
    installerDownloadRoutes(installers, limiter, deps.installers?.downloadRateLimit)(app);
  };
  let live: { store: LiveStore; streams: LiveStreams; bus: LiveBus } | null = null;
  const lc = deps.live ?? {};
  let notifications: NotificationService | null = null;
  let uptimeProbe: Probe | null = null;
  const nd = deps.notifications ?? {};
  // p17-panel-settings Part 1: the notification channels the panel configures while the master runs — the one SMTP
  // configuration (the owner's, stored with the support settings, else NOTIFY_SMTP_*), the webhook allowlist + HMAC
  // secret and Web Push (VAPID key pair generated by the master, subject, endpoint allowlist), each over the
  // environment's value. A notifier a test passes for a channel wins over the dynamic one.
  const mailSettings = new MailSettings({
    pool: deps.pool,
    sealKey: deps.box.deriveKey('support-smtp'),
    env: deps.doctor?.notificationSmtp ?? null,
    ...(deps.doctor?.smtpCa === undefined ? {} : { ca: deps.doctor.smtpCa }),
    ...(deps.doctor?.smtpTimeoutMs === undefined ? {} : { timeoutMs: deps.doctor.smtpTimeoutMs }),
  });
  await mailSettings.refresh();
  const webhookNow = (): WebhookSettings | null => {
    const allowlist = listOf(panelSettings, 'notify.webhook.allowlist');
    const secret = panelSettings.secret('notify.webhook.secret');
    if (allowlist.length === 0 || secret === null) return null;
    const next = panelSettings.secret('notify.webhook.nextSecret');
    return {
      allowlist,
      secret: Buffer.from(secret, 'utf8'),
      ...(next === null ? {} : { nextSecret: Buffer.from(next, 'utf8') }),
    };
  };
  let vapidCache: { pem: string; keys: VapidKeys } | null = null;
  const pushNow = (): PushVapid | null => {
    const pem =
      panelSettings.secretSource('push.vapidKey') === 'panel' ? panelSettings.secret('push.vapidKey') : null;
    let vapid = nd.push?.vapid ?? null;
    if (pem !== null) {
      if (vapidCache?.pem !== pem) {
        try {
          vapidCache = { pem, keys: vapidKeysFromPem(pem) };
        } catch {
          vapidCache = null;
        }
      }
      vapid = vapidCache?.keys ?? null;
    }
    const subject = panelSettings.value<string>('push.subject') ?? nd.push?.subject ?? null;
    if (vapid === null || subject === null || subject === '') return null;
    const allow =
      panelSettings.source('push.endpointAllowlist') === 'panel'
        ? listOf(panelSettings, 'push.endpointAllowlist')
        : nd.push?.endpointAllowlist;
    return {
      vapid,
      subject,
      ...(nd.push?.ttlSeconds === undefined ? {} : { ttlSeconds: nd.push.ttlSeconds }),
      ...(nd.push?.fetchImpl === undefined ? {} : { fetchImpl: nd.push.fetchImpl }),
      ...(allow === undefined || allow.length === 0 ? {} : { endpointAllowlist: [...allow] }),
    };
  };
  const channelNotifiers: Notifier[] = [
    ...(nd.notifiers ?? []),
    ...((nd.notifiers ?? []).some((n) => n.channel === 'email')
      ? []
      : [new DynamicSmtpNotifier(mailSettings, clock)]),
    ...((nd.notifiers ?? []).some((n) => n.channel === 'webhook')
      ? []
      : [new DynamicWebhookNotifier(webhookNow, clock, nd.webhookTestSeams ?? {})]),
  ];
  // p16-webhooks-out (ADR-0059): outgoing webhooks; secrets sealed with an HKDF sub-key of the master key.
  const wo = deps.webhooksOut ?? {};
  const webhooksOut = new WebhookService({
    pool: deps.pool,
    audit,
    clock,
    sealKey: deps.box.deriveKey('webhooks-out'),
    sender: wo.sender ?? createWebhookSender(),
    // p17-domain-wizard: the saved console address wins over NOTIFY_PUBLIC_URL.
    publicUrl: { current: () => consoleDomain.notifyBase() },
    notifications: () => notifications,
    ...(wo.options === undefined ? {} : { options: wo.options }),
    ...(wo.random === undefined ? {} : { random: wo.random }),
  });
  // p10-backup-restore: reads what the backup service reports; notifications once they exist.
  const backupStatus = new BackupStatusService({
    dir: deps.backups?.statusDir ?? null,
    pool: deps.pool,
    notifications: () => notifications,
    clock,
    ...(deps.backups?.intervalMs === undefined ? {} : { intervalMs: deps.backups.intervalMs }),
  });
  // p16-selfhost-onboarding: the signed update feed, the first-owner setup token and the setup wizard.
  const updateFeed = new UpdateFeedService({
    currentVersion: deps.updates?.currentVersion ?? null,
    keys: deps.updates?.keys ?? [],
    feedUrl: deps.updates?.feedUrl ?? null,
    feedFile: deps.updates?.feedFile ?? null,
    clock,
    ...(deps.updates?.fetch === undefined ? {} : { fetch: deps.updates.fetch }),
    ...(deps.updates?.intervalMs === undefined ? {} : { intervalMs: deps.updates.intervalMs }),
    ...(deps.updates?.fileIntervalMs === undefined ? {} : { fileIntervalMs: deps.updates.fileIntervalMs }),
  });
  // p17-host-actions: control-plane update / rollback (and backups) through the remyral-ctl host applier.
  const hostActions = new HostActionService({
    pool: deps.pool,
    audit,
    clock,
    hostDir: cdc.hostDir ?? null,
    signer,
    feedRelease: (v) => updateFeed.release(v),
    ...(cdc.heartbeatMaxAgeMs === undefined ? {} : { heartbeatMaxAgeMs: cdc.heartbeatMaxAgeMs }),
    ...(cdc.requestTtlMs === undefined ? {} : { requestTtlMs: cdc.requestTtlMs }),
    ...(cdc.applyingTimeoutMs === undefined ? {} : { applyingTimeoutMs: cdc.applyingTimeoutMs }),
  });
  // p17-host-actions part 3: backups managed from Ayarlar → Yedekler (requests for the host applier, sealed off-site keys).
  const backupManage = new BackupManageService({
    pool: deps.pool,
    audit,
    clock,
    host: hostActions,
    blobs: blobService,
    storage: storageSettings,
    status: backupStatus,
  });
  // p17-panel-settings Part 4: account recovery of other users from the panel (instead of admin:reset on the host).
  const userRecovery = new UserRecoveryService({
    pool: deps.pool,
    audit,
    clock,
    notifications: () => notifications,
    ...(deps.passwordParams === undefined ? {} : { passwordParams: deps.passwordParams }),
  });
  // p17-panel-settings Part 0: tells every owner about a backup change waiting for the host time lock (and 24 h before).
  const backupChanges = new BackupChangeWatch({
    pool: deps.pool,
    audit,
    clock,
    host: hostActions,
    notifications: () => notifications,
  });
  const setupService = new SetupService({
    pool: deps.pool,
    audit,
    clock,
    ...(deps.passwordParams === undefined ? {} : { passwordParams: deps.passwordParams }),
  });
  const onboarding = new OnboardingService({ pool: deps.pool, audit, clock });
  // p16-observability: the log search (the sink is fed by main.ts's redacting log stream), the status page.
  const obs = deps.observability ?? {};
  const logStoreConfig = obs.logStore ?? DEFAULT_LOG_STORE;
  const logStore: LogStore | null =
    obs.logSink === undefined
      ? null
      : // Wall clock, not the injectable one: the lines carry pino's wall-clock time.
        new LogStore({ pool: deps.pool, sink: obs.logSink, config: logStoreConfig });
  // p17-panel-settings: log retention / level / request lines from the panel, applied without a restart.
  const applyLogSettings = (): void => {
    if (logStore === null) return;
    if (
      !['logs.retentionDays', 'logs.level', 'logs.requests'].some((k) => panelSettings.source(k) === 'panel')
    )
      return;
    logStore.configure({
      retentionDays: panelSettings.get<number>('logs.retentionDays', logStoreConfig.retentionDays),
      minLevel: panelSettings.get<string>(
        'logs.level',
        logStoreConfig.minLevel,
      ) as LogStoreConfig['minLevel'],
      requests: panelSettings.get<string>(
        'logs.requests',
        logStoreConfig.requests,
      ) as LogStoreConfig['requests'],
    });
  };
  applyLogSettings();
  panelSettings.onChange((keys) => {
    if (keys.some((k) => k.startsWith('logs.'))) {
      if (logStore !== null && keys.every((k) => panelSettings.source(k) !== 'panel'))
        logStore.configure(logStoreConfig);
      applyLogSettings();
    }
  });
  const systemStatus = new SystemStatusService({
    pool: deps.pool,
    redis: deps.redis,
    clock,
    releaseTag: obs.releaseTag ?? null,
    webUrl: obs.webUrl ?? null,
    ...(obs.webFetch === undefined ? {} : { fetch: obs.webFetch }),
    diskPaths: obs.diskPaths ?? { data: deps.backups?.statusDir ?? null, root: null },
    history: obs.history ?? null,
    traces: obs.recentTraces ?? null,
    tracing: { enabled: deps.telemetry?.tracing ?? false, exporting: deps.telemetry?.exporting ?? false },
    logs: logStore,
    ...(obs.statusCacheMs === undefined ? {} : { cacheMs: obs.statusCacheMs }),
    ...(obs.statusThresholds === undefined ? {} : { thresholds: obs.statusThresholds }),
    backups: () => backupStatus,
    fleet: () => fleet,
    integrations: () => opsIntegrations,
    github: () => githubConnect,
    feedEnabled: () => fleetToolFeed?.enabled ?? false,
  });
  const notificationApi: RoutePlugin = (app) => {
    if (notifications === null) throw new Error('notification service not initialised');
    notificationRoutes(notifications, clock)(app);
  };

  // Enabled budgets evaluated in their current window (metrics gauge and the budget alert rule).
  const budgetSamples = async () =>
    (await usage.evaluateBudgetsOfScopes(['global', 'project', 'runtime', 'provider', 'worker'])).map(
      (b) => ({
        id: b.budget.id,
        metric: b.evaluation.metric,
        scope: b.budget.scope.type,
        ratio: Number.isFinite(b.evaluation.ratio) ? b.evaluation.ratio : 0,
        complete: b.evaluation.complete,
      }),
    );

  const am = deps.agentmagnify;
  const forwarder =
    am === undefined
      ? null
      : new AgentMagnifyForwarder({
          apiUrl: am.apiUrl,
          token: am.token,
          pool: deps.pool,
          ...(am.projectName === undefined ? {} : { projectName: am.projectName }),
          ...(am.fetch === undefined ? {} : { fetch: am.fetch }),
        });
  const alertListeners = [
    ...(deps.alerts?.listeners ?? []),
    ...(forwarder === null ? [] : [forwarder.onAlert]),
  ];

  // p16-ops-safety (docs/design/p16-ops-safety.md): keys and expiry, the model cost brake, the chat turn guard, and the
  // rollout breaker (created with the release service below).
  const osd = deps.opsSafety ?? {};
  const costBrake = new CostBrakeService({
    pool: deps.pool,
    audit,
    clock,
    settings: async () => (await securityPolicy.current()).costBrake,
    jobSpend: async (project, from, to) =>
      (await usage.consumption(project === null ? {} : { project }, from, to)).costUsd.total,
    notifications: () => notifications,
    ...(osd.brakeCacheMs === undefined ? {} : { cacheMs: osd.brakeCacheMs }),
  });
  const expiry = new ExpiryService({
    pool: deps.pool,
    audit,
    clock,
    notifications: () => notifications,
    publicOrigin: consoleDomain.overlay(osd.publicOrigin),
    readCertificate: osd.readCertificate ?? ((origin) => readServedCertificate(origin)),
    cloudflareVerify: async () => {
      const c = await opsIntegrations.cloudflare();
      if (c === null) return null;
      const v = await c.client.verify();
      return { status: v.status, expiresOn: v.expiresOn };
    },
    keyFiles: osd.keyFiles ?? [],
    ...(osd.mtime === undefined ? {} : { mtime: osd.mtime }),
    ...(osd.checkEveryMs === undefined ? {} : { checkEveryMs: osd.checkEveryMs }),
    // p16-git-providers: GitLab reports its tokens' expiry; re-tested with the other outside checks.
    gitHostsCheck: (everyMs, force) => gitHosts.refreshExpiries(everyMs, force),
  });
  let rolloutBreaker: RolloutBreaker | null = null;
  const opsSafetyReader = new OpsSafetyReader({ expiry, brake: costBrake, breaker: () => rolloutBreaker });
  // p16-doctor (ADR-0062): the doctor's checks read the services above; the support report packs their results.
  const dd = deps.doctor ?? {};
  const doctor = new DoctorService({
    pool: deps.pool,
    audit,
    clock,
    remoteOps: () => remoteOps,
    notifications: () => notifications,
    ...(dd.workerWaitMs === undefined ? {} : { workerWaitMs: dd.workerWaitMs }),
    ...(dd.dailyEveryMs === undefined ? {} : { dailyEveryMs: dd.dailyEveryMs }),
    sources: {
      pool: deps.pool,
      redis: deps.redis,
      clock,
      status: () => systemStatus.snapshot(),
      expiry: async () => (await expiry.list()).items,
      costBrake: () => costBrake.current(),
      chat: async () => (chat === null ? null : chat.routingSummary()),
      backups: () => backupStatus.overview(),
      logs: () => logStore,
      // p17-object-storage: the blob store answers (a HEAD of a missing key), local free space, bytes still in Postgres.
      storage: async () => {
        const s = await storageSettings.status();
        const s3 = s.mode === 's3' ? await blobService.activeS3() : null;
        let probe: { ok: boolean; error: string | null; ms: number } | null = null;
        if (s3 !== null) {
          const started = Date.now();
          probe = await s3.client.head('artifacts/remyral-doctor-probe').then(
            () => ({ ok: true, error: null, ms: Date.now() - started }),
            (err: unknown) => ({
              ok: false,
              error:
                err instanceof Error && 'code' in err ? String((err as { code: unknown }).code) : 'error',
              ms: Date.now() - started,
            }),
          );
        }
        return { mode: s.mode, problem: s.problem, probe, local: s.local, legacyBytes: s.legacyBytes };
      },
      ...(dd.migrationsDir === undefined ? {} : { migrationsDir: dd.migrationsDir }),
    },
  });
  const support = new SupportService({
    pool: deps.pool,
    audit,
    clock,
    sealKey: deps.box.deriveKey('support-smtp'),
    doctor,
    status: () => systemStatus.snapshot(),
    logs: () => logStore,
    config: dd.config ?? null,
    securityPreset: async () => (await securityPolicy.current()).preset,
    releaseTag: obs.releaseTag ?? null,
    notificationSmtp: dd.notificationSmtp ?? null,
    // p17-panel-settings: the one SMTP configuration — a save here re-reads it for the notification e-mail at once.
    onSmtpChanged: () => mailSettings.refresh(),
    ...(dd.smtpCa === undefined ? {} : { smtpCa: dd.smtpCa }),
    ...(dd.smtpTimeoutMs === undefined ? {} : { smtpTimeoutMs: dd.smtpTimeoutMs }),
    ...(dd.maxAttachmentBytes === undefined ? {} : { maxAttachmentBytes: dd.maxAttachmentBytes }),
    ...(dd.maxLogLines === undefined ? {} : { maxLogLines: dd.maxLogLines }),
  });
  // The owner's request budgets (security policy `limits`), scaled like the configured class budgets (RATE_LIMIT_SCALE,
  // test harnesses); a value left at its default keeps the configured budget exactly.
  const requestPolicy = deps.requestLimits ?? DEFAULT_REQUEST_LIMITS;
  const tokenPolicy = deps.tokenLimits ?? TOKEN_REQUEST_LIMITS;
  const scaleOf = (configured: number | undefined, base: number | undefined): number =>
    configured === undefined || base === undefined || base === 0 ? 1 : configured / base;
  const userScale = {
    read: scaleOf(requestPolicy.read.perUser?.max, DEFAULT_REQUEST_LIMITS.read.perUser?.max),
    write: scaleOf(requestPolicy.write.perUser?.max, DEFAULT_REQUEST_LIMITS.write.perUser?.max),
  };
  const tokenScale = {
    read: scaleOf(tokenPolicy.perToken.read.max, TOKEN_REQUEST_LIMITS.perToken.read.max),
    write: scaleOf(tokenPolicy.perToken.write.max, TOKEN_REQUEST_LIMITS.perToken.write.max),
  };
  const ownerUserLimits = async (): Promise<Partial<Record<'read' | 'write', number>>> => {
    const l = (await securityPolicy.current()).limits;
    return {
      ...(l.userReadPerMinute === DEFAULT_LIMITS.userReadPerMinute
        ? {}
        : { read: l.userReadPerMinute * userScale.read }),
      ...(l.userWritePerMinute === DEFAULT_LIMITS.userWritePerMinute
        ? {}
        : { write: l.userWritePerMinute * userScale.write }),
    };
  };
  const ownerTokenLimits = async (): Promise<Partial<Record<'read' | 'write', number>>> => {
    const l = (await securityPolicy.current()).limits;
    return {
      ...(l.tokenReadPerMinute === DEFAULT_LIMITS.tokenReadPerMinute
        ? {}
        : { read: l.tokenReadPerMinute * tokenScale.read }),
      ...(l.tokenWritePerMinute === DEFAULT_LIMITS.tokenWritePerMinute
        ? {}
        : { write: l.tokenWritePerMinute * tokenScale.write }),
    };
  };
  const turnGuard = new TurnGuard({
    limiter: new FallbackRateLimiter(limiter, () => undefined),
    limits: async () => (await securityPolicy.current()).limits,
    scale: userScale.write,
    brake: () => costBrake,
  });

  // p17-panel-settings: section hooks — the network section shows the client IP the master sees and refuses a change
  // that would give this very request another IP unless the owner confirms it (no unknowing lock-out).
  const vapidChanged = new WeakSet<object>();
  const panelHooks: PanelRouteHooks = {
    afterSave: async (section, request) => {
      // The search provider follows at once (other instances on their next indexer pass).
      if (section === 'search') await bedrock.refresh(actorOf(request));
      if (section === 'notifications' && vapidChanged.delete(request)) {
        const { rowCount } = await deps.pool.query('DELETE FROM push_subscriptions');
        const a = actorOf(request);
        await audit.record({
          actor: { type: 'user', id: a.userId },
          ip: a.ip,
          userAgent: a.userAgent,
          action: 'notifications.push.reset',
          target: 'push-subscriptions',
          outcome: 'success',
          metadata: { removed: rowCount ?? 0, reason: 'vapid key changed' },
        });
      }
    },
    info: async (section, request) =>
      section === 'network'
        ? {
            clientIp: request.ip,
            socketAddress: request.socket.remoteAddress ?? '',
            forwardedFor: String(request.headers['x-forwarded-for'] ?? ''),
          }
        : section === 'jobs'
          ? // p17-output-limits: what decides the output path (the blob store's state and limits, the inline budget).
            { outputs: { ...(await outputServer()), ...OUTPUT_INLINE_INFO } }
          : {},
    beforeSave: async (section, update, request, confirm) => {
      if (section === 'notifications' && (update.generate ?? []).includes('push.vapidKey')) {
        // A new VAPID key pair makes every browser's push subscription invalid: they are removed after the save and
        // people turn push on again (Ayarlar → Cihazlar). The owner confirms that first.
        const { rows } = await deps.pool.query<{ n: number }>(
          'SELECT count(*)::int AS n FROM push_subscriptions',
        );
        const devices = rows[0]?.n ?? 0;
        if (devices > 0 && !confirm.includes('push_resubscribe')) {
          throw new HttpError(
            409,
            'push_key_change',
            'A new push key turns push off on every device that has it on; confirm to continue.',
            {},
            { details: { devices } },
          );
        }
        vapidChanged.add(request);
      }
      if (section === 'workflows') {
        // Engine 2 for version-1 workflows only after the normalise check passes (the CLI's dry run, run here).
        const turnsOn = (key: string): boolean =>
          update.values?.[key] === true && !panelSettings.get<boolean>(key, false);
        if (turnsOn('workflow.engineV2ForV1')) {
          const r = await checkStoredDefinitions(deps.pool);
          if (r.failures.length > 0) {
            throw new HttpError(
              409,
              'workflow_check_failed',
              'Some stored workflow definitions do not convert to engine 2; fix them before switching.',
              {},
              { details: { failures: r.failures.length } },
            );
          }
        }
        return;
      }
      if (section !== 'network') return;
      const next = (key: string): SettingValue | null => {
        const v = update.values?.[key];
        if (v === undefined) return panelSettings.value(key);
        return v === null
          ? (panelSettings.view('network').fields.find((f) => f.key === key)?.envValue ?? null)
          : v;
      };
      const after = clientIpUnder(
        request.socket.remoteAddress ?? request.ip,
        request.headers['x-forwarded-for'],
        request.headers,
        {
          hops: Number(next('net.trustProxyHops') ?? 0),
          header: String(next('net.clientIpHeader') ?? ''),
          sources: [...((next('net.clientIpSources') as readonly string[] | null) ?? [])],
        },
      );
      if (after !== request.ip && !confirm.includes('client_ip_change')) {
        throw new HttpError(
          409,
          'client_ip_would_change',
          'With these settings the master would see this request from another address; confirm to save anyway.',
          {},
          { details: { current: request.ip, after } },
        );
      }
    },
  };
  panelSettings.validator('network', networkRules);
  panelSettings.validator('sessions', sessionRules);
  panelSettings.validator('workflows', workflowRules);
  panelSettings.validator('notifications', notificationRules);
  panelSettings.validator('search', searchRules);
  /** p22-ops-hygiene: the request limiter's own fallback warning, at most once per 5 minutes. */
  let limiterWarnedAt = 0;
  const app = await buildApp({
    logLevel: deps.logLevel,
    dependencyHealth: () => dependencyHealth,
    // p17-panel-settings: trusted proxy hops and the CDN client-IP header are read per request.
    trustProxyHops: () => panelSettings.get<number>('net.trustProxyHops', deps.trustProxyHops),
    clientIpHeader: () => networkClientIp(panelSettings),
    bodyLimitBytes: deps.bodyLimitBytes,
    requestLimits: {
      // Redis-shared windows; a Redis outage degrades to per-process windows (never unlimited).
      limiter: new FallbackRateLimiter(limiter, (err) => {
        // Called only while serving requests, i.e. after `app` below is initialised. p22-ops-hygiene: the outage
        // itself is logged once by the health gate.
        // the gate confirms a real Redis outage with a probe; a limiter that fails while Redis still answers PING
        // would then be silent, so the fallback itself still warns — at most once per 5 minutes.
        if (dependencyHealth !== null) void dependencyHealth.report(err);
        const now = Date.now();
        if (now - limiterWarnedAt < 5 * 60_000) return;
        limiterWarnedAt = now;
        app.log.warn(
          { errName: err instanceof Error ? err.name : 'error' },
          'request rate limiter: Redis unavailable, using per-process limits',
        );
      }),
      policy: deps.requestLimits ?? DEFAULT_REQUEST_LIMITS,
      audit,
      ownerLimits: ownerUserLimits,
    },
    ...(deps.httpTimeouts ? { timeouts: deps.httpTimeouts } : {}),
    ...(deps.logStream ? { logStream: deps.logStream } : {}),
    authenticator: withBearerTokens(
      createSessionAuthenticator({
        pool: deps.pool,
        audit,
        clock,
        stepUp: stepUpPolicy,
        securityPolicy,
      }),
      {
        tokens: apiTokens,
        usage: tokenUsage,
        securityPolicy,
        audit,
        sampler: new FallbackRateLimiter(limiter, tokenWarn('api token audit sampler: Redis unavailable')),
        clock,
      },
    ),
    tokenLimits: {
      limiter: new FallbackRateLimiter(limiter, tokenWarn('api token limiter: Redis unavailable')),
      guard: new FallbackConcurrencyGuard(
        new RedisConcurrencyGuard(deps.redis, deps.rateLimitPrefix),
        tokenWarn('api token concurrency: Redis unavailable, using per-process slots'),
      ),
      policy: deps.tokenLimits ?? TOKEN_REQUEST_LIMITS,
      audit,
      ownerLimits: ownerTokenLimits,
    },
    authorizer: createAuthorizer({ db: deps.pool, audit }),
    ...(deps.authzProbe === true ? { authzProbe: true } : {}),
    ...(deps.telemetry ? { telemetry: deps.telemetry } : {}),
    ideOrigin,
    beforeRoutes: (instance) => {
      // p22-ops-hygiene: the dependency-health gate, probing (PING / SELECT 1, backing off) only while one is down.
      const health = new DependencyHealth({
        log: instance.log.child({ component: 'dependency-health' }),
        probes: {
          redis: () => deps.redis.ping(),
          postgres: () => deps.pool.query('SELECT 1'),
        },
      });
      dependencyHealth = health;
      const stopHealth = health.start();
      instance.addHook('onClose', () => {
        stopHealth();
        return Promise.resolve();
      });
      securityLog = instance.log.child({ component: 'security-policy' });
      tokenLog = instance.log.child({ component: 'api-tokens' });
      blobLog = instance.log.child({ component: 'blobs' });
      instance.decorate('blobs', blobService);
      instance.decorate('blobUploads', blobUploads);
      tokenUsage.start();
      instance.addHook('onClose', async () => {
        await tokenUsage.stop().catch((err: unknown) => {
          tokenLog?.warn({ err }, 'api token usage flush on close failed');
        });
      });
      instance.decorate('apiTokens', { service: apiTokens, flushUsage: () => tokenUsage.flush() });
      // p15-auto-mode (migration 0126): policy versions a migration wrote are audited once by the master.
      instance.addHook('onReady', async () => {
        await securityPolicy.auditMigrationVersions().catch((err: unknown) => {
          securityLog?.error({ err }, 'auditing the migration policy versions failed');
        });
      });
      hub = new WorkerHub(instance.log.child({ component: 'worker-hub' }));
      routingLog = instance.log.child({ component: 'routing' });
      fleet = new FleetService({ pool: deps.pool, audit, hub, clock });
      rotation = new RotationService({
        pool: deps.pool,
        audit,
        hub,
        clock,
        log: instance.log.child({ component: 'rotation' }),
        requiresApproval: () =>
          panelSettings.get<boolean>('workers.rotationApproval', w.rotationRequiresApproval ?? false),
      });
      ({ releases, installers } = createReleaseServices(
        { pool: deps.pool, audit, hub, clock, log: instance.log.child({ component: 'releases' }) },
        {
          ...deps,
          // p17-domain-wizard: install commands use the saved console address at once.
          installers: {
            ...deps.installers,
            publicOrigin: consoleDomain.overlay(deps.installers?.publicOrigin),
          },
        },
      ));
      {
        const uc = deps.updateChannel;
        const channelLog = instance.log.child({ component: 'update-channel' });
        const channel = new UpdateChannelService({
          pool: deps.pool,
          audit,
          hub,
          clock,
          log: channelLog,
          releases,
          installers,
          notifications: () => notifications,
          releaseKeys: deps.releases?.publicKeys ?? [],
          feedUrl: uc?.feedUrl ?? null,
          feedFile: uc?.feedFile ?? null,
          ...(uc?.fetch === undefined ? {} : { fetch: uc.fetch }),
          ...(uc?.intervalMs === undefined ? {} : { intervalMs: uc.intervalMs }),
          ...(uc?.fileIntervalMs === undefined ? {} : { fileIntervalMs: uc.fileIntervalMs }),
          ...(uc?.retryMs === undefined ? {} : { retryMs: uc.retryMs }),
        });
        const catalogService = new VersionCatalogService({
          pool: deps.pool,
          audit,
          hub,
          clock,
          log: channelLog,
          enabled: uc?.catalog ?? true,
          keys: uc?.catalogKeys ?? [],
          feedKeys: () => channel.feedCatalogKeys(),
          url: uc?.catalogUrl ?? null,
          file: uc?.catalogFile ?? null,
          ...(uc?.fetch === undefined ? {} : { fetch: uc.fetch }),
          ...(uc?.intervalMs === undefined ? {} : { intervalMs: uc.intervalMs }),
          ...(uc?.fileIntervalMs === undefined ? {} : { fileIntervalMs: uc.fileIntervalMs }),
        });
        updateChannel = channel;
        versionCatalog = catalogService;
        instance.decorate('updateChannel', channel);
        instance.decorate('versionCatalog', catalogService);
        instance.addHook('onReady', async () => {
          await catalogService.current().catch((err: unknown) => {
            channelLog.error({ err }, 'loading the stored version catalog failed');
          });
        });
      }
      // p16-ops-safety: the rollout circuit breaker judges every final update outcome right away.
      {
        const workerHub = hub;
        const breakerLog = instance.log.child({ component: 'rollout-breaker' });
        const breaker = new RolloutBreaker({
          pool: deps.pool,
          audit,
          clock,
          releases,
          settings: async () => (await securityPolicy.current()).rollout,
          connected: (workerId) => workerHub.get(workerId) !== undefined,
          notifications: () => notifications,
          log: breakerLog,
        });
        rolloutBreaker = breaker;
        // p17-worker-managed: a rolled-back / failed machine update is a notification, not only a list entry.
        releases.notifyFailuresWith(() => notifications);
        releases.observeOutcomes(() => {
          void breaker.evaluate().catch((err: unknown) => {
            breakerLog.error({ err }, 'rollout breaker evaluation failed');
          });
        });
      }
      const policies = new RuntimePolicyService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'runtime-policy' }),
        // The outbox lives in the session handler created below (WorkerReplay).
        outbox: {
          enqueue: (workerId, type, payload) => {
            if (fleetSessions === null) throw new Error('fleet sessions not initialised');
            return fleetSessions.replay.enqueue(workerId, type, payload);
          },
        },
      });
      runtimePolicies = policies;
      instance.decorate('runtimePolicies', policies);
      // ADR-0015: panel-managed worker configuration, delivered over the live session (control message).
      const workerHub = hub;
      const vaultService = new VaultService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'vault' }),
        signer,
        session: (workerId) => workerHub.get(workerId)?.session ?? undefined,
      });
      vault = vaultService;
      const remoteOpsService = new RemoteOpsService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'remote-ops' }),
        signer,
        limiter,
        session: (workerId) => workerHub.get(workerId)?.session ?? undefined,
        ...(deps.remoteOpsLimits === undefined ? {} : { limits: deps.remoteOpsLimits }),
        // p5-sandbox-ops: login → auth (local-login) when the runtime's auth is unset.
        onLoginSucceeded: (workerId, runtime) =>
          workerConfigs === null
            ? Promise.resolve()
            : workerConfigs.onLoginSucceeded(workerId, runtime, null),
        // p14-mcp-core: tools found by an `mcp.probe`.
        onMcpProbe: () => mcp,
        // p14-mcp-stdio: install state per machine and the canary's lockfile.
        onMcpInstall: () => mcp.stdio,
        // p16-runtime-updates: locks of unverified installs and the results of runtime.verify.
        onRuntimeUpdate: () => fleetTools,
        // p17-runtime-verify: the signed evidence of runtime.capabilities.verify (verified, then stored).
        onCapabilityVerify: () => capabilityEvidence,
        // p15-usage-refresh: the readings of a usage.refresh.
        onUsageRefresh: (workerId, snapshots) => runtimeUsage.onRefreshSnapshots(workerId, snapshots),
        // p17-worker-managed: an accepted removal revokes the worker.
        onManageFinished: (input) => workerRemovals?.onManageFinished(input) ?? Promise.resolve(),
      });
      remoteOps = remoteOpsService;
      capabilityEvidence = new CapabilityEvidenceService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'capability-evidence' }),
        limiter,
        remoteOps: () => remoteOpsService,
        connected: (workerId) => workerHub.get(workerId) !== undefined,
      });
      workerRemovals = new WorkerRemovalService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'worker-removal' }),
        remoteOps: () => remoteOpsService,
        fleet: () => fleet,
        connected: (workerId) => workerHub.get(workerId) !== undefined,
      });
      workerConfigs = new WorkerConfigService({
        credentialOptions: (workerId) => vaultService.options(workerId),
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'worker-config' }),
        signer,
        session: (workerId) => workerHub.get(workerId)?.session ?? undefined,
        // p17-panel-settings Part 5: the panel key(s) in effect, read at use time (a rotation reaches the machines).
        panelSkillKeys: liveList(panelSkillKeysNow),
        // p13-runtime-accounts: the added accounts in the delivered document.
        accounts: () => runtimeAccounts,
      });
      const configs = workerConfigs;
      capacity = new CapacityService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'capacity' }),
        setConfiguredParallelism: (workerId, value, actor, note) =>
          configs.setCapacityParallelism(workerId, value, actor, note),
      });
      const capacityService = capacity;
      const uc = deps.uptime ?? {};
      // p14-workflow-engine 14.2: the workflow `uptime.check` node uses the same guarded probe.
      uptimeProbe = uc.probe ?? createProbe({ allowOrigins: uc.allowOrigins ?? [] });
      uptime = new UptimeService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'uptime' }),
        probe: uptimeProbe,
        providers: uc.providers ?? createProviderChecks(opsIntegrations, () => performance.now()),
        outputs: () => outputsService,
        allowOrigins: uc.allowOrigins ?? [],
        ...(uc.limits === undefined ? {} : { limits: uc.limits }),
        // p13-multi-coolify: Coolify monitors check through a connection the project may use.
        coolifyConnection: (project, uuid, connection) =>
          opsIntegrations.coolifyConnections.resolveForMonitor(project, uuid, connection),
      });
      const uptimeService = uptime;
      // ADR-0021: a new (or first) panel skills key reaches every managed worker that understands it.
      void configs.syncPanelSkillKeys();
      // p17-panel-settings Part 5: a rotated / retired panel key goes out as a new managed configuration generation.
      panelSettings.onChange((keys) => {
        if (keys.includes('skills.panelKey') || keys.includes('skills.panelKeyRetired'))
          void configs.syncPanelSkillKeys();
      });
      sandboxOps = new SandboxOpsService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'sandbox-ops' }),
        remoteOps: () => remoteOpsService,
        workerConfigs: () => configs,
        session: (workerId) => workerHub.get(workerId)?.session ?? undefined,
        leaseKeys: () => signer.keys(),
      });
      models = new ModelCatalogService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'models' }),
        onChanged: async (id, actor) => {
          await workerConfigs?.onCatalogChanged(id, actor);
        },
      });
      gitConfigs.onRepositoryChanged((project, actor) =>
        workerConfigs?.onProjectRepositoryChanged(project, actor),
      );
      const workspaceService = new WorkspaceService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'workspaces' }),
        // p17-object-storage: ARTIFACT_REF `blobUploadId` commits a verified upload.
        uploads: () => blobUploads,
        // p17-output-limits: the server's limits in the workspace settings; the job's output report.
        outputServer,
        outputLimits: () => outputLimits,
      });
      workspaces = workspaceService;
      // p5-research-workspace-next: retention and storage quota of workspace projects.
      const storageSweeper = new StorageSweeper({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'workspace-storage' }),
      });
      workspaceService.onSettingsChanged(async (project, actor) => {
        // p22-worker-limits: a workspace project's services get its changed egress setting (as a repository
        // project's do on a Network access change); each re-send logs its own failure.
        await services?.onEgressChanged(project).catch(() => undefined);
        if (workerConfigs !== null)
          await workerConfigs.onWorkspaceChanged(project, { userId: actor.userId, ip: '', userAgent: null });
      });
      const leaseTtlMs = o.timing?.leaseTtlMs ?? 90_000;
      // Integration glue: approvals, usage and agent memory from worker EVENTs; context with ASSIGN_JOB.
      // p5-machine-admin (ADR-0021): elevated machine-admin jobs, their command log and the machine memory.
      const machineAdminService = new MachineAdminService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'machine-admin' }),
        signer,
        jobs,
        approvals,
        context,
        workerConfigs: () => configs,
        remoteOps: () => remoteOpsService,
        dispatch: (jobId) => (orchestrator === null ? Promise.resolve() : orchestrator.dispatch(jobId)),
        session: (workerId) => workerHub.get(workerId)?.session ?? undefined,
        // p19-chat-machine-admin: elevated commands of a job the user's own chat message started pass by policy.
        securityPolicy,
      });
      machineAdmin = machineAdminService;
      const feedService = new VersionFeedService({
        pool: deps.pool,
        clock,
        log: instance.log.child({ component: 'fleet-tools' }),
        fetch: deps.fleetTools?.fetch ?? null,
        ...(deps.fleetTools?.feedTtlMs === undefined ? {} : { ttlMs: deps.fleetTools.feedTtlMs }),
      });
      fleetToolFeed = feedService;
      // p16-runtime-updates: runtime releases outside the pins (exact registry version documents) and their automatic
      // verification on a canary machine — both only while the security policy allows unverified runtime updates.
      const unverifiedAllowed = async () => (await securityPolicy.current()).fleet.unverifiedRuntimeUpdates;
      const runtimeReleases = new RuntimeReleases({
        pool: deps.pool,
        clock,
        getJson: feedService.enabled ? (url) => feedService.getJson(url) : null,
      });
      const runtimeVerification = new RuntimeVerificationService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'runtime-verify' }),
        releases: runtimeReleases,
        feed: feedService,
        remoteOps: () => remoteOpsService,
        connected: (workerId) => workerHub.get(workerId)?.session !== undefined,
        allowed: unverifiedAllowed,
      });
      feedService.onChange((items) => {
        if (items.some((i) => CATALOG.some((c) => c.id === i && c.runtime !== undefined))) {
          void runtimeVerification.tick(true, 'feed').catch((err: unknown) => {
            instance.log.warn({ err }, 'runtime verification after a feed change failed');
          });
        }
      });
      const fleetToolsService = new FleetToolsService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'fleet-tools' }),
        feed: feedService,
        recipes: customToolRecipes,
        remoteOps: () => remoteOpsService,
        machineAdmin: () => machineAdminService,
        connected: (workerId) => workerHub.get(workerId)?.session !== undefined,
        notify: () => notifications,
        // p14-mcp-stdio: the stored lockfile every non-canary machine installs exactly.
        mcpLock: (serverId, version) => mcp.stdio.lock(serverId, version),
        // p19-install-scripts (ADR-0068): the active approvals, only to machines that run approved install scripts.
        mcpInstallScripts: async (workerId) => {
          const { rows } = await deps.pool.query<{ ok: boolean }>(
            'SELECT features ? $2 AS ok FROM workers WHERE id = $1',
            [workerId, MCP_INSTALL_SCRIPTS_FEATURE],
          );
          return rows[0]?.ok === true ? installScriptApprovals.active() : null;
        },
        // p16-runtime-updates: the policy switch, runtime releases outside the pins, the verification.
        policy: async () => ({ unverifiedRuntimeUpdates: await unverifiedAllowed() }),
        releases: runtimeReleases,
        verification: () => runtimeVerification,
        // p17-update-channel: the matrix shows and offers the version catalog's versions.
        versionCatalog: () => versionCatalog?.latest()?.catalog ?? null,
      });
      fleetTools = fleetToolsService;
      // p17-update-channel: the owner's upgrade of a runtime / tool to an exact upstream version.
      ownerUpgrades = new OwnerUpgradeService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'owner-upgrade' }),
        fleet: () => fleetToolsService,
        policies: () => runtimePolicies,
        releases: () => runtimeReleases,
        getJson: () => (feedService.enabled ? (url) => feedService.getJson(url) : null),
        catalog: () => versionCatalog?.latest()?.catalog ?? null,
      });
      // p17-update-channel: stored policy rules get their pin mode (follow / hold) once.
      instance.addHook('onReady', async () => {
        const catalog = (await versionCatalog?.current().catch(() => null))?.catalog ?? null;
        const versions: Partial<Record<RuntimeKind, string[]>> = {};
        for (const [rt, list] of Object.entries(catalog?.runtimes ?? {})) {
          versions[rt as RuntimeKind] = list.map((e) => e.version);
        }
        await runtimePolicies?.migratePinModes(versions).catch((err: unknown) => {
          instance.log.error({ err }, 'runtime policy pin mode migration failed');
        });
      });
      const serviceEffects = new ServiceEffects({
        usage,
        approvals,
        context,
        replay: () => requireSessions().replay,
        log: instance.log.child({ component: 'effects' }),
        db: deps.pool,
        machineMemory: (jobId, attemptId, workerId, text) =>
          machineAdminService.recordNote(jobId, attemptId, workerId, text),
        // p11-memory-layers: agents' memory events and LESSON: / MEMORY: lines become suggestions, never context.
        suggestions: memorySuggestions,
      });
      // p4-quotas: run limits checked after every recorded usage event; admission before every dispatch.
      const quotaService = new QuotaService({
        pool: deps.pool,
        store: quotaStore,
        usage,
        jobs,
        audit,
        clock,
        // p16-ops-safety: the model cost brake (block mode) holds new non-urgent jobs over a ceiling.
        costBrake: () => costBrake,
        log: instance.log.child({ component: 'quotas' }),
        cancel: () => {
          if (orchestrator === null) throw new Error('orchestrator not initialised');
          return orchestrator;
        },
      });
      quotas = quotaService;
      const effects = new QuotaEffects(
        serviceEffects,
        quotaService,
        instance.log.child({ component: 'quotas' }),
      );
      // p4-dag: workflow jobs get their upstream outputs as fenced data after the context bundle; p6-automations:
      // then the event that triggered the automation run (fenced untrusted data, never the prompt).
      // p17-embeddings: then, once per job, similar past jobs of the project (fenced untrusted data; may be absent).
      const contextProvider = new RelatedContextProvider(
        new AutomationContextProvider(
          new WorkflowContextProvider(new StoreContextProvider(context), deps.pool),
          deps.pool,
        ),
        (jobId) => relatedWork.contextFor(jobId),
      );
      // p6-smart-routing: workflow steps without a runtime take their kind's routing rule (shared project defaults).
      const routingDefaults = new ProjectDefaults({
        db: deps.pool,
        preview: () => {
          if (runtimePolicies === null || orchestrator === null) throw new Error('services not initialised');
          const rp = runtimePolicies;
          const orch = orchestrator;
          return {
            db: deps.pool,
            candidates: (project) => orch.candidates(project),
            quotas: (project, runtime) => quotaService.preview(project, runtime),
            policyOf: async (workerId) => (await rp.forWorker(workerId)).effective?.document ?? null,
            outcomes: (key) => outcomesFor(deps.pool, key),
          };
        },
      });
      // p18-multi-project W5: one job per selected project — the composer's defaults and admission preview per project.
      jobBatches = new JobBatchService({
        pool: deps.pool,
        audit,
        clock,
        createJob: async (input) => {
          const { job } = await jobs.create({ ...input, submit: true });
          return { id: job.id };
        },
        dispatch: (jobId) => (orchestrator === null ? Promise.resolve() : orchestrator.dispatch(jobId)),
        applyDefaults: (project, spec) => routingDefaults.apply(project, spec),
        holds: async (project, runtime) =>
          (await quotaService.preview(project, runtime)).holds.map((h) => ({
            code: h.code,
            message: h.message,
          })),
      });
      // p14-workflow-engine 14.3 (K1): the project HTTP egress policy of HTTP / e-mail nodes.
      const egressService = new WorkflowEgressService({ pool: deps.pool, audit, clock });
      workflowEgress = egressService;
      const workflowService = new WorkflowService({
        routeRuntime: (project, role) => routingDefaults.runtimeFor(project, role),
        egress: egressService,
        pool: deps.pool,
        jobs,
        audit,
        clock,
        log: instance.log.child({ component: 'workflows' }),
        cancel: () => {
          if (orchestrator === null) throw new Error('orchestrator not initialised');
          return orchestrator;
        },
        // Integrators merge through p4-git-flow (protected merge behind a human approval).
        // p11-merge-pipeline (ADR-0041): with master-managed integration the platform integrates the upstream branches.
        merge:
          o.merge ??
          new IntegrationMergeGateway({
            inner: new GitFlowMergeGateway({ gitflow: () => gitflow, jobs, db: deps.pool }),
            integration: () => integration,
          }),
        // p6-deploy-pipeline (ADR-0028): a node's deploy step requests an ops action as `workflow:<run>`, if the
        // user who started the run may still request deploys in the project.
        deploy: () => {
          const o2 = ops;
          if (o2 === null) return null;
          return {
            request: async (input) => {
              const user = await deps.pool.query<{ id: string; role: Role; disabled_at: Date | null }>(
                'SELECT id, role, disabled_at FROM users WHERE id::text = $1',
                [input.createdBy],
              );
              const u = user.rows[0];
              if (u === undefined || u.disabled_at !== null)
                return { refused: 'the run’s creator is not active' };
              const subject = await loadSubject(deps.pool, { id: u.id, role: u.role });
              if (!authorize(subject, 'deploy.request', { project: input.project }).allow) {
                return { refused: 'the run’s creator may not request deploys in this project' };
              }
              const params: Record<string, unknown> =
                input.step.kind === 'pages.deploy'
                  ? {
                      jobId: input.jobId,
                      ...(input.step.branch === undefined ? {} : { branch: input.step.branch }),
                    }
                  : input.step.kind === 'coolify.restart'
                    ? { env: input.step.env }
                    : {
                        env: input.step.env,
                        ...(input.step.force === undefined ? {} : { force: input.step.force }),
                      };
              const out = await o2.request(
                { type: 'system', id: `workflow:${input.runId}` },
                {
                  project: input.project,
                  kind: input.step.kind as 'coolify.deploy',
                  params,
                  idempotencyKey: `wf-${input.runId}-${input.nodeId}`.slice(0, 128),
                  note: `Workflow run ${input.runId}, step ${input.nodeId}`.slice(0, 500),
                },
                'workflow',
                { source: { workflowRunId: input.runId, nodeId: input.nodeId, createdBy: input.createdBy } },
              );
              return { actionId: out.action.id, state: out.action.state };
            },
          };
        },
        // p5-research-workspace-next: workflow runs on workspace projects (run files, upstream artifacts).
        workspaces: workspaceService,
        // p6-result-reuse: steps with the opt-in policy reuse an identical earlier job.
        reuse: resultReuse,
        // p14-workflow-engine: engine 2 behind WORKFLOW_ENGINE_V2 / WORKFLOW_ENGINE_V2_FOR_V1.
        // p17-panel-settings: the panel's engine-2 flags, read at use time (default: the environment).
        engine: {
          get v2() {
            return panelSettings.get<boolean>('workflow.engineV2', o.workflowEngine?.v2 === true);
          },
          get v2ForV1() {
            return panelSettings.get<boolean>('workflow.engineV2ForV1', o.workflowEngine?.v2ForV1 === true);
          },
        },
        // p14-workflow-engine 14.2: integration nodes through the existing integrations only (tests may replace them).
        integrations: () =>
          o.workflowIntegrations ??
          createWorkflowIntegrations({
            db: deps.pool,
            log: instance.log.child({ component: 'workflow-integrations' }),
            notifications: () => notifications,
            chat: () => chat,
            ops: () => ops,
            gitflow: () => gitflow,
            probe: uptimeProbe ?? createProbe(),
          }),
        // p14-workflow-engine 14.2: webhook waits (`/v1/hooks/wait/:token`).
        hooks: {
          key: deps.box.deriveKey('workflow-wait'),
          origin: consoleDomain.overlay(
            gf.consoleOrigin === undefined ? (deps.installers?.publicOrigin ?? null) : gf.consoleOrigin,
          ),
          webhookSecrets: (project, name) =>
            automations === null ? Promise.resolve([]) : automations.workflowWebhookSecrets(project, name),
        },
        // p14-workflow-engine 14.4: failure-streak alerts (`workflow.failed`).
        notifications: () => notifications,
        // p18-multi-project: a saved owner version moves the attachments that follow it.
        sharing: () => sharedWorkflows,
      });
      workflows = workflowService;
      sharedWorkflows = new SharedWorkflowService({
        pool: deps.pool,
        audit,
        clock,
        notifications: () => notifications,
        egress: egressService,
        // Detaching pauses the attachment's bound automations in its project (history kept).
        pauseTriggers: (actor, project, name) =>
          new WorkflowTriggerService({
            pool: deps.pool,
            audit,
            clock,
            automations: () => automations,
          }).pauseProject(actor, project, name),
      });
      // p14-workflow-engine 14.1: stop the expression sandbox threads with the master.
      instance.addHook('onClose', () => workflowService.close());
      // p14-ask-user: questions of job agents (fenced to the live lease) and of the assistant.
      const questionService = new QuestionService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'questions' }),
        notify: () => notifications,
        limiter,
        chat: () => chatFlow,
      });
      questions = questionService;
      // p8-orchestration (ADR-0031): sub-jobs requested by running jobs' agents (fenced to the parent's live lease).
      const subtaskService = new SubtaskService({
        pool: deps.pool,
        jobs,
        audit,
        clock,
        log: instance.log.child({ component: 'subtasks' }),
        dispatch: (jobId) => (orchestrator === null ? Promise.resolve() : orchestrator.dispatch(jobId)),
        cancel: () => {
          if (orchestrator === null) throw new Error('orchestrator not initialised');
          return orchestrator;
        },
        routeRuntime: (project, role) => routingDefaults.runtimeFor(project, role),
        runtimeAdvice,
        // p9-subjob-local-login-deadlock: a sub-job that waits only for its own parent is reported at once.
        blockedBy: (jobId, blockerId) =>
          orchestrator === null ? Promise.resolve(null) : orchestrator.blockedBy(jobId, blockerId),
      });
      subtasks = subtaskService;
      // p6-automations: triggers (cron, one-time, GitHub, webhook, chain) → runs, driven by an orchestrator tick step.
      const automationService = new AutomationService({
        pool: deps.pool,
        outputFolders: () => outputFolders,
        audit,
        jobs,
        clock,
        log: instance.log.child({ component: 'automations' }),
        box: deps.box,
        dispatch: (jobId) => {
          if (orchestrator === null) return Promise.resolve();
          return orchestrator.dispatch(jobId);
        },
        startWorkflow: () => (actor, id, input) => workflowService.startRun(actor, id, input),
        publicOrigin: consoleDomain.overlay(
          gf.consoleOrigin === undefined ? (deps.installers?.publicOrigin ?? null) : gf.consoleOrigin,
        ),
        githubWebhookSecret: async () => (githubConnect === null ? null : githubConnect.webhookSecret()),
        githubWebhookSecrets: async (appId) =>
          githubConnect === null ? [] : githubConnect.webhookSecrets(appId),
        // p22-github-webhook: deliveries mark the waiting results they concern for a re-check.
        githubGitEvents: (repo, event, payload) =>
          gitflow === null ? Promise.resolve(0) : gitflow.onGitHubEvent(repo, event, payload),
        // p5-research-workspace-next: input files and continue-from on workspace projects.
        workspaces: workspaceService,
        // p6-result-reuse: "skip if an identical successful run exists within N hours" (opt-in).
        reuse: resultReuse,
        // p6-deploy-on-success: job targets that deploy each run's job when it succeeds.
        deployOnSuccess: () => deployOnSuccess,
        // p10-verify-health: job targets with "Verify when done" (or the project's default).
        verification: () => verification,
        // p8-cost-efficiency: exhausted budgets that pause new jobs or block automations skip the run.
        budgetGate: () => (project, runtime) => quotaService.automationBlocked(project, runtime),
        // p6-automation-defaults: the composer's project defaults and placement preview; approval-timeout cancels.
        preview: () => {
          if (runtimePolicies === null || orchestrator === null) throw new Error('services not initialised');
          const rp = runtimePolicies;
          const orch = orchestrator;
          const q = quotaService;
          return {
            db: deps.pool,
            candidates: (project) => orch.candidates(project),
            quotas: (project, runtime) => q.preview(project, runtime),
            policyOf: async (workerId) => (await rp.forWorker(workerId)).effective?.document ?? null,
            outcomes: (key) => outcomesFor(deps.pool, key),
          };
        },
        cancel: () => {
          if (orchestrator === null) throw new Error('orchestrator not initialised');
          return orchestrator;
        },
        // p6-automations-next: an approval timeout inside a workflow run cancels the whole run.
        cancelWorkflow: () => async (runId, reason) => {
          await workflowService.cancelRun(runId, { type: 'system', id: 'automations' }, reason);
        },
        // p6-deploy-pipeline (ADR-0028): deploy targets request ops actions as `automation:<id>`.
        deploy: () => {
          const o = ops;
          if (o === null) return null;
          return {
            check: (project, action) => o.check(project, action.kind as OpsKind, action.params),
            request: async (input) => {
              const out = await o.request(
                { type: 'system', id: `automation:${input.automationId}` },
                {
                  project: input.project,
                  kind: input.action.kind as 'coolify.deploy',
                  params: input.action.params,
                  idempotencyKey: `automation-run-${input.runId}`,
                  note: `Automation run ${input.runId}`,
                },
                'automation',
                { source: { automationId: input.automationId, runId: input.runId, runAs: input.runAs } },
              );
              return { actionId: out.action.id, state: out.action.state };
            },
          };
        },
      });
      automations = automationService;
      automationGroups = new AutomationGroupService({
        pool: deps.pool,
        audit,
        clock,
        automations: () => automationService,
      });
      // p5-composer schedules: an alias over cron / one-time automations.
      const scheduleService = new ScheduleService({ automations: () => automationService });
      schedules = scheduleService;
      quotaService.onKill((project, actor, reason) =>
        workflowService.cancelProjectRuns(project, actor, reason),
      );
      const flow = new GitFlowService({
        pool: deps.pool,
        jobs,
        approvals,
        audit,
        providers,
        clock,
        log: instance.log.child({ component: 'gitflow' }),
        leaseTtlMs,
        ...(gf.timing ? { timing: gf.timing } : {}),
        // p11-merge-pipeline: members of a master-managed integration get no pull request of their own.
        ownPullRequest: () => {
          const svc = integration;
          return svc === null ? null : (job) => svc.ownPullRequest(job);
        },
        autoRetry: () => autoRetry,
        // p15-job-titles: the job link in pull request bodies.
        consoleOrigin: consoleDomain.overlay(
          gf.consoleOrigin === undefined ? (deps.installers?.publicOrigin ?? null) : gf.consoleOrigin,
        ),
      });
      gitflow = flow;
      // p15-auto-mode: base ref healing before dispatch, retries of lost attempts, the console's reads.
      // p22-git-preflight: one anonymous view of repositories (cached) for the access preflight and base ref healing.
      // Off unless configured (main.ts turns it on; tests opt in with a fake probe).
      const remoteProbe = o.repoAccess?.probe ?? null;
      remoteProbe?.useInternalOrigins(egressInternalOrigins);
      const selfHealService = new SelfHealService({
        pool: deps.pool,
        healer: new BaseRefHealer({
          pool: deps.pool,
          audit,
          clock,
          providerFor: (project) => flow.providerFor(project),
          ...(remoteProbe === null ? {} : { probe: remoteProbe }),
        }),
        ...(remoteProbe === null
          ? {}
          : {
              repoAccess: new RepoAccessPreflight({
                pool: deps.pool,
                probe: remoteProbe,
                providerFor: (project) => flow.providerFor(project),
                clock: () => clock().getTime(),
              }),
            }),
        retry: autoRetry,
        log: () => instance.log,
        clock,
      });
      selfHeal = selfHealService;
      const autoFix = new AutoFixService({
        pool: deps.pool,
        audit,
        jobs,
        securityPolicy,
        clock,
        // p17-embeddings: one fix job per failure — the same failure of another job joins the open one.
        sameFailureFix: (jobId) => relatedWork.sameFailureFix(jobId),
      });
      conflictResolve = new ConflictResolveService({
        pool: deps.pool,
        audit,
        jobs,
        securityPolicy,
        clock,
        supersede: () => {
          const g = gitflow;
          return g === null ? null : (jobId, byJobId) => g.supersede(jobId, byJobId);
        },
        dispatch: (jobId) => {
          void orchestrator?.dispatch(jobId).catch(() => undefined);
        },
      });
      const conflictResolveService = conflictResolve;
      const integrationService = new IntegrationService({
        pool: deps.pool,
        jobs,
        audit,
        clock,
        log: instance.log.child({ component: 'integration' }),
        gitflow: () => flow,
        dispatch: (jobId) => (orchestrator === null ? Promise.resolve() : orchestrator.dispatch(jobId)),
        cancel: () => {
          if (orchestrator === null) throw new Error('orchestrator not initialised');
          return orchestrator;
        },
        verifySettings,
      });
      integration = integrationService;
      githubConnect = new GitHubConnectService({
        pool: deps.pool,
        audit,
        clock,
        box: deps.box,
        apps: githubApps,
        log: instance.log.child({ component: 'github-connect' }),
        apiBaseUrl: gf.githubApiUrl ?? 'https://api.github.com',
        webBaseUrl: gf.githubWebUrl ?? 'https://github.com',
        consoleOrigin: consoleDomain.overlay(
          gf.consoleOrigin === undefined ? (deps.installers?.publicOrigin ?? null) : gf.consoleOrigin,
        ),
        ...(gf.githubFetch === undefined ? {} : { fetch: gf.githubFetch }),
      });
      githubRepos = new GitHubRepoService({
        pool: deps.pool,
        audit,
        clock,
        box: deps.box,
        connect: githubConnect,
        configs: gitConfigs,
        apiBaseUrl: gf.githubApiUrl ?? 'https://api.github.com',
        webBaseUrl: gf.githubWebUrl ?? 'https://github.com',
        ...(gf.githubFetch === undefined ? {} : { fetch: gf.githubFetch }),
      });
      siteUploads = new SiteUploadService({
        pool: deps.pool,
        audit,
        clock,
      });
      ops = new OpsService({
        pool: deps.pool,
        audit,
        clock,
        integrations: opsIntegrations,
        siteUploads: () => siteUploads,
        log: instance.log.child({ component: 'ops' }),
        consoleHost: opsConsoleHost,
        protectedHosts: opsExtraProtectedHosts,
        liveConsoleHosts: () => consoleDomain.consoleHosts(),
        controlPlaneResources: opsControlPlaneResources,
        controlPlaneAddresses: opsControlPlaneAddresses,
        ...(opsCfg.limits === undefined ? {} : { limits: opsCfg.limits }),
        handlers: () => (previews === null ? [] : [previews]),
        // p15-auto-mode: deploys that need an approval run at once when "Otomatik mod" is on.
        autoMode: async () => (await securityPolicy.current()).autonomy.autoMode,
        // p15-chat-zip: a publish requested in a conversation posts its live link (or failure) there.
        chatNote: async (threadId, text, meta) => {
          if (chat !== null) await chat.noteDeploy(threadId, text, meta);
        },
      });
      coolifyResources = new CoolifyResourceService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'coolify-resources' }),
        connections: opsIntegrations.coolifyConnections,
        protectedHosts: ops.protectedHosts,
        liveProtectedHosts: () => consoleDomain.consoleHosts(),
      });
      coolifyApps = new CoolifyAppService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'coolify-apps' }),
        connections: opsIntegrations.coolifyConnections,
        ops: () => ops,
        protectedHosts: ops.protectedHosts,
        liveProtectedHosts: () => consoleDomain.consoleHosts(),
        layout: coolifyLayout,
        resources: coolifyResources,
      });
      const previewHub = hub;
      previews = new PreviewService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'previews' }),
        ops: () => ops,
        integrations: opsIntegrations,
        box: deps.box,
        signer,
        session: (workerId) => previewHub.get(workerId)?.session ?? undefined,
        consoleHost: opsConsoleHost,
        protectedHosts: opsExtraProtectedHosts,
        liveConsoleHosts: () => consoleDomain.consoleHosts(),
        controlPlaneAddresses: opsControlPlaneAddresses,
        chatNote: async (threadId, text, meta) => {
          if (chat !== null) await chat.noteDeploy(threadId, text, meta);
        },
        // p10-publish-bundle (ADR-0038): a job agent's publish_site request.
        deployOnSuccess: () => deployOnSuccess,
        // p12-deploy-feedback (ADR-0048): the in-job deploy tools.
        deployFeedback: () => deployFeedback,
      });
      // p15-services: Servisler (desired state, signed SERVICE_* delivery, reconciliation, named tunnels).
      services = new ServiceRegistry({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'services' }),
        signer,
        session: (workerId) => previewHub.get(workerId)?.session ?? undefined,
        previews: () => previews,
        credentials:
          o.credentials ??
          new GitHubWorkerCredentials({
            db: deps.pool,
            apps: githubApps,
            log: instance.log.child({ component: 'service-credentials' }),
          }),
      });
      // p19-ide W2 (docs/design/p19-ide.md, ADR-0066): Tam IDE — desired state, signed IDE_* delivery, reconciliation,
      // the STREAM_* tunnels to the workers and the IDE origin's ticket / cookie access.
      {
        const ideLog = instance.log.child({ component: 'ide' });
        const ideAccess = new IdeAccess({ pool: deps.pool, clock });
        const tunnels = new TunnelRegistry(instance.log.child({ component: 'ide-tunnel' }), {
          features: (workerId) => (ide?.supports(workerId) === true ? ['ide-v1'] : []),
        });
        ideTunnels = tunnels;
        ideExtensions = new IdeExtensions({
          pool: deps.pool,
          audit,
          clock,
          log: instance.log.child({ component: 'ide-extensions' }),
          blobs: () => blobService,
          openVsx: deps.ide?.openVsx ?? new OpenVsxClient({ internalOrigins: egressInternalOrigins }),
        });
        ide = new IdeService({
          pool: deps.pool,
          audit,
          clock,
          log: ideLog,
          signer,
          session: (workerId) => previewHub.get(workerId)?.session ?? undefined,
          access: ideAccess,
          origin: ideOrigin,
          credentials:
            o.credentials ??
            firstCredential(
              new GitHubWorkerCredentials({ db: deps.pool, apps: githubApps, log: ideLog }),
              new HostedWorkerCredentials({ db: deps.pool, hosts: () => gitHosts, log: ideLog }),
            ),
          providers,
          extensions: ideExtensions,
          connections: (workspaceId) => ideProxy?.connections(workspaceId) ?? 0,
          resetStreams: (workerId, workspaceId) => {
            tunnels.resetWorkspace(workerId, workspaceId);
            ideProxy?.reset(workspaceId);
          },
        });
        const ideRef = ide;
        ideProxy = ideProxyRoutes({
          service: ideRef,
          access: ideAccess,
          tunnels,
          origin: ideOrigin,
          clock,
          log: ideLog,
          consoleOrigin: () => consoleDomain.overlay(deps.installers?.publicOrigin).current(),
        });
      }
      // p15-workspace-retention: "Çalışma dosyaları" — the master's records of kept working directories.
      workfiles = new WorkfilesService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'workfiles' }),
        session: (workerId) => previewHub.get(workerId)?.session ?? undefined,
      });
      workfilesExport = new WorkfilesExport({
        pool: deps.pool,
        audit,
        clock,
        workfiles,
        gitConfig: (project) => gitConfigs.get(project),
        providers,
        repos: () => githubRepos,
        siteUploads: () => siteUploads,
      });
      // p6-deploy-on-success (ADR-0030): jobs that deploy their result when they succeed (pre-approved at creation).
      deployOnSuccess = new DeployOnSuccessService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'deploy-on-success' }),
        ops: () => ops,
        chatNote: async (threadId, text, meta) => {
          if (chat !== null) await chat.noteDeploy(threadId, text, meta);
        },
      });
      // p10-verify-health: every request goes through the uptime SSRF guard (its test exceptions only).
      const verifyProbe =
        deps.verify?.probe ?? createProbe({ allowOrigins: deps.uptime?.allowOrigins ?? [] });
      const dispatchJob = (jobId: string): Promise<unknown> =>
        orchestrator === null ? Promise.resolve() : orchestrator.dispatch(jobId);
      verification = new VerificationService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'verification' }),
        jobs,
        dispatch: dispatchJob,
        settings: verifySettings,
        fetcher: verifyProbe,
        chatNote: async (threadId, text, meta) => {
          if (chat !== null) await chat.noteDeploy(threadId, text, meta);
        },
      });
      deployHealth = new DeployHealthService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'deploy-health' }),
        probe: verifyProbe,
        ops: () => ops,
        jobs,
        dispatch: dispatchJob,
        settings: verifySettings,
        chatNote: async (threadId, text, meta) => {
          if (chat !== null) await chat.noteDeploy(threadId, text, meta);
        },
        ...(deps.verify?.timing === undefined ? {} : { timing: deps.verify.timing }),
      });
      // p12-deploy-feedback (ADR-0048): logs, failure summaries, fix plans, in-job deploy tools, auto-fix.
      deployFeedback = new DeployFeedbackService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'deploy-feedback' }),
        ops: () => ops,
        health: () => deployHealth,
        onSuccess: () => deployOnSuccess,
        jobs,
        dispatch: dispatchJob,
        chatNote: async (threadId, text, meta) => {
          if (chat !== null) await chat.noteDeploy(threadId, text, meta);
        },
      });
      const deployFeedbackService = deployFeedback;
      const verificationService = verification;
      const deployHealthService = deployHealth;
      const liveLog = instance.log.child({ component: 'live' });
      const liveStore = new LiveStore({
        pool: deps.pool,
        clock,
        log: liveLog,
        ...(lc.limits ? { limits: lc.limits } : {}),
      });
      const liveBus = new LiveBus({ pool: deps.pool, log: liveLog });
      live = {
        store: liveStore,
        bus: liveBus,
        streams: new LiveStreams({
          store: liveStore,
          bus: liveBus,
          log: liveLog,
          ...(lc.stream ? { limits: lc.stream } : {}),
        }),
      };
      const inbox = new OrchestrationInbox({
        pool: deps.pool,
        jobs,
        replay: () => requireSessions().replay,
        signer,
        audit,
        clock,
        leaseTtlMs,
        log: instance.log.child({ component: 'inbox' }),
        effects: () => effects,
        gitflow: () => flow,
        live: () => liveStore,
        workspaces: () => workspaceService,
        // p13-runtime-accounts: a manual account switch's pause confirms through the switch service.
        pause: () => ({
          confirmWithin: (tx, input) =>
            input.report.cause === 'account_switch'
              ? accountSwitch.confirmWithin(tx, input)
              : approvalPause.confirmWithin(tx, input),
          resumeDeclinedWithin: (tx, input) => approvalPause.resumeDeclinedWithin(tx, input),
        }),
        usageLimits: () => usageLimits,
        // p14-mcp-core: `mcp_call` events → job_mcp_calls + audit (inside the inbox transaction).
        mcpCalls: () => mcp,
        // p15-auto-mode: transient failures go back to the queue after a backoff.
        autoRetry: () => autoRetry,
      });
      // p5-ops-chat: the assistant runs on a worker; tools are served here for the turn's user.
      const streams = new ChatStreams({
        log: instance.log.child({ component: 'chat-streams' }),
        ...(deps.chat?.streams === undefined ? {} : { limits: deps.chat.streams }),
      });
      chatStreams = streams;
      const rc = deps.chat?.replicas;
      const bus =
        rc?.enabled === false
          ? undefined
          : new ChatBus({
              pool: deps.pool,
              log: instance.log.child({ component: 'chat-bus' }),
              localWorkers: () => workerHub.connectedWorkers,
              ...(rc?.presenceMs === undefined ? {} : { presenceMs: rc.presenceMs }),
            });
      if (bus !== undefined) {
        streams.setFanout((th, ev, d) => {
          bus.publish({ t: 'event', th, ev, d });
        });
        void bus.start();
        instance.addHook('onClose', async () => {
          await bus.stop();
        });
      }
      const jobMessageService = new JobMessageService({
        db: deps.pool,
        audit,
        limiter,
        replay: () => requireSessions().replay,
        clock,
        ...(deps.chat?.jobMessageLimits === undefined ? {} : { limits: deps.chat.jobMessageLimits }),
      });
      jobMessages = jobMessageService;
      workflowAi = new WorkflowAiService({
        pool: deps.pool,
        store: chatStore,
        chat: () => chat,
        workflows: () => workflows,
        audit,
        log: instance.log.child({ component: 'workflow-ai' }),
      });
      const workflowAiHooks = workflowAi;
      const chatService = new ChatService({
        // p16-ops-safety: the owner's chat message rate and the model cost brake, before every new turn.
        turnGuard: () => turnGuard,
        // p16-observability: chat.turn spans (trace context on ASSISTANT_TURN) and turn counters.
        ...(deps.telemetry ? { observe: chatTurnTelemetry(deps.telemetry) } : {}),
        // p15-workflow-ai: the editor's instruction / blocks and one automatic repair turn.
        workflowAi: () => workflowAiHooks,
        // p18-plan-mode: plan mode, the plan block, decisions, draft ↔ item links, continuation turns.
        plans: () => chatPlans,
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'chat' }),
        signer,
        limiter,
        settings: chatSettings,
        // p15-chat-failover: backup machines (pin, automatic failover, switches).
        failover: chatFailover,
        ...(deps.chat?.failoverStableMs === undefined
          ? {}
          : { failoverStableMs: deps.chat.failoverStableMs }),
        ...(deps.chat?.reconnectGraceMs === undefined
          ? {}
          : { reconnectGraceMs: deps.chat.reconnectGraceMs }),
        store: chatStore,
        streams,
        session: (workerId) => workerHub.get(workerId)?.session ?? undefined,
        // p15-message-delivery item 2: the "Otomatik" fallback account.
        accounts: () => runtimeAccounts,
        ...(bus === undefined ? {} : { bus }),
        ...(rc?.dispatchAckMs === undefined ? {} : { dispatchAckMs: rc.dispatchAckMs }),
        ...(deps.chat?.turnTimeoutMs === undefined ? {} : { turnTimeoutMs: deps.chat.turnTimeoutMs }),
        ...(deps.chat?.slowToolMs === undefined ? {} : { slowToolMs: deps.chat.slowToolMs }),
        ...(deps.chat?.restartRecovery === undefined ? {} : { restartRecovery: deps.chat.restartRecovery }),
        attachments: chatAttachments,
        mentions: chatMentions,
        // p15-chat-zip: site uploads a message carries (a .zip unpacked and uploaded by the console).
        siteUploads: chatSiteUploads,
        // p16-zip-job-input: job input bundles a message carries.
        inputUploads: chatInputUploads,
        // p10-semantic-defaults-chat: related knowledge on every user turn.
        knowledge: chatKnowledge,
        // p18-multi-project W3: the working projects block and the write rules.
        threadProjects: () => threadProjects,
        // p11-memory-layers: the sender's personal rules with every turn.
        personalRules: (userId) => memoryRecords.personalRules(userId),
        // p14-ask-user: ask_user cards; a normal message closes an open card, an answer starts the next turn.
        questions: () => questions,
        // p15-autonomy: draft tools with execute: true run at once for the user (DraftExecutor.confirm).
        direct: () => chatDirect,
        // oss-sec3: a draft held for untrusted content runs when the person remembered that action and target.
        untrustedAllows: () => untrustedAllows,
        credentials: () => chatCredentials,
        tools: (chatToolsRef = new ChatTools({
          // p18-plan-mode: the plan tools.
          plans: () => chatPlans,
          // p20-outcome: list_goals / goal_update (rule 66).
          goals: () => chatGoals,
          // p18-assistant-gaps: workflow runs, job outputs, backups / updates, templates, uptime, memory review, …
          opsTools: () => chatOpsTools,
          // p18-project-bootstrap: describe_project_readiness, draft_project_network / _machines.
          projectSetup: () => chatProjectSetup,
          // p19-ide W4: the code tools (own block in ChatTools).
          codeTools: () => chatCodeTools,
          // p18-multi-project W3 + W5: working projects, shared workflows, job batches.
          threadProjects: () => threadProjects,
          sharing: () => sharedWorkflows,
          batches: () => jobBatches,
          settings: () => chatSettingsTools,
          admin: () => chatAdmin,
          // p16-api-tokens: list_api_tokens (metadata only).
          apiTokens: () => apiTokens,
          // p16-ops-safety: ops_safety_status (expiry, rollout breaker, cost brake).
          opsSafety: () => opsSafetyReader,
          // p16-webhooks-out: list_webhooks / draft_webhook.
          webhooks: () => webhooksOut,
          // p16-doctor: run_diagnostics / draft_support_report.
          doctor: () => ({ service: doctor, support }),
          // p16-runtime-updates: draft_runtime_update plans through the fleet pipeline.
          fleetTools: () => fleetTools,
          // p15-chat-failover: "sohbet hangi makinede?" (list_workers / get_settings → chatAssistant).
          chatRouting: () => chat?.routingSummary() ?? null,
          coolify: () => chatCoolify,
          siteCoolify: () => chatSiteCoolify,
          githubRepo: () => chatGitHubRepo,
          projectCreate: () => chatProjectCreate,
          // p15-workspace-retention: list_workfiles / export_workfiles.
          workfiles: () => chatWorkfiles,
          // p20-chat-images: show_image.
          images: () => chatImageTools,
          // p16-chat-complete: read_job_diff (the verified branch's files and patch).
          gitDiff: () => gitflow,
          // p15-chat-zip: list_site_uploads / publish_site_upload (with the deploy integrations only).
          siteUploads: () => (siteUploads === null ? null : chatSiteUploads),
          // p16-zip-job-input: list_input_bundle_files / draft_job inputUpload.
          inputUploads: () => chatInputUploads,
          credentials: () => chatCredentials,
          securityPolicy,
          questions: () => questions,
          db: deps.pool,
          runtimeUsage: () => runtimeUsage,
          // p15-usage-refresh: runtime_limits {refresh: true}.
          usageRefresh: () => usageRefresh,
          // p13-runtime-accounts: runtime_accounts, draft_account_action.
          accounts: () => runtimeAccounts,
          store: chatStore,
          jobs: jobQuery,
          live: () => liveStore,
          approvals,
          usage,
          context,
          // p10-semantic-memory: search_context / suggest_memory.
          search,
          memorySuggestions,
          // p11-memory-layers: draft_memory_change.
          memoryRecords,
          // p10-semantic-defaults-chat: search_context scope "chat".
          chatKnowledge,
          clock,
          workerConfigs: () => {
            if (workerConfigs === null) throw new Error('worker config service not initialised');
            return workerConfigs;
          },
          machineAdmin: () => machineAdminService,
          remoteOps: () => remoteOpsService,
          skills: () => skills,
          // p14-skill-catalogs: search_skills, propose_skill_install.
          skillCatalog: () => skillCatalog,
          skillImports: () => skillImports,
          // p14-mcp-chat: search_mcp_servers, propose_mcp_install.
          mcpDiscovery: () => mcpDiscovery,
          mcpPreviews: () => mcpPreviews,
          // p19-install-scripts: draft_install_script_approval evaluates the packages.
          installScripts: () => installScriptApprovals,
          automations: () => automationService,
          ops: () => ops,
          deployOnSuccess: () => deployOnSuccess,
          // p12-deploy-feedback: deploy_logs, draft_deploy_fix, failure summaries in deploy_status.
          deployFeedback: () => deployFeedback,
          verification: () => verification,
          runtimeAdvice,
          reuse: resultReuse,
          watches: () => chatWatches,
          uptime: () => uptime,
          // p15-services: list / start / stop / restart services, logs (acted on at once for the signed-in user).
          services: () => services,
          templates: () => templates,
          // p13-workflows-ui: draft_workflow validates the drafted definition.
          workflows: () => workflows,
          preview: () => {
            if (quotas === null || runtimePolicies === null || orchestrator === null)
              throw new Error('services not initialised');
            const q = quotas;
            const rp = runtimePolicies;
            const orch = orchestrator;
            return {
              db: deps.pool,
              candidates: (project) => orch.candidates(project),
              quotas: (project, runtime) => q.preview(project, runtime),
              policyOf: async (workerId) => (await rp.forWorker(workerId)).effective?.document ?? null,
              outcomes: (key) => outcomesFor(deps.pool, key),
            };
          },
        })),
      });
      chat = chatService;
      const planStreams = streams;
      chatPlans = new ChatPlanService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'chat-plans' }),
        store: chatStore,
        publish: (threadId, event, data) => {
          planStreams.publish(threadId, event, data);
        },
        questions: () => questions,
        chat: () => chat,
        notifications: () => notifications,
        // p18-project-bootstrap: a not-ready project's job / workflow item gets a readiness decision first.
        readiness: () => async (project) =>
          (await chatProjectSetup.evaluate(project, { provider: false }))?.missing ?? null,
      });
      drafts = new DraftExecutor({
        pool: deps.pool,
        // p16-runtime-updates: runtime update cards create a fleet action.
        fleetTools: () => fleetTools,
        // p16-webhooks-out: webhook cards (create / pause / resume).
        webhooks: () => webhooksOut,
        // p16-doctor: support report cards (build + send).
        support: () => support,
        store: chatStore,
        audit,
        jobs,
        approvals,
        jobMessages: jobMessageService,
        orchestrator: () => {
          if (orchestrator === null) throw new Error('orchestrator not initialised');
          return orchestrator;
        },
        workflows: () => workflowService,
        workerConfigs: () => {
          if (workerConfigs === null) throw new Error('worker config service not initialised');
          return workerConfigs;
        },
        machineAdmin: () => machineAdminService,
        remoteOps: () => remoteOpsService,
        skills: () => skills,
        // p14-skill-catalogs: skill_import cards publish through the import pipeline.
        skillImports: () => skillImports,
        // p14-mcp-chat: mcp_install cards confirm an install preview.
        mcpPreviews: () => mcpPreviews,
        // p19-install-scripts: install_script_approval cards.
        installScripts: () => installScriptCards,
        automations: () => automationService,
        // p18-multi-project W4: the chat's automation group card.
        automationGroups: () => automationGroups,
        // p16-workflow-quality: a confirmed workflow card activates / re-syncs its trigger nodes.
        workflowTriggers: () =>
          new WorkflowTriggerService({
            pool: deps.pool,
            audit,
            clock,
            automations: () => automationService,
          }),
        ops: () => ops,
        deployOnSuccess: () => deployOnSuccess,
        uptime: () => uptime,
        templates: () => templates,
        // p10-verify-health: the card's "Verify when done" (or the project's default).
        verification: () => verification,
        // p11-memory-layers: memory_change cards.
        memoryRecords: () => memoryRecords,
        approvalPause: () => approvalPause,
        // p10-chat-job-actions: class / move / run now of queued jobs from a chat card.
        queue: () => queue,
        // p13-runtime-accounts: account_action cards.
        accounts: () => runtimeAccounts,
        accountSwitch: () => accountSwitch,
        clock,
        // p15-autonomy: a card asks for a code only when its event is protected; settings_change cards.
        securityPolicy,
        settings: () => chatSettingsTools,
        admin: () => chatAdmin,
        coolify: () => chatCoolify,
        siteCoolify: () => chatSiteCoolify,
        githubRepo: () => chatGitHubRepo,
        projectCreate: () => chatProjectCreate,
        // p18-multi-project W3 + W5: working projects, attaching a shared workflow, job batches.
        threadProjects: () =>
          new ThreadProjectsRunner({
            threadProjects: () => threadProjects,
            published: async (userId, threadId) => {
              chatStreams?.publish(threadId, 'thread', await chatStore.thread(userId, threadId));
            },
          }),
        workflowAttach: () => new WorkflowAttachRunner({ sharing: () => sharedWorkflows, clock }),
        jobBatch: () => new JobBatchRunner({ batches: () => jobBatches }),
        // p15-workspace-retention: workfiles_export cards.
        workfilesExport: () => chatWorkfiles,
        // p16-zip-job-input: a job card's input bundle, re-checked at confirm.
        inputUploads: () => inputUploads,
        httpRequests: () => chatCredentials,
        timeLimits: () => timeLimits,
        // p20-job-clock: the job action "continue" of a job that stopped on its time limit.
        jobClock: () => jobClock,
        // p22-conflict-resolve: the job action "resolve_conflicts".
        conflictResolve: () => conflictResolve,
        // p15-services: service_action cards (start / stop / restart; execute: true runs them at once).
        services: () => services,
      });
      const executor = drafts;
      goalGrants = new GoalGrants({ pool: deps.pool, audit, clock });
      chatDirect = new ChatDirectActions({
        drafts: () => executor,
        securityPolicy,
        audit,
        goalGrants: () => goalGrants,
      });
      approvalModes = new ApprovalModeService({
        pool: deps.pool,
        audit,
        approvals,
        replay: () => requireSessions().replay,
        signer,
        limiter,
        clock,
        machineAdminAutoApprove: async (workerId) => {
          if (workerConfigs === null) return false;
          const m = await workerConfigs.machineAdmin(workerId);
          return m.enabled && m.autoApprove;
        },
      });
      jobClock = new JobClockService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'job-clock' }),
        securityPolicy,
        jobs: () => jobs,
        dispatch: (jobId) => {
          void orchestrator?.dispatch(jobId).catch(() => undefined);
        },
        notify: () => notifications,
        chat: () => chatFlow,
        // p22-timeout-continuity: the automatic extension (autonomy.autoExtendTime) and the check of a pushed partial.
        timeLimits: () => timeLimits,
        gitProvider: () => gitflow,
      });
      timeLimits = new TimeLimitService({
        pool: deps.pool,
        audit,
        replay: () => requireSessions().replay,
        signer: () => signer,
        securityPolicy,
        clock,
        jobClock: () => jobClock,
      });
      fleetSessions = new OrchestrationSessionHandler({
        approvalMode: approvalModes,
        timeLimit: timeLimits,
        jobClock,
        // p15-message-delivery: JOB_MESSAGE_STATUS receipts and outbox ACKs.
        jobMessages: jobMessageService,
        runtimeUsage,
        assistant: chatService,
        rotation,
        updates: releases,
        // p17-update-channel: CAPABILITIES.versionCatalog → APPLY_VERSION_CATALOG; VERSION_CATALOG_STATUS.
        versionCatalog,
        runtimePolicy: policies,
        workerConfig: workerConfigs,
        vault: vaultService,
        remoteOps: remoteOpsService,
        machineAdmin: machineAdminService,
        // p14-mcp-stdio: CAPABILITIES.mcpInstalls (what each machine has installed and intact).
        mcpInstalls: { onReport: (session, report) => mcp.stdio.onInstallsReport(session.workerId, report) },
        subtasks: () => subtaskService,
        // p14-ask-user: QUESTION_REQUEST of running jobs (fenced by the live lease).
        questions: () => questionService,
        previews,
        pool: deps.pool,
        hub,
        clock,
        audit,
        sink: inbox,
        log: instance.log.child({ component: 'fleet' }),
        inputs: () => workspaceService,
        // p16-zip-job-input: INPUT_BUNDLE_REQUEST of running jobs (fenced by the live lease).
        inputBundles: () => inputUploads,
        // p17-object-storage: BLOB_UPLOAD_REQUEST / COMPLETE of running jobs (fenced by the live lease).
        blobUploads: () => blobUploads,
        // p14-skill-catalogs: files of deferred skills (layout v2), only for skills pinned to the job.
        skillFiles: () => skills,
        // p11-session-continuity: CHECKPOINT_REPORT (fenced by the live lease).
        checkpoints: () => continuityService,
        // p15-services: CAPABILITIES.services, SERVICE_STATUS / SERVICE_LOGS / SERVICE_REQUEST.
        services: () => services,
        // p19-ide W2: CAPABILITIES.ide, IDE_STATUS / IDE_GIT_RESULT / IDE_FILE_DATA / IDE_EVENT.
        ide: () => ide,
        // p15-workspace-retention: CAPABILITIES.workfiles, WORKFILES_STATUS / DATA / FETCH.
        workfiles: () => workfiles,
        credentials:
          o.credentials ??
          firstCredential(
            new GitHubWorkerCredentials({
              db: deps.pool,
              apps: githubApps,
              log: instance.log.child({ component: 'gitflow-credentials' }),
            }),
            // p16-git-providers: GitLab / Bitbucket push tokens (the same trust gates).
            new HostedWorkerCredentials({
              db: deps.pool,
              hosts: () => gitHosts,
              log: instance.log.child({ component: 'gitflow-credentials' }),
            }),
          ),
        onWorkerConnected: (workerId) => {
          void orchestrator?.tick().catch(() => undefined);
          // p13-fleet-tools: bulk actions queued for this (until now offline) machine go out.
          void fleetToolsService.onWorkerConnected(workerId).catch(() => undefined);
          // p17-worker-managed: a removal that waited for this machine is sent now.
          void workerRemovals?.onWorkerConnected(workerId).catch(() => undefined);
        },
        ...(w.heartbeatTimeoutMs === undefined ? {} : { heartbeatTimeoutMs: w.heartbeatTimeoutMs }),
      });
      notifications = reportNotifier = new NotificationService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'notifications' }),
        notifiers: channelNotifiers,
        // p17-domain-wizard: the saved console address wins over NOTIFY_PUBLIC_URL.
        publicUrl: { current: () => consoleDomain.notifyBase() },
        ...(nd.options ? { options: nd.options } : {}),
        // p8-pwa: subscription keys sealed under their own sub-key; VAPID only when configured.
        // p17-panel-settings: the panel's key pair / subject / allowlist over the environment's, read per use.
        push: { sealKey: deps.box.deriveKey('push-keys'), resolve: pushNow },
      });
      // p6-chat-notify: "let me know when …" from the ops chat (thread note + chat.watch notification, owner only).
      const watchStreams = streams;
      const watchPublish = (threadId: string, message: MessageView | null): void => {
        if (message !== null) watchStreams.publish(threadId, 'message', message);
        watchStreams.publish(threadId, 'watch', {});
      };
      // p15-watches (Takipler): conditions the master checks itself — SQL on events, function jobs on workers.
      const watchExpr = new SandboxPool({ threads: 1 });
      instance.addHook('onClose', () => watchExpr.close());
      const watchChecks = new WatchChecks({
        // p15-services hand-off: `service_url` conditions resolve through the registry (woken by the services trigger).
        services: () =>
          services === null
            ? null
            : { resolve: (subject, id) => services?.resolveUrl(subject, id) ?? Promise.resolve(null) },
        pool: deps.pool,
        audit,
        store: chatStore,
        clock,
        log: instance.log.child({ component: 'watch-checks' }),
        notifications: () => notifications,
        publish: watchPublish,
        ...(deps.chat?.watchChecks?.dryWaitMs === undefined
          ? {}
          : { dryWaitMs: deps.chat.watchChecks.dryWaitMs }),
        ...(deps.chat?.watchChecks?.queueTimeoutSec === undefined
          ? {}
          : { queueTimeoutSec: deps.chat.watchChecks.queueTimeoutSec }),
        jobs: () => ({
          create: async (input) => {
            const { job } = await jobs.create({
              project: input.project,
              spec: input.spec,
              actor: { type: 'user', id: input.userId },
              function: true,
              submit: true,
              withinCreate: input.withinCreate,
            });
            return job.id;
          },
          cancel: async (jobId, reason) => {
            try {
              const { job } = await jobs.transition(jobId, 'cancel_requested', {
                actor: { type: 'system', id: 'chat-watches' },
                reason,
              });
              if (job.state === 'CANCELLING' && orchestrator !== null)
                await orchestrator.sendCancel(job, reason);
            } catch {
              // Already ended (or racing its end): nothing to cancel.
            }
          },
        }),
        egress: () => workflowEgress,
        jsonata: async (source, input) => {
          const r = await watchExpr.run({
            op: 'eval',
            source,
            mode: 'expr',
            context: { now: clock().toISOString(), input },
          });
          return r.ok ? { ok: true, value: r.value } : { ok: false, code: r.code };
        },
        // p15-watch-autorun: the `then` step — its card, run at once through the chat's direct path for `mode: auto`
        // where the security policy allows it.
        then: () => {
          if (chatToolsRef === null) return null;
          const runner = new WatchThenRunner({ tools: () => chatToolsRef, direct: () => chatDirect });
          return (caller, then) => runner.run(caller, then);
        },
      });
      instance.addHook('onClose', () => watchChecks.stop());
      chatWatches = new ChatWatchService({
        pool: deps.pool,
        audit,
        store: chatStore,
        clock,
        log: instance.log.child({ component: 'chat-watches' }),
        notifications: () => notifications,
        publish: watchPublish,
        checks: watchChecks,
        // p18-outputs-delivery: a job's end note says when its files were partly delivered in out-rest.zip.
        outputReport: (jobId) => outputLimits.report(jobId),
      });
      void watchChecks.listen();
      const watchService = chatWatches;
      const flowService = new ChatFlowService({
        pool: deps.pool,
        audit,
        store: chatStore,
        clock,
        log: instance.log.child({ component: 'chat-flow' }),
        notifications: () => notifications,
        publish: watchPublish,
        // W4: a decided / closed approval step reaches its chat cards through the stream (`flow`).
        event: (threadId, data) => {
          watchStreams.publish(threadId, 'flow', data);
        },
        // p18-outputs-delivery: the zipped-delivery line of a job result card.
        outputReport: (jobId) => outputLimits.report(jobId),
      });
      chatFlow = flowService;
      // p19-watch-follow-up: a watch that ended without its condition hands the conversation back to the assistant.
      const watchFollowUps = new WatchFollowUps({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'watch-follow-ups' }),
        chat: () => chat,
      });
      // p20-outcome: one owner row per open goal of a conversation; "nobody owns the next step" → one intervention.
      const goalStreams = streams;
      const goalLedger = new GoalLedger({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'chat-goals' }),
        addMessage: (threadId, m, tx) => chatStore.addMessage(threadId, m, tx),
        publish: (threadId, event, data) => {
          goalStreams.publish(threadId, event, data);
        },
        notifications: () => notifications,
        chat: () => chat,
        plans: () => chatPlans,
        watches: () => watchService,
      });
      chatGoals = goalLedger;
      const queueStreams = streams;
      const queueService = new QueueService({
        pool: deps.pool,
        audit,
        clock,
        log: instance.log.child({ component: 'queue' }),
        order: (rows) => quotaService.order(rows),
        policy: async () => (await quotaStore.currentPolicy()).policy,
        dispatch: (jobId) => {
          if (orchestrator === null) return Promise.resolve();
          return orchestrator.dispatch(jobId);
        },
        notify: () => notifications,
        // p6-chat-notify: a note in the thread a chat-started job came from.
        chatNote: async (tx, threadId, text, meta) => {
          const message = await chatStore.addMessage(
            threadId,
            { role: 'assistant', content: text, meta },
            tx,
          );
          queueStreams.publish(threadId, 'message', message);
        },
      });
      queue = queueService;
      const orch = new Orchestrator({
        pool: deps.pool,
        // p17-panel-settings: how long a job waits for a runtime login (Ayarlar → Sunucu ayarları → İşler).
        loginWaitMs: () =>
          panelSettings.source('jobs.loginWaitMinutes') === 'panel'
            ? panelSettings.get<number>('jobs.loginWaitMinutes', 30) * 60_000
            : (deps.orchestration?.timing?.loginWaitMs ?? 30 * 60_000),
        // p16-runtime-updates: owner-approved unverified runtime installs take jobs while the policy allows them.
        unverifiedRuntimeUpdates: async () => (await securityPolicy.current()).fleet.unverifiedRuntimeUpdates,
        // p17-runtime-verify: evidence overlay in placement, verifiedCapabilities in ASSIGN_JOB.
        capabilityEvidence: () => capabilityEvidence,
        jobs,
        audit,
        signer,
        replay: () => requireSessions().replay,
        sessions: requireSessions,
        inspector:
          o.inspector ??
          new ProviderBranchInspector({
            db: deps.pool,
            providers,
            fallback: new GitLsRemoteInspector({ internalOrigins: egressInternalOrigins }),
          }),
        clock,
        log: instance.log.child({ component: 'orchestrator' }),
        timing: { ...o.timing, leaseTtlMs },
        context: () => contextProvider,
        skills: () => ({
          issue: (jobId: string, workerId: string) => skills.issueForJob(jobId, workerId),
          trust: (jobId: string) => skills.trustForJob(jobId),
          layout: (jobId: string) => skills.layoutForJob(jobId),
        }),
        // p14-mcp-core (ADR-0054): pinned external MCP servers (mcp-v1 workers only).
        mcp: () => mcp,
        // p19-project-env: the project's environment credentials (vault refs, holders only).
        projectEnv: () => projectEnv,
        machineAdmin: () => machineAdminService,
        subtasks: () => subtaskService,
        // p14-ask-user: ASSIGN_JOB execution.askUser (ask-user-v1 workers).
        questions: () => questionService,
        previews: () => previews,
        // p15-services: ASSIGN_JOB execution.services (services-v1 workers).
        services: () => services,
        // p15-workspace-retention: ASSIGN_JOB execution.keepFiles / seedFiles, preferred machine of a follow-up.
        workfiles: () => workfiles,
        // p18-project-bootstrap: the project's preferred machines (soft placement preference).
        preferredWorkers: () => preferredWorkers,
        // p16-zip-job-input: placement (input-bundle-v1) and ASSIGN_JOB execution.inputBundle.
        inputBundles: () => inputUploads,
        // p17-object-storage: ASSIGN_JOB execution.blobUpload (blob-upload-v1 workers, workspace jobs).
        blobUploads: () => blobUploads,
        // p17-output-limits: ASSIGN_JOB execution.outputLimits (output-limits-v1 workers), project overrides.
        outputLimits: () => outputLimits,
        effects: () => effects,
        // Dependencies first (a blocked job is not counted against quotas), then quotas.
        // p6-quota-scheduling: a deferred job waits for its window before it counts against quotas.
        // p9-queue-priority: then the project's per-user / per-automation limits (off by default).
        admissions: () => [workflowService, quotaScheduling, queueService, quotaService],
        steps: () => [
          ...quotaService.steps(),
          ...workflowService.steps(),
          automationService.step(),
          { name: 'workspace-chunks', run: () => workspaceService.pruneStaleChunks() },
          // p22-ops-hygiene: processed worker_inbox journal rows older than 7 days (hourly, bounded batches).
          { name: 'inbox-retention', run: () => inboxRetention.maybePrune() },
          // p6-deploy-pipeline: status of deploying ops actions (Coolify deployments, Pages deployments).
          { name: 'ops-deploying', run: () => (ops === null ? Promise.resolve(0) : ops.pollDeploying()) },
          // p10-site-upload: expired / undeployed / surplus uploaded sites (self-throttled to once a minute).
          {
            name: 'site-uploads',
            run: () => (siteUploads === null ? Promise.resolve(0) : siteUploads.sweep()),
          },
          // p8-preview-tunnels: expired / orphaned previews closed, stable ones detached, tear-downs retried.
          { name: 'preview-tunnels', run: () => (previews === null ? Promise.resolve(0) : previews.sweep()) },
          // p15-services: services past their lifetime stopped, tunnels of stopped services closed.
          { name: 'services', run: () => (services === null ? Promise.resolve(0) : services.sweep()) },
          // p19-ide W2: running IDE workspaces without a socket or a request for their idle time are stopped.
          { name: 'ide-idle', run: () => (ide === null ? Promise.resolve(0) : ide.sweep()) },
          // p15-workspace-retention: pins refreshed, expired kept directories removed, machine caps applied.
          { name: 'workfiles', run: () => (workfiles === null ? Promise.resolve(0) : workfiles.sweep()) },
          // p16-zip-job-input: expired / unused / surplus job input bundles (self-throttled to once a minute).
          { name: 'input-uploads', run: () => inputUploads.sweep() },
          // p10-verify-health: succeeded jobs with "Verify when done" → master checks → verifier job → result.
          verificationService.step(),
          // p11-merge-pipeline: coordinators' sub-job branches / workflow integrators → one integration branch + PR.
          integrationService.step(),
          // p6-deploy-on-success: finished jobs with a pre-approved deploy → ops action → outcome → creator told.
          {
            name: 'deploy-on-success',
            run: () => (deployOnSuccess === null ? Promise.resolve(0) : deployOnSuccess.tick()),
          },
          { name: 'workspace-storage', run: () => storageSweeper.maybeSweep() },
          // p17-object-storage: unreferenced blobs (pruned, deleted, never committed) and expired upload grants.
          { name: 'blob-gc', run: () => blobGc() },
          watchService.step(),
          // p17-chat-flow: workflow approvals waiting / runs ended → the conversations they came from (once each).
          flowService.step(),
          // p19-watch-follow-up: check watches that ended unmet → one assistant turn that carries on (once each).
          watchFollowUps.step(),
          // p20-outcome: goals adopted, assessed (intervention once when nobody owns the next step), resumes sent.
          goalLedger.step(),
          // p18-plan-mode: plan item statuses from their cards / jobs / runs, then continuation turns of plans.
          ...(chatPlans === null ? [] : [chatPlans.step()]),
          // p9-queue-priority: jobs waiting longer than their project's threshold → creator (+ chat thread) told once.
          queueService.step(),
          // p8-capacity-auto: suggest / auto machines, each evaluated once per 30 s (self-throttled).
          { name: 'capacity', run: () => capacityService.tick() },
          // p8-cost-efficiency: weekly reports at Monday 08:00 in each user's zone (self-throttled to 1/min).
          { name: 'weekly-reports', run: () => reports.tick() },
          // p8-uptime: claim due monitors and start their checks (not awaited; bounded concurrency).
          { name: 'uptime', run: () => uptimeService.tick() },
          // p10-verify-health: health checks after deploys / preview links (not awaited).
          deployHealthService.step(),
          // p12-deploy-feedback: failed deploys / health checks of projects with auto-fix on → one bounded fix job.
          deployFeedbackService.step(),
          // p15-auto-mode: a job that failed for good gets one auto-fix job; finished fix jobs notify once.
          autoFix.step(),
          // p22-conflict-resolve: auto mode opens a resolve job for a conflicting result; merged ones supersede it.
          conflictResolveService.step(),
          // p8-orchestration: open sub-jobs of ended parents are cancelled (one family level per tick).
          { name: 'subtask-cascade', run: () => subtaskService.cascade() },
          // p14-ask-user: expire questions past their deadline, withdraw those of ended jobs / attempts.
          { name: 'questions', run: () => questionService.tick() },
          // p15-message-delivery: held messages go out once the agent runs; messages of ended attempts close.
          {
            name: 'job-messages',
            run: () => (jobMessages === null ? Promise.resolve(0) : jobMessages.tick()),
          },
          // p8-outputs-folders: outputs of ended jobs → the folder they were asked into (requester re-checked).
          { name: 'output-folders', run: () => outputFolders.linkTick() },
          // p10-backup-restore: failed / overdue backups and restore drills → owners and admins (1/min).
          { name: 'backups', run: () => backupStatus.tick() },
          // p10-approval-pause: stale marks, pauses, retention ends (the resume itself runs before dispatch).
          { name: 'approval-pause', run: () => approvalPause.tick() },
          // p11-usage-limit-fallback: limits that reset (notice), due waits → resume, stuck parked attempts → restart.
          { name: 'usage-limits', run: () => usageLimits.tick() },
          // p11-session-continuity: restart episodes that could not resume within a day end the job.
          { name: 'session-continuity', run: () => continuityService.tick() },
          // p11-limit-visibility: usage-window history older than 24 h.
          { name: 'runtime-usage', run: () => runtimeUsage.tick() },
          // p13-fleet-tools: version feeds (6 h), queued / running bulk actions, the weekly update digest (15 s).
          { name: 'fleet-tools', run: () => fleetToolsService.tick() },
          // p16-selfhost-onboarding: the signed update feed (URL every 6 h, the host-cached copy every 5 min).
          { name: 'update-feed', run: () => updateFeed.tick() },
          // p17-update-channel: the worker feed (6 h / host copy 5 min), imports, the policy, canary-first rollouts.
          { name: 'update-channel', run: () => updateChannel?.tick() ?? Promise.resolve() },
          // p17-update-channel: the version catalog (6 h / host copy 5 min) and its delivery to workers.
          { name: 'version-catalog', run: () => versionCatalog?.tick() ?? Promise.resolve() },
          // p17-domain-wizard: the saved address (other instances) and the host applier's domain change results.
          { name: 'console-domain', run: () => consoleDomain.tick() },
          // p17-host-actions: results of update / rollback / backup requests the host applier ran.
          { name: 'host-actions', run: () => hostActions.tick() },
          { name: 'backup-change-watch', run: () => backupChanges.tick() },
          // p17-panel-settings: another instance saved the panel settings → reload them here.
          { name: 'panel-settings', run: () => panelSettings.tick() },
          { name: 'mail-settings', run: () => mailSettings.tick() },
          // p17-panel-settings Part 7: a maintenance job whose master stopped is failed "interrupted".
          { name: 'maintenance', run: () => maintenance.tick() },
        ],
        pause: () => pauses,
        usageLimits: () => usageLimits,
        accounts: () => runtimeAccounts,
        continuity: () => continuityService,
        gitflow: () => flow,
        selfHeal: () => selfHealService,
        ...(deps.telemetry ? { instrument: stepInstrument(deps.telemetry) } : {}),
        // p22-ops-hygiene: a step that failed on a down Redis / Postgres waits for it (one debug line).
        gate: (name, fn) => gated(`orchestrator:${name}`, fn),
        // p16-observability: a job.dispatch span per assignment; ASSIGN_JOB carries its trace context.
        ...(deps.telemetry ? { traceSpan: telemetrySpan(deps.telemetry) } : {}),
      });
      orchestrator = orch;
      const hints = deps.telemetry ? instrumentHints(deps.telemetry) : null;
      const rawOnHint = (hint: { jobId: string; version: number }) => orch.onHint(hint);
      const onHint = hints === null ? rawOnHint : hints.consumer(rawOnHint);
      const rawQueue =
        o.redisUrl === undefined || o.redisUrl === null
          ? new DirectHintQueue(onHint)
          : new BullHintQueue({
              redisUrl: o.redisUrl,
              ...(o.hintPrefix === undefined ? {} : { prefix: o.hintPrefix }),
              onHint,
              log: instance.log.child({ component: 'hints' }),
            });
      hintQueue = hints === null ? rawQueue : hints.queue(rawQueue);
      relay = new OutboxRelay({
        pool: deps.pool,
        queue: hintQueue,
        replay: () => requireSessions().replay,
        log: instance.log.child({ component: 'relay' }),
        clock,
      });
      instance.decorate('workerHub', hub);
      instance.decorate('fleetSessions', fleetSessions);
      instance.decorate('orchestrator', orch);
      instance.decorate('continuity', continuityService);
      instance.decorate('outboxRelay', relay);
      instance.decorate('notifications', notifications);
      instance.decorate('quotas', quotaService);
      instance.decorate('reports', reports);
      instance.decorate('workflows', workflowService);
      instance.decorate('schedules', scheduleService);
      instance.decorate('automations', automationService);
      instance.decorate('ops', ops);
      instance.decorate('deployOnSuccess', deployOnSuccess);
      instance.decorate('outputFolders', outputFolders);
      instance.decorate('chatWatches', watchService);
      instance.decorate('chatFlow', flowService);
      instance.decorate('chatPlans', chatPlans);
      instance.decorate('chatGoals', goalLedger);
      instance.decorate('uptime', uptimeService);
      instance.decorate('backups', backupStatus);
      instance.decorate('verification', verificationService);
      instance.decorate('integration', integrationService);
      instance.decorate('deployHealth', deployHealthService);
      instance.decorate('fleetTools', fleetToolsService);
      instance.decorate('fleetToolFeed', feedService);
      instance.decorate('opsSafety', { expiry, brake: costBrake, breaker: () => rolloutBreaker });
      instance.decorate('webhooksOut', webhooksOut);
      instance.decorate('doctor', { service: doctor, support });
      instance.decorate('deployFeedback', deployFeedbackService);
      instance.decorate('previews', previews);
      instance.decorate('services', services);
      instance.decorate('ide', ide);
      instance.decorate('workfiles', workfiles);
      instance.decorate('inputUploads', inputUploads);
      instance.decorate('workfilesExport', workfilesExport);
      instance.decorate('questions', questionService);
      instance.decorate('workspaceStorage', storageSweeper);
      instance.decorate('gitflow', flow);
      instance.decorate('live', live);
      // ADR-0023: bring stored configuration in line with the removal of OpenHands (idempotent, best effort).
      const retire = () =>
        retireOpenHands({
          pool: deps.pool,
          jobs,
          log: instance.log.child({ component: 'runtime-retirement' }),
          sendCancel: (jobId, reason) => orch.sendCancel({ id: jobId }, reason),
          ...(workerConfigs === null ? {} : { workerConfigs }),
          ...(runtimePolicies === null ? {} : { runtimePolicies }),
        });
      instance.decorate('retireRuntimes', retire);
      if (deps.retireRuntimes !== false) {
        instance.addHook('onReady', async () => {
          await retire();
        });
      }
      instance.decorate('chat', chatService);
      instance.decorate('skills', skills);
      instance.decorate('mcp', mcp);
      instance.decorate('projectEnv', projectEnv);
      instance.decorate(
        'alerts',
        new AlertEvaluator({
          pool: deps.pool,
          audit,
          notifications,
          clock,
          log: instance.log.child({ component: 'alerts' }),
          budgets: budgetSamples,
          ...(deps.alerts?.thresholds ? { thresholds: deps.alerts.thresholds } : {}),
          ...(deps.alerts?.cooldownMs === undefined ? {} : { cooldownMs: deps.alerts.cooldownMs }),
          ...(deps.alerts?.resolveAfterMs === undefined
            ? {}
            : { resolveAfterMs: deps.alerts.resolveAfterMs }),
          listeners: alertListeners,
        }),
      );
      instance.decorate('systemStatus', systemStatus);
      instance.decorate('updates', updateFeed);
      instance.decorate('hostActions', hostActions);
      instance.decorate('backupChanges', backupChanges);
      instance.decorate('panelSettings', panelSettings);
      instance.decorate('maintenance', maintenance);
      instance.decorate('consoleDomain', consoleDomain);
      // p17-domain-wizard: links use the saved address from the first request on.
      instance.addHook('onReady', async () => {
        await consoleDomain.load();
      });
      instance.decorate('setup', setupService);
      instance.decorate('gitHosts', gitHosts);
      instance.decorate('logStore', logStore);
      instance.decorate('chatAdmin', chatAdmin);
      instance.decorate('chatOpsTools', chatOpsTools);
      instance.decorate('chatProjectSetup', chatProjectSetup);
      instance.decorate('chatCodeTools', chatCodeTools);
      instance.decorate('threadProjects', threadProjects);
      instance.decorate('jobBatches', jobBatches);
      instance.decorate('semanticSearch', search);
      instance.decorate('memorySuggestions', memorySuggestions);
      instance.decorate('relatedWork', relatedWork);
      instance.decorate('memoryRecords', memoryRecords);
      instance.decorate('semanticDefaults', semanticDefaults);
      instance.decorate('chatKnowledge', chatKnowledge);
      forwarder?.setLog(instance.log.child({ component: 'agentmagnify' }));
      instance.decorate('agentmagnify', forwarder);
      instance.decorate(
        'metrics',
        deps.telemetry
          ? new MasterMetrics({
              pool: deps.pool,
              telemetry: deps.telemetry,
              log: instance.log.child({ component: 'metrics' }),
              clock,
              budgets: budgetSamples,
            })
          : null,
      );
    },
    routes: [
      healthRoutes([postgresProbe(deps.pool), redisProbe(deps.redis)]),
      // p5-git-identity: per-project commit identity and the workspace-wide default.
      gitIdentityRoutes(new GitIdentityService({ pool: deps.pool, audit, clock }), clock),
      // p1-monitoring: the public uptime probe (cached, "ok"/"unavailable" only).
      statusRoutes([postgresProbe(deps.pool), redisProbe(deps.redis)]),
      // p6-logs-ui: the master's time for the console header clock (any signed-in role).
      timeRoutes(clock),
      authRoutes(
        service,
        clock,
        (userId) => userLocales.effective(userId),
        // p14-workflow-engine 14.1: the editor offers the new node types only when engine 2 is on.
        () => ({ workflowEngineV2: workflows?.engineFlags.v2 === true }),
        // p15-autonomy: the events the console need not ask a code for.
        async () =>
          Object.entries((await securityPolicy.current()).events)
            .filter(([, on]) => !on)
            .map(([e]) => e),
        // p17-remyral-brand: the console colour theme.
        (userId) => userThemes.effective(userId),
      ),
      meRoutes(userLocales, userThemes, decisionDeferrals),
      // p15-autonomy (ADR-0056): Settings → Security.
      securityPolicyRoutes(securityPolicy, clock),
      // p16-ops-safety: keys and expiry, the cost brake, the rollout breaker buttons.
      opsSafetyRoutes({ expiry, brake: costBrake, breaker: () => rolloutBreaker, clock }),
      approvalRoutes(approvals, policies, clock, deps.pool),
      approvalPauseRoutes({ service: approvalPause, pool: deps.pool, db: deps.pool, audit, clock }),
      usageLimitRoutes({ service: usageLimits, pool: deps.pool, audit, clock }),
      continuityRoutes({ service: continuityService, db: deps.pool }),
      runtimeUsageRoutes({ service: runtimeUsage, clock, refresh: () => usageRefresh }),
      runtimeAccountRoutes({ service: runtimeAccounts, switcher: accountSwitch, pool: deps.pool, clock }),
      contextRoutes(context, clock, deps.pool, contextPolicy),
      skillRoutes(skills, deps.pool, clock, () => skillImports.githubEnabled),
      // p14-skill-import (ADR-0054): import previews, panel-signed publish, per-project skill trust.
      skillImportRoutes(skillImports, skills, clock, skillCatalog),
      // p14-mcp-core (ADR-0054): MCP server catalog, secrets, tool policy, assignments, project switch, job pins.
      mcpRoutes(mcp, deps.pool, clock),
      // p19-install-scripts (ADR-0068): Ayarlar → Güvenlik → Kurulum betikleri.
      installScriptRoutes(installScriptApprovals, clock),
      // p14-mcp-chat (ADR-0054 P5): Keşfet search, install previews (always-fresh confirm), install progress.
      mcpPreviewRoutes(mcpPreviews, mcpDiscovery, clock),
      contextPolicyRoutes({ policy: contextPolicy, gate, audit, clock, exportLimits }),
      searchRoutes(search, clock),
      // p10-bedrock-integration-panel: Settings → Integrations → AWS Bedrock (embeddings).
      bedrockRoutes({ bedrock, clock }),
      // p17-object-storage: Settings → Integrations → Storage, downloads (presigned / streamed), share links, and the
      // worker's upload endpoint of the local blob directory.
      storageRoutes({ settings: storageSettings, clock }),
      blobDownloadRoutes({ blobs: blobService, shares: shareLinks, db: deps.pool, limiter }),
      blobUploadRoutes({ uploads: blobUploads, limiter }),
      // p10-semantic-memory: the Memory suggestions inbox, opt-in, backfill, "Summarise with an agent" prompt.
      memorySuggestionRoutes(memorySuggestions, deps.pool, clock),
      // p17-embeddings: similar jobs, solved failures, "a similar record exists", the context setting.
      relatedRoutes({ db: deps.pool, related: () => relatedWork }),
      // p11-memory-layers: typed records, decision history, conflicts, personal rules, what a job received.
      memoryRecordRoutes(memoryRecords, deps.pool),
      // p17-memory-import: a person's memory from their own AI assistant → reviewed records; undo per batch.
      memoryImportRoutes(memoryImports, limiter),
      // p10-semantic-defaults-chat: Settings → Context → defaults for new projects.
      semanticDefaultsRoutes(semanticDefaults, clock),
      auditRoutes({ db: deps.pool, audit, gate, clock, exportLimits }),
      jobReadRoutes({
        query: jobQuery,
        db: deps.pool,
        audit,
        gate,
        clock,
        exportLimits,
      }),
      (app) => {
        jobTitleRoutes({ titles: jobTitles, db: deps.pool })(app);
        // p15-job-titles: titles for jobs created before migration 0130 (bounded batches; never blocks start-up).
        app.addHook('onReady', () => {
          void jobTitles.backfill().catch((err: unknown) => {
            app.log.warn({ err, component: 'job-titles' }, 'job title backfill failed');
          });
        });
      },
      // p16-api-tokens (ADR-0058): personal tokens, every token (admins), service accounts.
      apiTokenRoutes(apiTokens, clock),
      // p16-webhooks-out (ADR-0059): Settings → Webhooks.
      webhookRoutes(webhooksOut, clock),
      directoryRoutes(
        (directory = new Directory({
          pool: deps.pool,
          audit,
          clock,
          semanticDefaults,
          // p15-autonomy: autonomy defaults of new projects.
          securityPolicy,
          ...(deps.passwordParams ? { passwordParams: deps.passwordParams } : {}),
        })),
        clock,
      ),
      workerRoutes,
      fleetApi,
      runtimePolicyApi,
      workerConfigApi,
      vaultApi,
      remoteOpsApi,
      releaseApi,
      usageRoutes(usage, clock, deps.pool, () => {
        void orchestrator?.tick().catch(() => undefined);
      }),
      efficiencyRoutes(efficiency, reports, clock),
      (app) => {
        if (orchestrator === null) throw new Error('orchestrator not initialised');
        jobWriteRoutes({
          jobs,
          orchestrator,
          db: deps.pool,
          ...(workspaces === null ? {} : { workspaces }),
          deployOnSuccess: () => deployOnSuccess,
          outputFolders: () => outputFolders,
          templates,
          verification: () => verification,
          runtimeAdvice,
          inputUploads: () => inputUploads,
        })(app);
        // p16-zip-job-input: job input bundles (chunked upload, job page facts).
        inputUploadRoutes({ service: inputUploads, db: deps.pool })(app);
        if (approvalModes === null) throw new Error('approval mode service not initialised');
        approvalModeRoutes({ service: approvalModes, db: deps.pool })(app);
        if (timeLimits === null) throw new Error('time limit service not initialised');
        timeLimitRoutes({ service: timeLimits, db: deps.pool, clock, jobClock: () => jobClock })(app);
        if (selfHeal === null) throw new Error('self-heal service not initialised');
        selfHealRoutes({ service: selfHeal, db: deps.pool, conflicts: conflictResolve })(app);
        if (subtasks === null) throw new Error('sub-job service not initialised');
        subtaskRoutes({ subtasks, db: deps.pool })(app);
        if (questions === null) throw new Error('question service not initialised');
        questionRoutes({ questions, db: deps.pool, chat: () => chat })(app);
        if (integration === null) throw new Error('integration service not initialised');
        integrationRoutes({ integration, db: deps.pool, clock })(app);
        if (workspaces === null) throw new Error('workspace service not initialised');
        workspaceRoutes({ service: workspaces, db: deps.pool, clock })(app);
        const orch = orchestrator;
        composerRoutes({
          db: deps.pool,
          preview: () => {
            if (quotas === null || runtimePolicies === null) throw new Error('services not initialised');
            const q = quotas;
            const rp = runtimePolicies;
            return {
              db: deps.pool,
              candidates: (project) => orch.candidates(project),
              quotas: (project, runtime) => q.preview(project, runtime),
              policyOf: async (workerId) => (await rp.forWorker(workerId)).effective?.document ?? null,
              outcomes: (key) => outcomesFor(deps.pool, key),
            };
          },
          definition: (id) => {
            if (workflows === null) throw new Error('workflow service not initialised');
            return workflows.definition(id);
          },
        })(app);
        reuseRoutes({ db: deps.pool, reuse: () => resultReuse, workspaces })(app);
        if (schedules === null) throw new Error('schedule service not initialised');
        scheduleRoutes({ schedules, db: deps.pool, clock })(app);
        if (automations === null) throw new Error('automation service not initialised');
        automationRoutes({
          service: automations,
          clock,
          // p18-multi-project W4: automation groups ("Projeler", "Tümüne uygula").
          ...(automationGroups === null ? {} : { groups: automationGroups }),
        })(app);
        const automationService = automations;
        templateRoutes({ service: templates, db: deps.pool, clock, automations: () => automationService })(
          app,
        );
      },
      (app) => {
        // Public, signature-authenticated inbound triggers (own scope: raw-body JSON parser).
        if (automations === null) throw new Error('automation service not initialised');
        const wfs = workflows;
        automationHookRoutes({
          service: automations,
          ...(wfs === null
            ? {}
            : {
                waits: (t, h, raw, meta) => wfs.receiveWait(t, h, raw, meta),
                // p14-workflow-engine 14.4: webhook calls held for a `control.respond` answer.
                respond: (a, r, signal) => wfs.awaitWebhookAnswer(a, r, signal),
              }),
        })(app);
      },
      notificationApi,
      // p12-diyalog Faz 1: the Diyalog home's operations thread (own notifications + open cards).
      opsThreadRoutes(
        new OpsThreadService({
          pool: deps.pool,
          clock,
          approvals,
          approvalJson: approvalRequestJson,
          jobs: jobQuery,
          jobJson: jobSummaryJson,
          ops: () => ops,
          integration: () => integration,
          usageLimits,
          workflowApprovals: () => chatFlow,
        }),
      ),
      (app) => {
        if (quotas === null) throw new Error('quota service not initialised');
        quotaRoutes({ service: quotas, store: quotaStore, clock })(app);
        quotaSchedulingRoutes({ service: quotaScheduling, db: deps.pool, clock })(app);
        if (queue === null) throw new Error('queue service not initialised');
        queueRoutes({ service: queue, db: deps.pool, clock })(app);
        packageCacheRoutes({ service: packageCaches, clock })(app);
        projectEnvRoutes({ service: projectEnv, clock })(app);
      },
      (app) => {
        if (workflows === null) throw new Error('workflow service not initialised');
        workflowRoutes({
          workflows,
          db: deps.pool,
          clock,
          limiter,
          // p14-workflow-engine 14.2: trigger nodes ↔ bound automations.
          triggers: new WorkflowTriggerService({
            pool: deps.pool,
            audit,
            clock,
            automations: () => automations,
          }),
          ...(workspaces === null ? {} : { workspaces }),
          approvals: () => chatFlow,
        })(app);
        // p18-multi-project: shared workflows — offers, attachments, credential slots, "where used".
        if (sharedWorkflows === null) throw new Error('shared workflows not initialised');
        workflowSharingRoutes({ service: sharedWorkflows, db: deps.pool, clock })(app);
        // p18-multi-project W5: job fan-out batches.
        jobBatchRoutes({ batches: () => jobBatches })(app);
        // p14-workflow-engine 14.3 (K1): the project's HTTP egress policy of HTTP / e-mail nodes.
        if (workflowEgress === null) throw new Error('workflow egress not initialised');
        workflowEgressRoutes({ service: workflowEgress, clock })(app);
        // p14-repo-egress: Projects → Policy → Network access of repository projects.
        repoEgressRoutes({ service: repoEgress, clock })(app);
        // p22-runtime-diagnostics: Projects → Policy → Trusted certificates, the job page's Trust this certificate.
        tlsPinRoutes({ service: tlsPins, clock })(app);
        // p14-workflow-engine 14.5: ready-made workflow templates (gallery + instantiate).
        workflowTemplateRoutes({
          workflows,
          audit,
          clock,
          sharing: () => sharedWorkflows,
          db: deps.pool,
        })(app);
        // p15-workflow-ai: the editor's AI panel (threads linked to workflows, design / edit / explain / debug).
        if (workflowAi === null) throw new Error('workflow ai not initialised');
        workflowAiRoutes({ service: workflowAi })(app);
        if (gitflow === null) throw new Error('git flow not initialised');
        gitFlowRoutes({ service: gitflow, configs: gitConfigs, db: deps.pool, clock })(app);
        if (githubConnect === null) throw new Error('github connect not initialised');
        githubConnectRoutes({ service: githubConnect, configs: gitConfigs, providers, clock })(app);
        // p16-git-providers: Ayarlar → Entegrasyonlar → GitLab / Bitbucket.
        gitHostRoutes({ service: gitHosts, clock })(app);
        if (githubRepos === null) throw new Error('github repos not initialised');
        githubRepoRoutes({ service: githubRepos, clock })(app);
        if (ops === null) throw new Error('ops service not initialised');
        opsRoutes({ service: ops, integrations: opsIntegrations, clock })(app);
        if (coolifyApps === null) throw new Error('coolify apps not initialised');
        coolifyAppRoutes({ service: coolifyApps, clock })(app);
        if (coolifyResources === null) throw new Error('coolify resources not initialised');
        coolifyResourceRoutes({ service: coolifyResources, clock })(app);
        if (deployFeedback === null) throw new Error('deploy feedback not initialised');
        deployFeedbackRoutes({ db: deps.pool, ops, feedback: deployFeedback, clock })(app);
        if (siteUploads === null) throw new Error('site uploads not initialised');
        siteUploadRoutes({ service: siteUploads })(app);
        if (previews === null) throw new Error('preview service not initialised');
        previewRoutes({ service: previews, db: deps.pool, clock })(app);
        if (services === null) throw new Error('services not initialised');
        serviceRoutes({ service: services, db: deps.pool })(app);
        if (workfiles === null || workfilesExport === null) throw new Error('workfiles not initialised');
        workfilesRoutes({ service: workfiles, exporter: workfilesExport, db: deps.pool })(app);
        // p19-ide W1: Kod tab, Değişiklikler reviewer, review comments, "Değişiklik iste".
        codeRoutes({ service: codeService, db: deps.pool })(app);
        // p19-ide W2: Tam IDE (console REST) and the IDE origin (host-gated, own cookie).
        if (ide === null || ideProxy === null) throw new Error('IDE not initialised');
        ideRoutes({ service: ide, db: deps.pool, clock })(app);
        // p19-ide W3: extension policy (admin, project), the user's list, and the worker's start downloads.
        if (ideExtensions === null) throw new Error('IDE extensions not initialised');
        ideExtensionRoutes({ extensions: ideExtensions, clock })(app);
        ideWorkerDownloadRoutes({ extensions: ideExtensions, limiter })(app);
      },
      (app) => {
        if (ideProxy === null) throw new Error('IDE proxy not initialised');
        ideProxy.plugin(app);
      },
      // p6-outputs: live sites, job files and notes in one place.
      outputRoutes({ service: outputsService, db: deps.pool, limiter, folders: outputFolders }),
      // p10-backup-restore: Settings → Backups (status only).
      backupRoutes({ service: backupStatus }),
      // p16-selfhost-onboarding: first owner (public, rate-limited), the setup wizard, the update banner.
      // The claim limiter fails closed (no Redis: refused), like the login limits.
      setupRoutes({ service: setupService, limiter }),
      onboardingRoutes({ service: onboarding }),
      updateRoutes({ service: updateFeed }),
      // p17-domain-wizard: Kurulum sihirbazı → Alan adı ve erişim (owners; changes step-up by policy).
      consoleDomainRoutes({ service: consoleDomain, clock }),
      // p17-host-actions: Ayarlar → Sürümler → Sunucu (owners; always-fresh step-up).
      hostActionRoutes({ service: hostActions, clock }),
      // p17-host-actions part 3: Ayarlar → Yedekler — backups now, drills, settings, off-site target, restore (owners).
      backupManageRoutes({ service: backupManage, changes: backupChanges, clock }),
      panelSettingsRoutes({ service: panelSettings, clock, hooks: panelHooks }),
      mailRoutes({ pool: deps.pool, audit, mail: mailSettings, clock }),
      workflowCheckRoutes({ pool: deps.pool, audit }),
      recoveryRoutes({ service: userRecovery, clock }),
      keyRoutes({ service: keyRotation, clock }),
      maintenanceRoutes({ service: maintenance, clock }),
      // p16-observability: Ayarlar → Sistem durumu (status, recent traces, log search).
      systemRoutes({ status: systemStatus, traces: () => obs.recentTraces ?? null, logs: () => logStore }),
      // p16-doctor (ADR-0062): Ayarlar → Tanılama (doctor runs, machine doctors, the support report).
      doctorRoutes({ doctor, support, remoteOps: () => remoteOps, clock }),
      // p8-outputs-folders: own folders and the automatic tree.
      folderRoutes({ folders: outputFolders, tree: outputTree, limiter }),
      // p8-uptime: monitors of deployed sites and services.
      (app) => {
        if (uptime === null) throw new Error('uptime service not initialised');
        uptimeRoutes({ service: uptime, limiter })(app);
      },
      // p10-verify-health: job verification, project settings, post-deploy health checks.
      (app) => {
        if (verification === null || deployHealth === null) throw new Error('verification not initialised');
        verifyRoutes({ db: deps.pool, verification, health: deployHealth, settings: verifySettings, clock })(
          app,
        );
      },
      (app) => {
        if (live === null) throw new Error('live view not initialised');
        liveRoutes({ ...live, db: deps.pool, diff: () => gitflow })(app);
      },
      retiredInteractiveRoutes(),
      (app) => {
        if (chat === null || chatStreams === null || drafts === null || jobMessages === null)
          throw new Error('chat not initialised');
        const chatShares = new ChatShares({ pool: deps.pool, store: chatStore, audit, clock });
        chatRoutes({
          service: chat,
          store: chatStore,
          settings: chatSettings,
          drafts,
          streams: chatStreams,
          jobMessages,
          db: deps.pool,
          clock,
          ...(chatWatches === null ? {} : { watches: chatWatches }),
          attachments: chatAttachments,
          mentions: chatMentions,
          knowledge: chatKnowledge,
          // p18-multi-project W3: GET / PUT /chat/threads/:id/projects.
          threadProjects: () => threadProjects,
          organizer: chatOrganizer,
          limiter,
          // p10-chat-job-actions: quick buttons on job cards.
          jobActions: new ChatJobActions({ db: deps.pool, store: chatStore }),
          // p14-ask-user: question cards in the thread view.
          questions: () => questions,
          // p15-workflow-ai: the workflow a conversation is linked to (Sohbet → back to the editor).
          workflowLink: (userId, threadId) => workflowAi?.link(userId, threadId) ?? Promise.resolve(null),
          // p15-chat-vault: "save to vault" cards completed by the browser.
          credentials: () => chatCredentials,
          // p16-chat-complete: shared readers, handing over, export.
          shares: chatShares,
          // p18-plan-mode: plan mode and the active plan in the thread view.
          plans: () => chatPlans,
          // p20-quick: GET /chat/status `direct` (the security policy's autonomy.chatDirect).
          direct: () => (chatDirect === null ? Promise.resolve(null) : chatDirect.enabled()),
          // p20-scope-preview: GET / DELETE /chat/threads/:id/goal-grants.
          goalGrants: () => goalGrants,
          // oss-sec3: GET /chat/untrusted-allows, DELETE /chat/untrusted-allows/:id, confirm `remember`.
          untrustedAllows: () => untrustedAllows,
        })(app);
        // p18-plan-mode: the plan API.
        planRoutes({ plans: () => chatPlans, store: chatStore, shares: chatShares })(app);
        // p20-outcome: the goals and their intervention cards ("Senden bekleyen").
        goalRoutes({ goals: () => chatGoals })(app);
        // W4: "Bu sohbete sonuç gönderme" for the scheduled result cards of a conversation.
        flowRoutes({ flow: () => chatFlow })(app);
        // p10-chat-organize: pins, groups, tags, stars and the chat sidebar.
        chatOrganizeRoutes({ organizer: chatOrganizer, assets: chatAssets, store: chatStore, limiter })(app);
      },
      ssoRoutes({
        pool: deps.pool,
        provider: oidcProvider,
        gate: coolifyGate,
        clock,
        coolifyConnections: () => opsIntegrations.coolifyConnections.list(),
      }),
      ...(deps.extraRoutes ?? []),
    ],
  });
  const tickMs = o.tickIntervalMs ?? 2_000;
  let loopStopped = false;
  if (tickMs > 0) {
    // One pass at a time: a slow pass (load, outage) is skipped over, never queued up.
    let running = false;
    const loop = setInterval(() => {
      if (relay === null || orchestrator === null || running) return;
      running = true;
      const r = relay;
      const orch = orchestrator;
      void gated('outbox-relay', () => r.relayOnce())
        .catch((err: unknown) => {
          if (!loopStopped) app.log.warn({ err }, 'outbox relay failed; retrying');
        })
        .then(() => (loopStopped ? undefined : orch.tick()))
        .catch(() => undefined)
        .finally(() => {
          running = false;
        });
    }, tickMs);
    loop.unref();
    app.addHook('onClose', () => {
      loopStopped = true;
      clearInterval(loop);
      return Promise.resolve();
    });
  }
  // p16-observability: log store flush / purge and the metric history sampling.
  {
    const flushMs = obs.logFlushMs ?? 1000;
    const stopLogs =
      logStore !== null && flushMs > 0 ? logStore.start(flushMs, obs.logPurgeMs ?? 600_000) : null;
    const historyMs = obs.historyIntervalMs ?? 60_000;
    const stopHistory = obs.history && historyMs > 0 ? obs.history.start(historyMs) : null;
    app.addHook('onClose', async () => {
      stopLogs?.();
      stopHistory?.();
      systemStatus.stop();
      await logStore?.flush().catch(() => undefined);
    });
  }
  app.addHook('onClose', async () => {
    loopStopped = true;
    // p8-uptime: let running checks finish (bounded by their own time-outs, at most 5 s here).
    if (uptime !== null) {
      await Promise.race([uptime.drain(), new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    }
    // p10-verify-health: the same for running verifications / health checks.
    const verifyDrain = Promise.all([verification?.drain(), deployHealth?.drain(), integration?.drain()]);
    await Promise.race([verifyDrain, new Promise((resolve) => setTimeout(resolve, 5_000).unref())]);
    await hintQueue?.close();
    await app.live.bus.stop();
  });
  const chatSweepMs = deps.chat?.sweepIntervalMs ?? 15_000;
  if (chatSweepMs > 0) {
    // p5-ops-chat: turns without news are failed (the worker or the model went silent).
    const timer = setInterval(() => {
      gated('chat-turns', () => app.chat.sweep()).catch((err: unknown) => {
        app.log.warn({ err }, 'chat turn sweep failed');
      });
    }, chatSweepMs);
    timer.unref();
    app.addHook('onClose', () => {
      clearInterval(timer);
      return Promise.resolve();
    });
  }
  if (lc.sweepIntervalMs !== undefined && lc.sweepIntervalMs > 0) {
    // p5-live retention: live rows of jobs that ended `retentionDays` ago.
    const store = app.live.store;
    const timer = setInterval(() => {
      gated('live-retention', () => store.purge(clock(), { retentionDays: lc.retentionDays ?? 30 })).catch(
        (err: unknown) => {
          app.log.error({ err }, 'live retention sweep failed');
        },
      );
    }, lc.sweepIntervalMs);
    timer.unref();
    app.addHook('onClose', () => {
      clearInterval(timer);
      return Promise.resolve();
    });
  }
  if (forwarder !== null) {
    // Position the cursor now: only transitions after start-up are forwarded.
    await forwarder.collect();
    const every = am?.intervalMs ?? 0;
    if (every > 0) {
      const stop = forwarder.start(every);
      app.addHook('onClose', stop);
    }
  }
  const alertEvery = deps.alerts?.intervalMs ?? 0;
  if (alertEvery > 0) {
    const stop = app.alerts.start(
      alertEvery,
      gatedError('alerts', (err) => {
        app.log.error({ err }, 'alert evaluation failed');
      }),
    );
    app.addHook('onClose', () => {
      stop();
      return Promise.resolve();
    });
  }
  const metricsEvery = deps.metricsTailIntervalMs ?? 5_000;
  if (app.metrics !== null && metricsEvery > 0) {
    const stop = app.metrics.start(
      metricsEvery,
      gatedError('metrics-tail', (err) => {
        app.log.warn({ err }, 'metrics transition tailer failed');
      }),
    );
    app.addHook('onClose', () => {
      stop();
      return Promise.resolve();
    });
  }
  if (deps.approvalSweepIntervalMs !== undefined && deps.approvalSweepIntervalMs > 0) {
    const stop = approvals.startSweeper(
      deps.approvalSweepIntervalMs,
      gatedError('approvals', (err) => {
        app.log.error({ err }, 'approval sweep failed');
      }),
    );
    app.addHook('onClose', () => {
      stop();
      return Promise.resolve();
    });
  }
  if (nd.intervalMs !== undefined && nd.intervalMs > 0) {
    const stop = app.notifications.start(
      nd.intervalMs,
      gatedError('notifications', (err) => {
        app.log.error({ err }, 'notification pass failed');
      }),
    );
    app.addHook('onClose', () => {
      stop();
      return Promise.resolve();
    });
  }
  if (deps.search?.intervalMs !== undefined && deps.search.intervalMs > 0) {
    // p6-vector: receipts → deletions, then (re)index consented sources. p10-bedrock-integration-panel: the loop runs
    // without an env provider too (the panel can turn one on); each pass first re-reads the panel row.
    const stop = search.startIndexer(
      deps.search.intervalMs,
      gatedError('search-indexer', (err) => {
        app.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'search indexer pass failed');
      }),
      () => bedrock.refresh(),
    );
    app.addHook('onClose', () => {
      stop();
      return Promise.resolve();
    });
    // p10-semantic-defaults-chat: chat links and vectors on the same cadence.
    const stopChat = chatKnowledge.start(
      deps.search.intervalMs,
      gatedError('chat-knowledge', (err) => {
        app.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'chat knowledge pass failed');
      }),
    );
    // p17-embeddings: work vectors (job cards, failures, automations), at most PASS_LIMIT per kind per pass.
    let relatedBusy = false;
    const relatedTimer = setInterval(() => {
      if (relatedBusy) return;
      relatedBusy = true;
      gated('related-work', () => relatedWork.sync())
        .catch((err: unknown) => {
          app.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'related work pass failed');
        })
        .finally(() => {
          relatedBusy = false;
        });
    }, deps.search.intervalMs);
    relatedTimer.unref();
    app.addHook('onClose', () => {
      stopChat();
      clearInterval(relatedTimer);
      return Promise.resolve();
    });
  }
  const msInterval = deps.memorySuggestions?.intervalMs;
  if (msInterval !== undefined && msInterval > 0) {
    // p10-semantic-memory: propose learnings from jobs of opted-in projects that succeeded.
    const stop = memorySuggestions.startPoller(
      msInterval,
      gatedError('memory-suggestions', (err) => {
        app.log.error(
          { errName: err instanceof Error ? err.name : 'error' },
          'memory suggestion pass failed',
        );
      }),
    );
    // p11-memory-layers: expiry dates and review-by reminders of memory records (same cadence).
    const stopSweep = memoryRecords.startSweeper(
      msInterval,
      gatedError('memory-records', (err) => {
        app.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'memory record sweep failed');
      }),
    );
    app.addHook('onClose', () => {
      stop();
      stopSweep();
      return Promise.resolve();
    });
  }
  if (deps.contextPurgeIntervalMs !== undefined && deps.contextPurgeIntervalMs > 0) {
    // p6-context-policy: the full retention sweep (expire → prune → purge, honouring legal holds).
    const stop = contextPolicy.startSweeper(
      deps.contextPurgeIntervalMs,
      gatedError('context-retention', (err) => {
        app.log.error({ err }, 'context retention sweep failed');
      }),
    );
    app.addHook('onClose', () => {
      stop();
      return Promise.resolve();
    });
  }
  const doctorEvery = dd.intervalMs ?? 0;
  if (doctorEvery > 0) {
    // p16-doctor: the daily light run when it is due (at most one per day across masters).
    const stop = doctor.start(
      doctorEvery,
      gatedError('doctor', (err) => {
        app.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'daily diagnostics failed');
      }),
    );
    app.addHook('onClose', () => {
      stop();
      return Promise.resolve();
    });
  }
  const woEvery = wo.intervalMs ?? 0;
  if (woEvery > 0) {
    // p16-webhooks-out: audit cursor → deliveries, then due deliveries (one pass at a time per master).
    const stop = webhooksOut.start(
      woEvery,
      gatedError('webhooks-out', (err) => {
        app.log.error({ errName: err instanceof Error ? err.name : 'error' }, 'webhook pass failed');
      }),
    );
    app.addHook('onClose', () => {
      stop();
      return Promise.resolve();
    });
  }
  const osEvery = osd.intervalMs ?? 0;
  if (osEvery > 0) {
    // p16-ops-safety: expiry checks + threshold notices, cost brake crossings, the rollout breaker (one pass at a time).
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      busy = true;
      void (async () => {
        await gated('ops-safety-expiry', () => expiry.tick()).catch((err: unknown) => {
          app.log.error({ err }, 'expiry pass failed');
        });
        await gated('ops-safety-cost-brake', () => costBrake.sweep()).catch((err: unknown) => {
          app.log.error({ err }, 'cost brake pass failed');
        });
        const breaker = rolloutBreaker;
        if (breaker !== null) {
          await gated('ops-safety-rollout-breaker', () => breaker.evaluate()).catch((err: unknown) => {
            app.log.error({ err }, 'rollout breaker pass failed');
          });
        }
      })().finally(() => {
        busy = false;
      });
    }, osEvery);
    timer.unref();
    app.addHook('onClose', () => {
      clearInterval(timer);
      return Promise.resolve();
    });
  }
  // p5-github-connect: load the panel-connected GitHub App (decrypts its key into the live map).
  if (githubConnect === null) throw new Error('github connect not initialised');
  await githubConnect.load();
  return app;
}

/** p16-observability: `Telemetry.span` as the orchestrator's `traceSpan` (the span is not passed to the callback). */
function telemetrySpan(
  t: Telemetry,
): <T>(name: string, attributes: Record<string, string>, fn: () => Promise<T>) => Promise<T> {
  return (name, attributes, fn) => t.span(name, attributes, () => fn());
}
