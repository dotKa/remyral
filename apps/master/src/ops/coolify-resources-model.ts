import { z } from 'zod';
import {
  CoolifyEnvChange,
  CoolifyUuid,
  DomainUrl,
  HealthCheck,
  LimitsCpus,
  LimitsMemory,
} from './coolify-apps-model.js';

/**
 * p17-coolify-full (docs/design/p17-coolify-full.md §5): the inputs of the Coolify-wide operations — storages,
 * start / stop / restart, databases (+ backups), services, projects and environments. Shared by the console routes and
 * the assistant's coolify_* tools; every field maps to a documented Coolify API field.
 */

export const RESOURCE_KINDS = ['application', 'database', 'service'] as const;
export const ResourceKind = z.enum(RESOURCE_KINDS);

/** An absolute container / host path (no `..`, no spaces or shell characters). */
export const AbsPath = z
  .string()
  .max(500)
  .regex(/^\/[A-Za-z0-9._@+/-]*$/, 'an absolute path (/data)')
  .refine((p) => !p.split('/').includes('..'), 'no ..')
  .transform((p) => (p.length > 1 ? p.replace(/\/+$/, '') : p));

/** Coolify's VOLUME_NAME_PATTERN (letters, digits, `_ . -`, starting with a letter or digit). */
export const VolumeName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/, 'volume name: a-z, 0-9, _ . -');

/** The resource name the user types to confirm a deletion (compared with Coolify's name, trimmed). */
const Confirm = z.string().trim().min(1).max(300);

/** Add a storage: a Docker volume, a file Coolify writes, or a host directory. */
export const StorageAddInput = z.discriminatedUnion('mount', [
  z.strictObject({
    mount: z.literal('volume'),
    name: VolumeName,
    mountPath: AbsPath,
    /** A host directory for the volume: a `host_path` on Coolify ≤ 4.2, a directory mount on 4.3+. */
    hostPath: AbsPath.optional(),
    /** Services: the sub-application / sub-database (from the service's details). */
    resourceUuid: CoolifyUuid.optional(),
    deploy: z.boolean().default(false),
  }),
  z.strictObject({
    mount: z.literal('file'),
    mountPath: AbsPath,
    /** File content (config files; never stored or audited by Remyral). */
    content: z
      .string()
      .max(256 * 1024)
      .optional(),
    hostPath: AbsPath.optional(),
    resourceUuid: CoolifyUuid.optional(),
    deploy: z.boolean().default(false),
  }),
  z.strictObject({
    mount: z.literal('directory'),
    mountPath: AbsPath,
    hostPath: AbsPath,
    resourceUuid: CoolifyUuid.optional(),
    deploy: z.boolean().default(false),
  }),
]);
export type StorageAddInput = z.infer<typeof StorageAddInput>;

export const StorageUpdateInput = z
  .strictObject({
    name: VolumeName.optional(),
    mountPath: AbsPath.optional(),
    hostPath: AbsPath.nullable().optional(),
    content: z
      .string()
      .max(256 * 1024)
      .optional(),
    deploy: z.boolean().default(false),
  })
  .refine((u) => Object.keys(u).some((k) => k !== 'deploy'), { message: 'nothing to change' });
export type StorageUpdateInput = z.infer<typeof StorageUpdateInput>;

export const StorageRemoveInput = z.strictObject({
  /** The volume name or the mount path, as the user confirmed it. */
  confirm: Confirm,
  deploy: z.boolean().default(false),
});
export type StorageRemoveInput = z.infer<typeof StorageRemoveInput>;

export const LifecycleInput = z.strictObject({
  action: z.enum(['start', 'stop', 'restart']),
  /** Services: pull the latest images on restart. */
  latest: z.boolean().optional(),
});
export type LifecycleInput = z.infer<typeof LifecycleInput>;

/** Deleting a database, service, project or environment: the name typed by the user; volumes kept by default. */
export const ResourceDeleteInput = z.strictObject({
  confirm: Confirm,
  deleteVolumes: z.boolean().default(false),
  deleteConfigurations: z.boolean().default(true),
  dockerCleanup: z.boolean().default(true),
  deleteConnectedNetworks: z.boolean().default(true),
});
export type ResourceDeleteInput = z.infer<typeof ResourceDeleteInput>;

export const DB_ENGINES = [
  'postgresql',
  'mysql',
  'mariadb',
  'mongodb',
  'redis',
  'keydb',
  'dragonfly',
  'clickhouse',
] as const;
export const DbEngine = z.enum(DB_ENGINES);
export type DbEngine = z.infer<typeof DbEngine>;

const Name = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$/, 'name: letters, digits, space . _ -');
const DbIdent = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,62}$/, 'letters, digits, _');
const Image = z.string().regex(/^[a-z0-9][a-z0-9._/:@-]{0,254}$/, 'image (postgres:17-alpine)');
const Password = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[\x21-\x7e]+$/, 'printable, no spaces');

/** Where a new database / service goes (the same pickers as a new application). */
const Place = {
  connection: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
    .optional(),
  server: CoolifyUuid,
  coolifyProject: CoolifyUuid,
  environment: z.string().trim().min(1).max(100),
  destination: CoolifyUuid.optional(),
};

export const DatabaseCreateInput = z.strictObject({
  engine: DbEngine,
  ...Place,
  name: Name.optional(),
  description: z.string().max(500).optional(),
  image: Image.optional(),
  /** postgres_user / mysql_user / mariadb_user / mongo_initdb_root_username / clickhouse_admin_user. */
  user: DbIdent.optional(),
  /** postgres_db / mysql_database / mariadb_database / mongo_initdb_database. */
  database: DbIdent.optional(),
  /**
   * The engine's password (panel only — the assistant never passes one). Sent to Coolify in the same request and never
   * stored, logged or audited. Absent: Coolify generates one.
   */
  password: Password.optional(),
  isPublic: z.boolean().optional(),
  publicPort: z.number().int().min(1024).max(65535).optional(),
  limitsMemory: LimitsMemory.optional(),
  limitsCpus: LimitsCpus.optional(),
  instantDeploy: z.boolean().default(false),
});
export type DatabaseCreateInput = z.infer<typeof DatabaseCreateInput>;

export const DatabaseUpdateInput = z
  .strictObject({
    name: Name.optional(),
    description: z.string().max(500).optional(),
    image: Image.optional(),
    isPublic: z.boolean().optional(),
    publicPort: z.number().int().min(1024).max(65535).optional(),
    limitsMemory: LimitsMemory.optional(),
    limitsCpus: LimitsCpus.optional(),
    healthCheck: HealthCheck.pick({
      enabled: true,
      interval: true,
      timeout: true,
      retries: true,
      startPeriod: true,
    }).optional(),
  })
  .refine((u) => Object.keys(u).length > 0, { message: 'nothing to change' });
export type DatabaseUpdateInput = z.infer<typeof DatabaseUpdateInput>;

/** Cron (5 fields) or Coolify's keywords. */
const Frequency = z
  .string()
  .trim()
  .regex(
    /^(every_minute|hourly|daily|weekly|monthly|yearly|[0-9*/,-]+( [0-9*/,-]+){4})$/,
    'cron (0 3 * * *) or hourly / daily / weekly / monthly',
  );

export const BackupCreateInput = z.strictObject({
  frequency: Frequency,
  enabled: z.boolean().default(true),
  saveS3: z.boolean().optional(),
  s3StorageUuid: CoolifyUuid.optional(),
  databases: z
    .string()
    .regex(/^[A-Za-z0-9_,-]{1,500}$/)
    .optional(),
  dumpAll: z.boolean().optional(),
  retentionAmount: z.number().int().min(0).max(1000).optional(),
  retentionDays: z.number().int().min(0).max(3650).optional(),
  backupNow: z.boolean().optional(),
});
export type BackupCreateInput = z.infer<typeof BackupCreateInput>;

export const BackupUpdateInput = z
  .strictObject({
    frequency: Frequency.optional(),
    enabled: z.boolean().optional(),
    saveS3: z.boolean().optional(),
    s3StorageUuid: CoolifyUuid.optional(),
    databases: z
      .string()
      .regex(/^[A-Za-z0-9_,-]{1,500}$/)
      .optional(),
    dumpAll: z.boolean().optional(),
    retentionAmount: z.number().int().min(0).max(1000).optional(),
    retentionDays: z.number().int().min(0).max(3650).optional(),
    backupNow: z.boolean().optional(),
  })
  .refine((u) => Object.keys(u).length > 0, { message: 'nothing to change' });
export type BackupUpdateInput = z.infer<typeof BackupUpdateInput>;

const ServiceUrls = z
  .array(
    z.strictObject({
      name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/),
      url: DomainUrl,
    }),
  )
  .max(20);

export const ServiceCreateInput = z
  .strictObject({
    /** A one-click template id (`n8n`, `uptime-kuma`, `plausible` …) — Coolify's service template names. */
    type: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,63}$/)
      .optional(),
    /** Raw Docker Compose (panel only — never from the assistant); base64-encoded for Coolify by the master. */
    compose: z
      .string()
      .min(1)
      .max(128 * 1024)
      .optional(),
    ...Place,
    name: Name.optional(),
    description: z.string().max(500).optional(),
    urls: ServiceUrls.optional(),
    instantDeploy: z.boolean().default(false),
  })
  .refine((s) => (s.type === undefined) !== (s.compose === undefined), {
    message: 'exactly one of type (a one-click template) or compose',
  });
export type ServiceCreateInput = z.infer<typeof ServiceCreateInput>;

export const ServiceUpdateInput = z
  .strictObject({
    name: Name.optional(),
    description: z.string().max(500).optional(),
    urls: ServiceUrls.optional(),
  })
  .refine((u) => Object.keys(u).length > 0, { message: 'nothing to change' });
export type ServiceUpdateInput = z.infer<typeof ServiceUpdateInput>;

export const ServiceEnvsInput = z.strictObject({
  changes: z.array(CoolifyEnvChange).min(1).max(100),
  /** Restart the service afterwards (variables take effect on the next start). */
  restart: z.boolean().default(false),
});
export type ServiceEnvsInput = z.infer<typeof ServiceEnvsInput>;

export const ProjectCreateInput = z.strictObject({
  name: Name,
  description: z.string().max(500).optional(),
});
export const EnvironmentCreateInput = z.strictObject({
  name: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/, 'environment name: a-z, 0-9, _ . -'),
});
export const NameConfirmInput = z.strictObject({ confirm: Confirm });

export const ResourceLogsQuery = z.strictObject({
  lines: z.number().int().min(10).max(2000).default(200),
  /** Services: the sub-application / sub-database name. */
  sub: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/)
    .optional(),
});
export type ResourceLogsQuery = z.infer<typeof ResourceLogsQuery>;
