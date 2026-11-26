import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../src/config.js';

const base = {
  DATABASE_URL: 'postgres://u:pw@127.0.0.1:5432/db',
  REDIS_URL: 'redis://:pw@127.0.0.1:6379/0',
  TOTP_KEY_FILE: '/abs/totp.key',
};

describe('loadConfig', () => {
  it('p6-deploy-integrations: OPS_* lists (empty by default; internal origins must be bare origins)', () => {
    expect(loadConfig(base, '/cwd').ops).toEqual({
      internalOrigins: [],
      controlPlaneResources: [],
      controlPlaneAddresses: [],
      protectedHosts: [],
    });
    const c = loadConfig(
      {
        ...base,
        OPS_INTERNAL_ORIGINS: 'http://coolify:8080, https://c.internal',
        OPS_CONTROL_PLANE_COOLIFY_UUIDS: 'abc123def, xyz789uvw',
        OPS_CONTROL_PLANE_ADDRESSES: '203.0.113.10',
        OPS_PROTECTED_HOSTS: 'Console-Old.example.com, panel.example.com',
      },
      '/cwd',
    ).ops;
    expect(c).toEqual({
      internalOrigins: ['http://coolify:8080', 'https://c.internal'],
      controlPlaneResources: ['abc123def', 'xyz789uvw'],
      controlPlaneAddresses: ['203.0.113.10'],
      protectedHosts: ['console-old.example.com', 'panel.example.com'],
    });
    expect(() => loadConfig({ ...base, OPS_INTERNAL_ORIGINS: 'http://coolify:8080/api' }, '/cwd')).toThrow(
      ConfigError,
    );
    expect(() => loadConfig({ ...base, OPS_PROTECTED_HOSTS: 'https://panel.example.com/' }, '/cwd')).toThrow(
      ConfigError,
    );
  });
  it('p6-agentmagnify: disabled by default; URL + token file together; https or loopback http only', () => {
    expect(loadConfig(base, '/cwd').agentmagnify).toBeNull();
    expect(
      loadConfig(
        { ...base, AGENTMAGNIFY_API_URL: 'https://am.example', AGENTMAGNIFY_TOKEN_FILE: 'secrets/am-token' },
        '/cwd',
      ).agentmagnify,
    ).toEqual({
      apiUrl: 'https://am.example',
      tokenFile: '/cwd/secrets/am-token',
      projectName: null,
      intervalMs: 10_000,
    });
    expect(() => loadConfig({ ...base, AGENTMAGNIFY_API_URL: 'https://am.example' }, '/cwd')).toThrow(
      ConfigError,
    );
    expect(() =>
      loadConfig(
        { ...base, AGENTMAGNIFY_API_URL: 'http://am.example', AGENTMAGNIFY_TOKEN_FILE: '/t' },
        '/cwd',
      ),
    ).toThrow(ConfigError);
  });

  it('p6-otel: OTLP off and /metrics on loopback by default; endpoint and headers file opt in', () => {
    expect(loadConfig(base, '/cwd').telemetry).toEqual({
      serviceName: 'remyral-master',
      environment: null,
      otlp: null,
      metrics: { host: '127.0.0.1', port: 9464, tokenFile: null },
    });
    const c = loadConfig(
      {
        ...base,
        OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318',
        OTEL_EXPORTER_OTLP_HEADERS_FILE: 'secrets/otlp-headers',
        METRICS_ENABLED: 'false',
        REMYRAL_ENV: 'prod',
      },
      '/cwd',
    );
    expect(c.telemetry).toMatchObject({
      environment: 'prod',
      otlp: { endpoint: 'http://otel-collector:4318', headersFile: '/cwd/secrets/otlp-headers' },
      metrics: null,
    });
    expect(() =>
      loadConfig({ ...base, OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318/?key=x' }, '/cwd'),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, OTEL_EXPORTER_OTLP_HEADERS_FILE: '/h' }, '/cwd')).toThrow(ConfigError);
  });

  it('/metrics on a non-loopback address needs a bearer token file (never unauthenticated off loopback)', () => {
    for (const host of ['0.0.0.0', '::', '10.0.0.5', 'master']) {
      expect(() => loadConfig({ ...base, METRICS_HOST: host }, '/cwd'), host).toThrow(/METRICS_TOKEN_FILE/);
      expect(
        loadConfig({ ...base, METRICS_HOST: host, METRICS_TOKEN_FILE: '/run/t' }, '/cwd').telemetry.metrics,
      ).toEqual({ host, port: 9464, tokenFile: '/run/t' });
      expect(
        loadConfig({ ...base, METRICS_HOST: host, METRICS_ENABLED: 'false' }, '/cwd').telemetry.metrics,
      ).toBe(null);
    }
    for (const host of ['127.0.0.1', '127.0.0.53', '::1', '[::1]', 'localhost', 'LOCALHOST']) {
      expect(
        loadConfig({ ...base, METRICS_HOST: host }, '/cwd').telemetry.metrics?.tokenFile,
        host,
      ).toBeNull();
    }
  });

  it('applies defaults', () => {
    const c = loadConfig(base, '/cwd');
    expect(c).toMatchObject({
      nodeEnv: 'development',
      host: '127.0.0.1',
      port: 8080,
      logLevel: 'info',
      trustProxyHops: 0,
      bodyLimitBytes: 65536,
      totpKeyFile: '/abs/totp.key',
    });
  });

  it('p5-worker-onboarding: PUBLIC_ORIGIN (https origin, else NOTIFY_PUBLIC_URL origin), public downloads', () => {
    expect(loadConfig(base, '/cwd').installers).toEqual({ publicOrigin: null, publicDownloads: true });
    expect(
      loadConfig({ ...base, NOTIFY_PUBLIC_URL: 'https://r.example.com/console' }, '/cwd').installers
        .publicOrigin,
    ).toBe('https://r.example.com');
    expect(
      loadConfig(
        { ...base, PUBLIC_ORIGIN: 'https://w.example.com', INSTALLER_PUBLIC_DOWNLOADS: 'false' },
        '/cwd',
      ).installers,
    ).toEqual({ publicOrigin: 'https://w.example.com', publicDownloads: false });
    for (const bad of ['http://w.example.com', 'https://w.example.com/path', 'wss://w.example.com']) {
      expect(() => loadConfig({ ...base, PUBLIC_ORIGIN: bad }, '/cwd'), bad).toThrow(ConfigError);
    }
  });

  it('reads the worker key-rotation approval policy (default off, only "true"/"false")', () => {
    expect(loadConfig(base, '/cwd').workerRotationRequiresApproval).toBe(false);
    expect(
      loadConfig({ ...base, WORKER_ROTATION_REQUIRES_APPROVAL: 'true' }, '/cwd')
        .workerRotationRequiresApproval,
    ).toBe(true);
    expect(() => loadConfig({ ...base, WORKER_ROTATION_REQUIRES_APPROVAL: 'yes' }, '/cwd')).toThrow(
      ConfigError,
    );
  });

  it('git flow: GitHub App needs id and key file together; GHES host from the API URL; plain git off', () => {
    expect(loadConfig(base, '/cwd').gitflow).toEqual({
      github: null,
      plainGit: false,
      cacheDir: null,
      // p5-github-connect: known without a key file (the App can be connected from the panel).
      githubApiUrl: 'https://api.github.com',
      githubWebUrl: 'https://github.com',
      githubHost: 'github.com',
    });
    expect(
      loadConfig({ ...base, GITHUB_APP_ID: '123', GITHUB_APP_PRIVATE_KEY_FILE: 'k/app.pem' }, '/srv').gitflow
        .github,
    ).toEqual({
      appId: '123',
      privateKeyFile: '/srv/k/app.pem',
      apiUrl: 'https://api.github.com',
      host: 'github.com',
    });
    expect(
      loadConfig(
        {
          ...base,
          GITHUB_APP_ID: '1',
          GITHUB_APP_PRIVATE_KEY_FILE: '/k.pem',
          GITHUB_API_URL: 'https://GHE.example.com/api/v3',
        },
        '/',
      ).gitflow.github?.host,
    ).toBe('ghe.example.com');
    expect(
      loadConfig({ ...base, GITHUB_API_URL: 'https://ghe.example.com/api/v3' }, '/').gitflow,
    ).toMatchObject({ github: null, githubWebUrl: 'https://ghe.example.com', githubHost: 'ghe.example.com' });
    expect(() => loadConfig({ ...base, GITHUB_APP_ID: '1' }, '/cwd')).toThrow(/set both or neither/);
    expect(() => loadConfig({ ...base, GITHUB_API_URL: 'http://x' }, '/cwd')).toThrow(ConfigError);
    expect(loadConfig({ ...base, GITFLOW_PLAIN_GIT: 'true' }, '/cwd').gitflow.plainGit).toBe(true);
  });

  it('lease signing key: optional in development, required in production (p4-leases)', () => {
    expect(loadConfig(base, '/cwd')).toMatchObject({ leaseSigningKeyFile: null, leaseTtlMs: 90_000 });
    expect(loadConfig({ ...base, LEASE_SIGNING_KEY_FILE: 'k/lease.pem' }, '/srv').leaseSigningKeyFile).toBe(
      '/srv/k/lease.pem',
    );
    expect(() => loadConfig({ ...base, NODE_ENV: 'production' }, '/cwd')).toThrow(/LEASE_SIGNING_KEY_FILE/);
    expect(() => loadConfig({ ...base, LEASE_TTL_MS: '100' }, '/cwd')).toThrow(ConfigError);
  });

  it('notification channels are disabled by default and validated when configured (p5-notifications)', () => {
    expect(loadConfig(base, '/cwd').notifications).toEqual({
      intervalMs: 15_000,
      publicUrl: null,
      smtp: null,
      webhook: null,
      push: null,
    });
    const c = loadConfig(
      {
        ...base,
        NOTIFY_SMTP_HOST: 'smtp.example.com',
        NOTIFY_SMTP_FROM: 'remyral@example.com',
        NOTIFY_SMTP_USERNAME: 'remyral',
        NOTIFY_SMTP_PASSWORD_FILE: 'secrets/smtp',
        NOTIFY_WEBHOOK_ALLOWLIST: 'https://a.example.com/x/, https://b.example.com/',
        NOTIFY_WEBHOOK_SECRET_FILE: '/run/hmac',
      },
      '/srv',
    );
    expect(c.notifications.smtp).toMatchObject({
      port: 587,
      security: 'starttls',
      passwordFile: '/srv/secrets/smtp',
    });
    expect(c.notifications.webhook).toEqual({
      allowlist: ['https://a.example.com/x/', 'https://b.example.com/'],
      secretFile: '/run/hmac',
    });
    // No plain-text SMTP mode exists; incomplete channel settings fail fast.
    expect(() =>
      loadConfig({
        ...base,
        NOTIFY_SMTP_HOST: 'h',
        NOTIFY_SMTP_FROM: 'a@b.co',
        NOTIFY_SMTP_SECURITY: 'none',
      }),
    ).toThrow(ConfigError);
    expect(() => loadConfig({ ...base, NOTIFY_SMTP_HOST: 'h' })).toThrow(/NOTIFY_SMTP_FROM/);
    expect(() => loadConfig({ ...base, NOTIFY_WEBHOOK_ALLOWLIST: 'https://a.example.com/' })).toThrow(
      /NOTIFY_WEBHOOK_SECRET_FILE/,
    );
  });

  it('resolves a relative key file path against cwd', () => {
    expect(loadConfig({ ...base, TOTP_KEY_FILE: 'k/totp.key' }, '/srv/app').totpKeyFile).toBe(
      '/srv/app/k/totp.key',
    );
  });

  it('fails fast listing variable names without echoing values', () => {
    const canary = 'CANARY-SECRET-9f2c';
    let caught: unknown;
    try {
      loadConfig({
        DATABASE_URL: `mysql://u:${canary}@h/db`,
        REDIS_URL: `http://${canary}`,
        MASTER_PORT: 'x',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    const message = (caught as ConfigError).message;
    expect(message).toContain('DATABASE_URL');
    expect(message).toContain('REDIS_URL');
    expect(message).toContain('TOTP_KEY_FILE');
    expect(message).toContain('MASTER_PORT');
    expect(message).not.toContain(canary);
  });
});

describe('p17-update-channel configuration', () => {
  const K1 = 'A'.repeat(43);
  const K2 = 'B'.repeat(43);
  it('derives the worker feed and the catalog next to the control-plane feed; the release key defaults to the installed one', () => {
    const c = loadConfig(
      {
        ...base,
        UPDATE_FEED_URL: 'https://releases.example.com/remyral/feed.json',
        UPDATE_FEED_FILE: '/run/remyral-update/feed.json',
        CONTROL_PLANE_RELEASE_KEYS: `${K1},${K2},${'C'.repeat(43)}`,
      },
      '/cwd',
    );
    expect(c.updateChannel).toEqual({
      feedUrl: 'https://releases.example.com/remyral/workers/feed.json',
      feedFile: '/run/remyral-update/workers/feed.json',
      catalogUrl: 'https://releases.example.com/remyral/catalog/catalog.json',
      catalogFile: '/run/remyral-update/catalog/catalog.json',
      catalogKeys: [],
      catalog: true,
    });
    expect(c.releasePublicKeys).toEqual([K1, K2]);
    const own = loadConfig(
      { ...base, RELEASE_PUBLIC_KEYS: K2, CONTROL_PLANE_RELEASE_KEYS: K1, VERSION_CATALOG: 'off' },
      '/cwd',
    );
    expect(own.releasePublicKeys).toEqual([K2]);
    expect(own.updateChannel).toMatchObject({ feedUrl: null, feedFile: null, catalog: false });
    expect(() => loadConfig({ ...base, WORKER_FEED_URL: 'http://x/feed.json' }, '/cwd')).toThrow();
  });
});
