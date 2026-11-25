import type { ZodTypeProvider } from '@fastify/type-provider-zod';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AuditRecorder } from '../audit/audit.js';
import { requireStepUp } from '../auth/hooks.js';
import type { Pool } from '../db/pool.js';
import { ErrorBodySchema } from '../http/error-schema.js';
import { HttpError } from '../http/errors.js';
import type { PanelSkillsKey } from '../skills/panel-key.js';
import { actorOf } from '../workers/routes.js';
import { listOf } from './consumers.js';
import type { PanelActor, PanelSettingsService } from './service.js';

/**
 * p17-panel-settings Part 5 (docs/design/p17-panel-settings.md §7): key rotation from the panel where it is safe.
 *
 * | Key | From the panel | Why / how |
 * | --- | --- | --- |
 * | Webhook HMAC | yes, two steps | `prepare` makes the next secret (shown once); notifications carry a second signature (`X-Remyral-Signature-Next`) so receivers switch first; `activate` makes it the key; `cancel` drops it |
 * | Skills panel key | yes | a new Ed25519 key generated in the master (sealed); the previous public key stays trusted ("retired") so published skills keep verifying; the machines get both through their signed managed configuration; `retire` drops the old one |
 * | Lease-signing key | no — host procedure | it is the host applier's trust root (remyral-ctl verifies requests with the public half of the key **file**), workers may pin it locally (`masterLeaseKeys`, not managed config) and the update helper / machine admin verify with the pin; a master-made key would break both, and letting the master write the key file would let it replace the host's trust root |
 * | Master key (TOTP_KEY_FILE) | no — host procedure | it is the root of every sealed value (authenticator secrets, panel secrets, integration tokens) and of the HMAC peppers of recovery codes and API tokens (which cannot be re-derived); a rotation is an offline maintenance with a re-enrolment, never a button |
 *
 * Every step has a dry run (`GET /panel-settings/keys/:item/dry-run?action=`) and is audited
 * (`keys.webhook-hmac.<action>`, `keys.skills-panel.<action>`).
 */

const WEBHOOK = 'webhookHmac';
const SKILLS = 'skillsPanel';
const ITEMS = ['webhookHmac', 'skillsPanel', 'leaseSigning', 'totp'] as const;
type Item = (typeof ITEMS)[number];
/** Audit actions are lower-case (`keys.webhook-hmac.prepare`). */
const AUDIT_SLUG: Readonly<Record<Item, string>> = {
  webhookHmac: 'webhook-hmac',
  skillsPanel: 'skills-panel',
  leaseSigning: 'lease-signing',
  totp: 'totp',
};
const ACTIONS: Readonly<Record<Item, readonly string[]>> = {
  webhookHmac: ['prepare', 'activate', 'cancel'],
  skillsPanel: ['rotate', 'retire'],
  leaseSigning: [],
  totp: [],
};

export interface KeyItemView {
  readonly item: Item;
  readonly online: boolean;
  /** Where the key in effect comes from: panel / env (file) / none. */
  readonly source: 'panel' | 'env' | 'none';
  readonly keyId: string | null;
  readonly publicKey: string | null;
  readonly pending: boolean;
  readonly retired: readonly string[];
  readonly actions: readonly string[];
  /** The exact host procedure when it is not rotated from the panel. */
  readonly procedure: readonly string[];
}

/** The host procedure of the lease-signing key (docs/ops/deploy-coolify.md §3.1, docs/ops/selfhost-install.md). */
export const LEASE_PROCEDURE: readonly string[] = [
  '# 1. Machines that pin the key locally (config.json masterLeaseKeys): add the NEW public key next to the old one first.',
  "sudo sh -c 'umask 077; openssl genpkey -algorithm ed25519 -out /var/lib/remyral/secrets/lease-signing.pem.new'",
  'openssl pkey -in /var/lib/remyral/secrets/lease-signing.pem.new -pubout -outform DER | tail -c 32 | base64 | tr "+/" "-_" | tr -d "="',
  '# 2. Swap the file (keep the old one until every machine reconnected), restart the master:',
  'sudo cp -p /var/lib/remyral/secrets/lease-signing.pem /var/lib/remyral/secrets/lease-signing.pem.old',
  'sudo mv /var/lib/remyral/secrets/lease-signing.pem.new /var/lib/remyral/secrets/lease-signing.pem',
  'sudo chown 10001:10001 /var/lib/remyral/secrets/lease-signing.pem && sudo chmod 0400 /var/lib/remyral/secrets/lease-signing.pem',
  'sudo docker compose -p remyral-prod restart master   # Coolify: redeploy the master',
  '# 3. Machines reconnect and get the new key; running jobs renew their lease with it. Then record the rotation:',
  'docker exec $(docker ps -qf label=com.docker.compose.service=master) remyral-master secrets:rotated file:lease-key',
  '# 4. Remove the old key from pinned machines and delete lease-signing.pem.old.',
];

/** Why the master key is not rotated online and what the operator does instead. */
export const TOTP_PROCEDURE: readonly string[] = [
  '# The master key (TOTP_KEY_FILE) is not rotated in place: authenticator secrets and every panel secret are sealed',
  '# with it and recovery codes / API tokens are hashed with keys derived from it (those hashes cannot be re-made).',
  '# Keep it backed up off the server (password manager). If it may have leaked:',
  '# 1. Take a backup, then generate a new key and swap it with the master stopped:',
  "sudo sh -c 'umask 077; head -c 32 /dev/urandom | base64 > /var/lib/remyral/secrets/totp.key.new'",
  '# 2. Every user re-enrols the authenticator (Settings → Users → Reset the authenticator, or admin:reset --reset-mfa),',
  '#    API tokens are issued again and every panel secret (integrations, SMTP, webhook / push keys) is entered again.',
  'docker exec $(docker ps -qf label=com.docker.compose.service=master) remyral-master secrets:rotated file:totp-key',
];

export class KeyRotationService {
  constructor(
    private readonly deps: {
      readonly pool: Pool;
      readonly audit: AuditRecorder;
      readonly settings: PanelSettingsService;
      readonly panelKey: () => PanelSkillsKey | null;
      readonly leaseKeyId: () => string;
      readonly managedWorkers: () => Promise<number>;
    },
  ) {}

  items(): KeyItemView[] {
    const s = this.deps.settings;
    const pk = this.deps.panelKey();
    const webhookSource = s.secretSource('notify.webhook.secret');
    return [
      {
        item: WEBHOOK,
        online: true,
        source: webhookSource ?? 'none',
        keyId: null,
        publicKey: null,
        pending: s.secretSource('notify.webhook.nextSecret') === 'panel',
        retired: [],
        actions: ACTIONS.webhookHmac,
        procedure: [],
      },
      {
        item: SKILLS,
        online: true,
        source: pk === null ? 'none' : s.secretSource('skills.panelKey') === 'panel' ? 'panel' : 'env',
        keyId: pk?.keyId ?? null,
        publicKey: pk?.publicKey ?? null,
        pending: false,
        retired: listOf(s, 'skills.panelKeyRetired'),
        actions: ACTIONS.skillsPanel,
        procedure: [],
      },
      {
        item: 'leaseSigning',
        online: false,
        source: 'env',
        keyId: this.deps.leaseKeyId(),
        publicKey: null,
        pending: false,
        retired: [],
        actions: [],
        procedure: LEASE_PROCEDURE,
      },
      {
        item: 'totp',
        online: false,
        source: 'env',
        keyId: null,
        publicKey: null,
        pending: false,
        retired: [],
        actions: [],
        procedure: TOTP_PROCEDURE,
      },
    ];
  }

  #check(item: string, action: string): Item {
    if (!(ITEMS as readonly string[]).includes(item)) throw new HttpError(404, 'not_found', 'Not found.');
    const i = item as Item;
    if (!ACTIONS[i].includes(action)) {
      throw new HttpError(
        409,
        'key_rotation_offline',
        'This key is rotated on the server (see the procedure).',
      );
    }
    return i;
  }

  /** What an action would change (nothing is written). */
  async dryRun(item: string, action: string): Promise<{ effect: string[] }> {
    const i = this.#check(item, action);
    const s = this.deps.settings;
    if (i === WEBHOOK) {
      const { rows } = await this.deps.pool.query<{ n: number }>(
        `SELECT count(DISTINCT t.user_id)::int AS n FROM notification_targets t
           JOIN notification_preferences p ON p.user_id = t.user_id AND p.channel = 'webhook' AND p.enabled
          WHERE t.webhook_url IS NOT NULL`,
      );
      const receivers = rows[0]?.n ?? 0;
      const pending = s.secretSource('notify.webhook.nextSecret') === 'panel';
      if (action === 'prepare')
        return {
          effect: [
            `A new signing key is generated and shown once; the current key keeps signing (X-Remyral-Signature).`,
            `Until you activate it, every webhook also carries X-Remyral-Signature-Next with the new key (${String(receivers)} receiver(s) with webhooks on).`,
            ...(pending ? ['The key prepared earlier is replaced.'] : []),
          ],
        };
      if (action === 'activate') {
        if (!pending) throw new HttpError(409, 'key_rotation_not_prepared', 'Prepare a new key first.');
        return {
          effect: [
            `The prepared key becomes the signing key at once; receivers that still check only the old key fail (${String(receivers)} receiver(s)).`,
          ],
        };
      }
      return {
        effect: [pending ? 'The prepared key is dropped; nothing else changes.' : 'Nothing is prepared.'],
      };
    }
    // skillsPanel
    const pk = this.deps.panelKey();
    const ids = [pk?.keyId, ...listOf(s, 'skills.panelKeyRetired')].filter((x): x is string => x != null);
    const { rows } = await this.deps.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM skill_versions WHERE signer = 'panel'",
    );
    const machines = await this.deps.managedWorkers();
    if (action === 'rotate')
      return {
        effect: [
          'A new Ed25519 panel key is generated in the master and signs every new chat-authored skill and MCP spec.',
          pk === null
            ? 'There is no panel key yet: this is the first one.'
            : `The current key (${pk.keyId}) stays trusted as a retired key: the ${String(rows[0]?.n ?? 0)} panel-signed skill version(s) keep verifying.`,
          `${String(machines)} managed machine(s) receive a new signed configuration with the key(s).`,
        ],
      };
    const retired = listOf(s, 'skills.panelKeyRetired');
    return {
      effect: [
        retired.length === 0
          ? 'No retired key is trusted; nothing changes.'
          : `${String(retired.length)} retired key(s) stop being trusted: skills and MCP specs signed only with them no longer reach jobs (${String(ids.length)} panel key id(s) known).`,
        `${String(machines)} managed machine(s) receive a new signed configuration.`,
      ],
    };
  }

  async apply(
    actor: PanelActor,
    item: string,
    action: string,
  ): Promise<{ readonly secret: string | null; readonly publicKey: string | null }> {
    const i = this.#check(item, action);
    const s = this.deps.settings;
    let secret: string | null = null;
    let publicKey: string | null = null;
    if (i === WEBHOOK) {
      if (action === 'prepare') {
        const out = await s.update(actor, 'keys', { generate: ['notify.webhook.nextSecret'] });
        secret = out.generated['notify.webhook.nextSecret'] ?? null;
      } else if (action === 'activate') {
        const next = s.secret('notify.webhook.nextSecret');
        if (next === null || s.secretSource('notify.webhook.nextSecret') !== 'panel') {
          throw new HttpError(409, 'key_rotation_not_prepared', 'Prepare a new key first.');
        }
        await s.update(actor, 'notifications', { secrets: { 'notify.webhook.secret': next } });
        await s.update(actor, 'keys', { secrets: { 'notify.webhook.nextSecret': null } });
      } else {
        await s.update(actor, 'keys', { secrets: { 'notify.webhook.nextSecret': null } });
      }
    } else if (action === 'rotate') {
      const old = this.deps.panelKey();
      const retired = listOf(s, 'skills.panelKeyRetired');
      const keep = old === null ? retired : [old.publicKey, ...retired.filter((k) => k !== old.publicKey)];
      if (keep.length > 4) {
        throw new HttpError(
          409,
          'key_rotation_too_many',
          'Retire the earlier panel keys before rotating again (at most four stay trusted).',
        );
      }
      const out = await s.update(actor, 'keys', {
        generate: ['skills.panelKey'],
        values: { 'skills.panelKeyRetired': keep },
      });
      publicKey = out.generated['skills.panelKey'] ?? null;
    } else {
      await s.update(actor, 'keys', { values: { 'skills.panelKeyRetired': null } });
    }
    await this.deps.audit.record({
      actor: { type: 'user', id: actor.userId },
      ip: actor.ip ?? null,
      userAgent: actor.userAgent ?? null,
      action: `keys.${AUDIT_SLUG[i]}.${action}`,
      target: `key:${i}`,
      outcome: 'success',
      metadata: { item: i, action, ...(publicKey === null ? {} : { publicKey }) },
    });
    return { secret, publicKey };
  }
}

const ItemBody = z.object({
  item: z.enum(ITEMS),
  online: z.boolean(),
  source: z.enum(['panel', 'env', 'none']),
  keyId: z.string().nullable(),
  publicKey: z.string().nullable(),
  pending: z.boolean(),
  retired: z.array(z.string()),
  actions: z.array(z.string()),
  procedure: z.array(z.string()),
});

export function keyRoutes(deps: { readonly service: KeyRotationService; readonly clock: () => Date }) {
  return (app: FastifyInstance): void => {
    const r = app.withTypeProvider<ZodTypeProvider>();
    const errors = {
      400: ErrorBodySchema,
      401: ErrorBodySchema,
      403: ErrorBodySchema,
      404: ErrorBodySchema,
      409: ErrorBodySchema,
    };
    const fresh = requireStepUp('always-fresh', deps.clock);
    r.get(
      '/panel-settings/keys',
      {
        config: { authz: { action: 'settings.panel.read' as const } },
        schema: {
          tags: ['panel-settings'],
          summary: 'The keys the panel can rotate and the ones rotated on the server (with the procedure)',
          security: [{ session: [] }],
          response: { 200: z.object({ items: z.array(ItemBody) }), ...errors },
        },
      },
      () => ({
        items: deps.service.items().map((i) => ({
          ...i,
          retired: [...i.retired],
          actions: [...i.actions],
          procedure: [...i.procedure],
        })),
      }),
    );
    r.get(
      '/panel-settings/keys/:item/dry-run',
      {
        config: { authz: { action: 'keys.rotate' as const } },
        schema: {
          tags: ['panel-settings'],
          summary: 'What a key rotation step would change (nothing is written)',
          security: [{ session: [] }],
          params: z.object({ item: z.string().max(32) }),
          querystring: z.object({ action: z.string().max(32) }),
          response: { 200: z.object({ effect: z.array(z.string()) }), ...errors },
        },
      },
      async (request) => deps.service.dryRun(request.params.item, request.query.action),
    );
    r.post(
      '/panel-settings/keys/:item/:action',
      {
        config: { authz: { action: 'keys.rotate' as const } },
        preHandler: fresh,
        schema: {
          tags: ['panel-settings'],
          summary:
            'A key rotation step (owners, always-fresh step-up, audited): a prepared webhook key is returned once',
          security: [{ session: [], csrf: [] }],
          params: z.object({ item: z.string().max(32), action: z.string().max(32) }),
          response: {
            200: z.object({ secret: z.string().nullable(), publicKey: z.string().nullable() }),
            ...errors,
          },
        },
      },
      async (request) => {
        const a = actorOf(request);
        return deps.service.apply(
          { userId: a.userId, ip: a.ip, userAgent: a.userAgent },
          request.params.item,
          request.params.action,
        );
      },
    );
  };
}
