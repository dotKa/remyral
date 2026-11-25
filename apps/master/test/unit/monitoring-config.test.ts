import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * p1-monitoring: static checks of the host monitoring files in infra/monitoring (they are deployed by the
 * orchestrator, not exercised by the app tests). docs/ops/monitoring.md.
 */
const dir = fileURLToPath(new URL('../../../../infra/monitoring/', import.meta.url));
const read = (f: string): string => readFileSync(join(dir, f), 'utf8');

interface CfnResource {
  readonly Type: string;
  readonly Condition?: string;
  readonly Properties: Record<string, unknown>;
}
const cfn = JSON.parse(read('cloudformation.json')) as {
  Resources: Record<string, CfnResource>;
  Parameters: Record<string, unknown>;
};
const resources = Object.entries(cfn.Resources);
const ofType = (t: string): [string, CfnResource][] => resources.filter(([, r]) => r.Type === t);

const tmp = mkdtempSync(join(tmpdir(), 'remyral-monitoring-'));
afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe('cloudformation.json', () => {
  it('every log group has a bounded retention', () => {
    const groups = ofType('AWS::Logs::LogGroup');
    expect(groups.map(([n]) => n).sort()).toEqual(['ContainerLogGroup', 'MetricsLogGroup']);
    for (const [, g] of groups) expect(g.Properties.RetentionInDays).toBeDefined();
  });

  it('masks what it audits in the container log group, with RE2-compatible custom identifiers', () => {
    const policy = cfn.Resources.ContainerLogGroup?.Properties.DataProtectionPolicy as {
      Configuration: { CustomDataIdentifier: { Name: string; Regex: string }[] };
      Statement: { DataIdentifier: string[]; Operation: Record<string, unknown> }[];
    };
    const audit = policy.Statement.find((s) => 'Audit' in s.Operation);
    const mask = policy.Statement.find((s) => 'Deidentify' in s.Operation);
    expect(new Set(mask?.DataIdentifier)).toEqual(new Set(audit?.DataIdentifier));
    const custom = policy.Configuration.CustomDataIdentifier;
    expect(custom.length).toBeLessThanOrEqual(10);
    const canaries: Record<string, string> = {
      AnthropicKey: `sk-ant-api03-${'A'.repeat(24)}`,
      OpenAiKey: `sk-proj-${'b1'.repeat(16)}`,
      GitHubToken: `ghp_${'c'.repeat(36)}`,
      GitLabToken: `glpat-${'d'.repeat(20)}`,
      UrlCredentials: 'postgres://remyral_app:hunter2hunter2@remyral-pg:5432/remyral',
      BearerToken: `Bearer ${'e'.repeat(32)}`,
      Jwt: 'eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl',
    };
    for (const c of custom) {
      expect(c.Regex.length).toBeLessThanOrEqual(200);
      expect(c.Regex).not.toMatch(/\(\?[=!<]/); // no look-around: CloudWatch uses RE2
      expect(mask?.DataIdentifier).toContain(c.Name);
      expect(new RegExp(c.Regex).test(canaries[c.Name] ?? '')).toBe(true);
    }
  });

  it('checks the public status probe, never the internal health endpoints', () => {
    const hc = cfn.Resources.UptimeHealthCheck?.Properties.HealthCheckConfig as Record<string, unknown>;
    expect(hc.ResourcePath).toBe('/api/status');
    expect(hc.Type).toBe('HTTPS_STR_MATCH');
    expect(hc.SearchString).toBe('"status":"ok"');
    expect(JSON.stringify(cfn)).not.toMatch(/healthz|readyz/);
  });

  it('p6-alerts: host alarms exist, notify the topic on alarm and recovery, and use emitted dimensions', () => {
    const alarms = Object.fromEntries(ofType('AWS::CloudWatch::Alarm'));
    for (const name of [
      'CpuCreditsLowAlarm',
      'DiskAlarm',
      'MemoryAlarm',
      'MasterUnhealthyAlarm',
      'PostgresUnhealthyAlarm',
      'RedisUnhealthyAlarm',
      'StatusCheckAlarm',
      'UptimeAlarm',
    ]) {
      expect(alarms).toHaveProperty(name);
    }
    for (const [, a] of Object.entries(alarms)) {
      expect(a.Properties.AlarmActions).toEqual([{ Ref: 'AlertTopic' }]);
      expect(a.Properties.OKActions).toEqual([{ Ref: 'AlertTopic' }]);
    }
    expect(alarms.DiskAlarm?.Properties).toMatchObject({ MetricName: 'disk_used_percent', Threshold: 80 });
    expect(alarms.CpuCreditsLowAlarm?.Properties).toMatchObject({
      Namespace: 'AWS/EC2',
      MetricName: 'CPUCreditBalance',
    });
    // Container alarms use exactly the EMF dimensions container-stats.sh emits; silence is an alarm.
    expect(alarms.MasterUnhealthyAlarm?.Properties).toMatchObject({
      Namespace: 'Remana/Containers',
      MetricName: 'Healthy',
      Dimensions: [
        { Name: 'Environment', Value: { Ref: 'Environment' } },
        { Name: 'Service', Value: 'master' },
      ],
      TreatMissingData: 'breaching',
    });
    expect(read('container-stats.sh')).toContain('\\"Dimensions\\":[[\\"Environment\\",\\"Service\\"]]');
  });

  it('dashboard body is valid JSON once substituted', () => {
    const body = (cfn.Resources.Dashboard?.Properties.DashboardBody as { 'Fn::Sub': string })['Fn::Sub'];
    const substituted = body.replace(/\$\{[A-Za-z:]+\}/g, 'x');
    const parsed = JSON.parse(substituted) as { widgets: unknown[] };
    expect(parsed.widgets.length).toBeGreaterThan(3);
  });
});

describe('cloudwatch-agent.json', () => {
  it('collects host metrics and only listens for EMF; ships no files', () => {
    const agent = JSON.parse(read('cloudwatch-agent.json')) as {
      metrics: {
        namespace: string;
        metrics_collected: Record<string, unknown>;
        aggregation_dimensions: string[][];
      };
      logs: { metrics_collected: Record<string, unknown>; logs_collected?: unknown };
    };
    expect(agent.metrics.namespace).toBe('Remana/Host');
    expect(Object.keys(agent.metrics.metrics_collected).sort()).toEqual(['cpu', 'disk', 'mem', 'swap']);
    expect(agent.metrics.aggregation_dimensions).toEqual([['InstanceId']]);
    expect(agent.logs.metrics_collected).toHaveProperty('emf');
    expect(agent.logs.logs_collected).toBeUndefined();
  });
});

describe('compose.awslogs.yaml', () => {
  const text = read('compose.awslogs.yaml');
  it('ships master/migrate/web only, into the CloudFormation log group, non-blocking', () => {
    expect(text).toContain('awslogs-group: /remana/${REMYRAL_ENV:-prod}/containers');
    expect(text).toContain("awslogs-create-group: 'false'");
    expect(text).toContain('mode: non-blocking');
    const services = [...text.matchAll(/^ {2}([a-z]+):\n {4}logging: \*awslogs$/gm)].map((m) => m[1]);
    expect(services).toEqual(['master', 'migrate', 'web']);
  });
});

describe('container-stats.sh', () => {
  const fakeDocker = join(tmp, 'docker');
  writeFileSync(
    fakeDocker,
    `#!/usr/bin/env bash
case "$1" in
  ps)
    case "$*" in
      *service=master*) echo masterid ;;
      *service=web*) echo webid ;;
      *service=postgres*) echo pgid ;;
      *) ;;
    esac ;;
  inspect)
    case "$*" in
      *masterid*) echo 'true healthy' ;;
      *webid*) echo 'true unhealthy' ;;
      *pgid*) echo 'false exited' ;;
    esac ;;
  stats) echo '12.50% 41.3%' ;;
esac
`,
  );
  chmodSync(fakeDocker, 0o755);

  it('emits one EMF line per expected service with numbers only', () => {
    const out = join(tmp, 'emf.out');
    execFileSync('bash', [join(dir, 'container-stats.sh')], {
      env: { PATH: process.env.PATH, DOCKER: fakeDocker, REMANA_ENV: 'prod', REMANA_EMF_TARGET: out },
    });
    const lines = readFileSync(out, 'utf8').trim().split('\n');
    const byService = Object.fromEntries(
      lines.map((l) => {
        const e = JSON.parse(l) as Record<string, unknown> & { _aws: { LogGroupName: string } };
        expect(e._aws.LogGroupName).toBe('/remana/prod/metrics');
        expect(Object.keys(e).sort()).toEqual(
          ['CpuPercent', 'Environment', 'Healthy', 'MemoryPercent', 'Service', 'Up', '_aws'].sort(),
        );
        return [e.Service as string, [e.Up, e.Healthy, e.CpuPercent, e.MemoryPercent]];
      }),
    );
    expect(byService).toEqual({
      master: [1, 1, 12.5, 41.3],
      web: [1, 0, 12.5, 41.3],
      postgres: [0, 0, 0, 0],
      redis: [0, 0, 0, 0], // no container at all
    });
  });

  it('refuses an environment name that could break the JSON', () => {
    expect(() =>
      execFileSync('bash', [join(dir, 'container-stats.sh'), '--dry-run'], {
        env: { PATH: process.env.PATH, DOCKER: fakeDocker, REMANA_ENV: 'prod","x' },
        stdio: 'pipe',
      }),
    ).toThrow();
  });
});

describe('install-host.sh', () => {
  it('verifies the agent signature against the pinned AWS fingerprint and dry-runs cleanly', () => {
    const text = read('install-host.sh');
    expect(text).toContain('FPR="937616F3450B7D806CBD9725D58167303B789C72"');
    expect(text).toContain('VALIDSIG $FPR');
    const out = execFileSync('bash', [join(dir, 'install-host.sh'), '--dry-run', '--env', 'staging'], {
      env: { PATH: process.env.PATH },
      encoding: 'utf8',
    });
    expect(out).toContain('amazon-cloudwatch-agent.deb.sig');
    expect(out).toContain('REMANA_ENV=staging');
    expect(out).toContain('systemctl enable --now remana-container-stats.timer');
  });
});

/** p16-observability: the optional Prometheus + Grafana overlay (docs/ops/monitoring.md §8). */
describe('compose.monitoring.yaml, prometheus.yml, Grafana provisioning and dashboards', () => {
  const overlay = read('compose.monitoring.yaml');
  const src = fileURLToPath(new URL('../../src/', import.meta.url));

  /** Every instrument name the master creates (the Prometheus exporter adds _total / _bucket / _count / _sum). */
  function masterMetricNames(): Set<string> {
    const out = new Set<string>();
    const walk = (d: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith('.ts')) {
          for (const m of readFileSync(p, 'utf8').matchAll(
            /create(?:Counter|Histogram|ObservableGauge|UpDownCounter|ObservableCounter)\(\s*'([a-z_]+)'/g,
          ))
            if (m[1] !== undefined) out.add(m[1]);
        }
      }
    };
    walk(src);
    return out;
  }

  it('is opt-in (profile monitoring), digest-pinned, read-only and publishes Grafana on loopback only', () => {
    const services = overlay.split('\n').filter((l) => /^ {2}[a-z]+:$/.test(l));
    expect(services.map((l) => l.trim())).toEqual(['master:', 'prometheus:', 'grafana:']);
    expect(overlay.match(/profiles: \[monitoring\]/g)).toHaveLength(2);
    for (const m of overlay.matchAll(/^\s*image:\s*(\S+)/gm)) expect(m[1]).toMatch(/@sha256:[0-9a-f]{64}$/);
    expect(overlay.match(/read_only: true/g)).toHaveLength(2);
    const ports = [...overlay.matchAll(/^\s*- '([^']+):3000'$/gm)].map((m) => m[1]);
    expect(ports).toEqual(['127.0.0.1:${GRAFANA_PORT:-3300}']);
    expect(overlay).not.toMatch(/9090:9090|9464:9464/);
    expect(overlay).toContain('METRICS_TOKEN_FILE: /run/secrets/remyral/metrics.token');
    expect(overlay).toContain("GF_AUTH_ANONYMOUS_ENABLED: 'false'");
    expect(overlay).toContain('GF_SECURITY_ADMIN_PASSWORD__FILE');
    // Paths resolve from infra/coolify (the first -f file sets the project directory).
    for (const m of overlay.matchAll(/^\s*- (\.\.?\/[^:]+):/gm)) expect(m[1]).toMatch(/^\.\.\/monitoring\//);
  });

  it('Prometheus scrapes the master over the internal network with the token file, never an inline token', () => {
    const prom = read('prometheus/prometheus.yml');
    expect(prom).toContain("targets: ['master:9464']");
    expect(prom).toContain('credentials_file: /etc/prometheus/metrics.token');
    expect(prom).not.toMatch(/^\s*credentials:/m);
    expect(read('grafana/provisioning/datasources/prometheus.yaml')).toContain('uid: remyral-prometheus');
    expect(read('grafana/provisioning/dashboards/remyral.yaml')).toContain('path: /etc/grafana/dashboards');
  });

  it('every dashboard is valid JSON on the provisioned data source and queries only metrics the master exposes', () => {
    const names = masterMetricNames();
    expect(names.has('remyral_chat_turns')).toBe(true);
    const files = readdirSync(join(dir, 'grafana/dashboards')).filter((f) => f.endsWith('.json'));
    expect(files.sort()).toEqual(['remyral-control-plane.json', 'remyral-jobs-chat-costs.json']);
    const uids = new Set<string>();
    for (const f of files) {
      const d = JSON.parse(read(`grafana/dashboards/${f}`)) as {
        uid: string;
        panels: { type: string; datasource?: { uid: string }; targets?: { expr: string }[] }[];
      };
      expect(uids.has(d.uid)).toBe(false);
      uids.add(d.uid);
      const panels = d.panels.filter((p) => p.type !== 'row');
      expect(panels.length).toBeGreaterThan(5);
      for (const p of panels) {
        expect(p.datasource?.uid).toBe('remyral-prometheus');
        for (const t of p.targets ?? []) {
          const used = [...t.expr.matchAll(/\b(remyral_[a-z_]+)/g)].map((m) => m[1] ?? '');
          expect(used.length, t.expr).toBeGreaterThan(0);
          for (const u of used) {
            const base = u.replace(/_(total|bucket|count|sum)$/, '');
            expect(names.has(base), `${f}: ${u}`).toBe(true);
          }
        }
      }
    }
  });
});
