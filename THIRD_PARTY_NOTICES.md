# Third-party notices

Remyral's own code is licensed under the [Apache License 2.0](LICENSE); see also [NOTICE](NOTICE) for third-party
material copied into this repository and [TRADEMARKS.md](TRADEMARKS.md) for the names and logos.

This file lists software that Remyral **uses but does not contain**: packages installed from npm, and container images
pulled at deploy time. Each is a separate work under its own licence; the Apache License of this repository does not
apply to them and does not change their terms. The list is informational, not legal advice; the licence text that
ships with each package or image is authoritative.

## Proprietary dependency: `@anthropic-ai/claude-agent-sdk`

`@anthropic-ai/claude-agent-sdk` (used by `packages/agent-adapters` to drive Claude Code) is **not open source**. Its
`LICENSE.md` reads "© Anthropic PBC. All rights reserved" and refers to Anthropic's legal agreements
(<https://code.claude.com/docs/en/legal-and-compliance>); its `package.json` has no SPDX licence, so it appears as
"Unknown" below. Its platform packages (`@anthropic-ai/claude-agent-sdk-<os>-<arch>`) contain the native Claude Code
CLI under the same terms. It is a dependency of Remyral and is **not** covered by the Apache License 2.0. Anyone who
installs, builds or redistributes Remyral (in particular the worker bundle and the `claude-code` runtime image) must
check that their use complies with Anthropic's terms.

## npm production dependencies

Generated from the lockfile's production dependency tree of all workspace packages
(`pnpm -r licenses list --prod --json`). Regenerate after a dependency change with:

```sh
node scripts/third-party-notices.mjs          # rewrite the list below
node scripts/third-party-notices.mjs --check  # verify it is current
```

Development-only tools (TypeScript, Vite, Vitest, ESLint, Playwright, esbuild …) are not listed. The agent runtimes a
worker installs on demand (Claude Code via the SDK above, Codex `@openai/codex` Apache-2.0, OpenCode `opencode-ai` MIT,
Pi `@earendil-works/pi-coding-agent`) and the IDE servers it downloads (openvscode-server, code-server, both MIT) are
fetched from their publishers at run time and are not listed here either.

<!-- BEGIN GENERATED DEPENDENCIES (scripts/third-party-notices.mjs) -->

282 packages. Licence as declared by each package's `package.json` ("Unknown": no SPDX identifier, see the note above).

### MIT (211)

- @anthropic-ai/sdk@0.133.0
- @babel/runtime@7.29.10
- @codemirror/autocomplete@6.20.4
- @codemirror/commands@6.11.1
- @codemirror/lang-css@6.3.1
- @codemirror/lang-html@6.4.12
- @codemirror/lang-javascript@6.2.5
- @codemirror/lang-json@6.0.2
- @codemirror/lang-markdown@6.5.2
- @codemirror/lang-python@6.2.1
- @codemirror/lang-yaml@6.1.3
- @codemirror/language@6.13.1
- @codemirror/legacy-modes@6.5.5
- @codemirror/lint@6.9.7
- @codemirror/merge@6.12.2
- @codemirror/search@6.7.2
- @codemirror/state@6.7.6
- @codemirror/streamparser@6.0.0
- @codemirror/view@6.43.14
- @dagrejs/dagre@3.1.1
- @dagrejs/graphlib@4.0.5
- @fastify/ajv-compiler@4.0.7
- @fastify/cookie@11.1.3
- @fastify/deepmerge@3.2.2
- @fastify/error@4.2.1
- @fastify/fast-json-stringify-compiler@5.1.1
- @fastify/forwarded@3.1.1
- @fastify/helmet@13.1.2
- @fastify/merge-json-schemas@0.2.2
- @fastify/proxy-addr@5.1.2
- @fastify/swagger@9.9.2
- @fastify/type-provider-zod@1.0.0
- @fastify/websocket@11.3.4
- @hono/node-server@2.1.11
- @ioredis/commands@2.0.0
- @lezer/common@1.5.4
- @lezer/css@1.3.9
- @lezer/highlight@1.2.5
- @lezer/html@1.3.13
- @lezer/javascript@1.5.6
- @lezer/json@1.0.3
- @lezer/lr@1.4.11
- @lezer/markdown@1.8.1
- @lezer/python@1.1.19
- @lezer/yaml@1.0.4
- @marijn/find-cluster-break@1.0.4
- @modelcontextprotocol/sdk@1.32.1
- @pinojs/redact@0.4.0
- @remix-run/route-pattern@0.22.1
- @stablelib/base64@1.0.1
- @types/d3-color@3.1.3
- @types/d3-drag@3.0.7
- @types/d3-interpolate@3.0.4
- @types/d3-selection@3.0.12
- @types/d3-transition@3.0.9
- @types/d3-zoom@3.0.9
- @xyflow/react@12.12.0
- @xyflow/system@0.0.83
- abstract-logging@2.0.1
- accepts@2.0.0
- ajv-formats@3.0.1
- ajv@8.20.0
- atomic-sleep@1.0.0
- avvio@9.3.1
- body-parser@2.4.0
- bowser@2.14.1
- bullmq@6.3.11
- bytes@3.1.2
- call-bind-apply-helpers@1.0.2
- call-bound@1.0.4
- classcat@5.0.5
- content-disposition@2.0.1
- content-type@1.0.5, 2.1.0
- cookie-es@3.1.1
- cookie-signature@1.2.2
- cookie@0.7.2, 2.0.1
- cors@2.8.6
- crelt@1.0.7
- cron-parser@5.10.1
- cross-spawn@7.0.6
- debug@4.4.3
- depd@2.0.0
- dequal@2.0.3
- dunder-proto@1.0.1
- duplexify@4.1.3
- ee-first@1.1.1
- encodeurl@2.0.0
- end-of-stream@1.4.5
- es-define-property@1.0.1
- es-errors@1.3.0
- es-object-atoms@1.1.2
- escape-html@1.0.3
- etag@1.8.1
- eventsource-parser@3.1.1
- eventsource@3.0.7
- express-rate-limit@8.7.1
- express@5.3.0
- fast-decode-uri-component@1.0.1
- fast-deep-equal@3.1.3
- fast-json-stringify@7.1.0
- fast-querystring@1.1.2
- fastify-plugin@6.0.1
- fastify@5.12.8
- finalhandler@2.1.1
- find-my-way@9.10.0
- forwarded@0.2.0
- fresh@2.0.0
- function-bind@1.1.2
- get-intrinsic@1.3.0
- get-proto@1.0.1
- gopd@1.2.0
- has-symbols@1.1.0
- hasown@2.0.4
- helmet@8.3.0
- hono@4.13.20
- http-errors@2.0.1
- iconv-lite@0.7.3
- ioredis@6.0.0
- ip-address@10.7.4
- ipaddr.js@1.9.1, 2.5.0
- is-promise@4.0.0
- jose@6.2.12
- json-schema-ref-resolver@3.0.1
- json-schema-resolver@3.0.0
- json-schema-to-ts@3.1.1
- json-schema-traverse@1.0.0
- jsonata@2.2.2
- luxon@3.7.2
- math-intrinsics@1.1.0
- media-typer@1.1.1
- merge-descriptors@2.0.0
- mime-db@1.54.0
- mime-types@3.0.2
- ms@2.1.3
- msgpackr@2.1.0
- negotiator@1.1.0
- node-abort-controller@3.1.1
- object-assign@4.1.1
- object-inspect@1.13.4
- on-exit-leak-free@2.1.2
- on-finished@2.4.1
- openapi-types@12.1.3
- parseurl@1.3.3
- path-key@3.1.1
- path-to-regexp@8.4.2
- pg-connection-string@2.14.1
- pg-pool@3.14.0
- pg-protocol@1.16.1
- pg-types@2.2.0
- pg@8.23.1
- pgpass@1.0.5
- pino-abstract-transport@3.0.0
- pino-std-serializers@7.1.0
- pino@10.4.0
- pkce-challenge@5.0.1
- postgres-array@2.0.0
- postgres-bytea@1.0.1
- postgres-date@1.0.7
- postgres-interval@1.2.0
- process-warning@5.1.1
- proxy-addr@2.0.8
- quick-format-unescaped@4.0.4
- range-parser@1.3.0
- raw-body@3.0.2
- react-dom@19.3.0
- react-router@8.4.0
- react@19.3.0
- readable-stream@3.6.2
- real-require@1.0.0
- redis-errors@1.2.0
- require-from-string@2.0.2
- ret@0.5.0
- reusify@1.1.0
- rfdc@1.4.1
- router@2.2.0
- safe-buffer@5.2.1
- safe-regex2@5.1.2
- safe-stable-stringify@2.5.0
- safer-buffer@2.1.2
- scheduler@0.28.0
- send@1.2.1
- serve-static@2.2.1
- set-cookie-parser@3.1.3
- shebang-command@2.0.0
- shebang-regex@3.0.0
- side-channel-list@1.0.1
- side-channel-map@1.0.1
- side-channel-weakmap@1.0.2
- side-channel@1.1.1
- sonic-boom@4.2.1
- standard-as-callback@2.1.0
- standardwebhooks@1.1.1
- statuses@2.0.2
- stream-shift@1.0.3
- string_decoder@1.3.0
- style-mod@4.1.4
- thread-stream@4.2.0
- toad-cache@3.7.4
- toidentifier@1.0.1
- ts-algebra@2.0.0
- type-is@2.1.0
- unpipe@1.0.0
- uqr@0.1.3
- use-sync-external-store@1.7.0
- util-deprecate@1.0.2
- vary@1.1.2
- w3c-keyname@2.2.8
- ws@8.22.0
- xtend@4.0.2
- zod@4.6.7
- zustand@4.5.7

### Apache-2.0 (42)

- @aws-sdk/client-bedrock-runtime@3.1152.0
- @aws-sdk/core@3.978.3
- @aws-sdk/credential-provider-env@3.972.74
- @aws-sdk/credential-provider-http@3.972.76
- @aws-sdk/credential-provider-ini@3.973.19
- @aws-sdk/credential-provider-login@3.972.81
- @aws-sdk/credential-provider-node@3.972.86
- @aws-sdk/credential-provider-process@3.972.74
- @aws-sdk/credential-provider-sso@3.973.18
- @aws-sdk/credential-provider-web-identity@3.972.80
- @aws-sdk/eventstream-handler-node@3.972.36
- @aws-sdk/middleware-eventstream@3.972.31
- @aws-sdk/middleware-websocket@3.972.56
- @aws-sdk/nested-clients@3.997.48
- @aws-sdk/signature-v4-multi-region@3.996.48
- @aws-sdk/token-providers@3.1150.0, 3.1152.0
- @aws-sdk/types@3.974.6
- @aws-sdk/xml-builder@3.972.41
- @aws/lambda-invoke-store@0.3.0
- @opentelemetry/api-logs@0.223.0
- @opentelemetry/api@1.9.1
- @opentelemetry/context-async-hooks@2.12.0
- @opentelemetry/core@2.12.0
- @opentelemetry/exporter-logs-otlp-http@0.223.0
- @opentelemetry/exporter-metrics-otlp-http@0.223.0
- @opentelemetry/exporter-prometheus@0.223.0
- @opentelemetry/exporter-trace-otlp-http@0.223.0
- @opentelemetry/otlp-exporter-base@0.223.0
- @opentelemetry/otlp-transformer@0.223.0
- @opentelemetry/resources@2.12.0
- @opentelemetry/sdk-logs@0.223.0
- @opentelemetry/sdk-metrics@2.12.0
- @opentelemetry/sdk-trace@2.12.0
- @opentelemetry/semantic-conventions@1.43.0
- @smithy/core@3.36.0
- @smithy/credential-provider-imds@4.5.2
- @smithy/fetch-http-handler@5.8.0
- @smithy/node-http-handler@4.12.1
- @smithy/signature-v4@5.7.4
- @smithy/types@4.19.0
- cluster-key-slot@1.1.1
- denque@2.1.0

### ISC (20)

- d3-color@3.1.0
- d3-dispatch@3.0.1
- d3-drag@3.0.0
- d3-interpolate@3.0.1
- d3-selection@3.0.0
- d3-timer@3.0.1
- d3-transition@3.0.1
- d3-zoom@3.0.0
- fastq@1.20.3
- inherits@2.0.4
- isexe@2.0.0
- once@1.4.0
- pg-int8@1.0.1
- semver@7.8.5
- setprototypeof@1.2.0
- split2@4.2.0
- which@2.0.2
- wrappy@1.0.2
- yaml@2.9.1
- zod-to-json-schema@3.25.2

### BSD-3-Clause (5)

- d3-ease@3.0.1
- fast-uri@3.1.9, 4.2.3
- light-my-request@6.8.0
- qs@6.17.1
- secure-json-parse@4.1.1

### 0BSD (1)

- tslib@2.8.1

### BSD-2-Clause (1)

- json-schema-typed@8.0.2

### Unknown (1)

- @anthropic-ai/claude-agent-sdk@0.3.310

### Unlicense (1)

- fast-sha256@1.3.0

<!-- END GENERATED DEPENDENCIES -->

## Container images pulled at deploy time

The compose files under `infra/` pull these images unmodified from their publishers. They are separate works,
distributed by their publishers under their own licences, and are not covered by Remyral's licence. Remyral talks to
them over the network or the command line; no code from them is copied into this repository.

| Image (as pinned in `infra/`) | Role | Licence |
|---|---|---|
| `postgres:18.6-alpine` | database | PostgreSQL License (permissive) |
| `redis:8.10.2-alpine` | queues, rate limits, cache | Redis 8: tri-licence, at the user's choice RSALv2, SSPLv1 or AGPLv3 |
| `dxflrs/garage:v2.3.0` | S3-compatible object storage | AGPL-3.0 |
| `grafana/grafana:13.0.1` | optional monitoring dashboards | AGPL-3.0 |
| `prom/prometheus:v3.9.1` | optional metrics | Apache-2.0 |
| `traefik:v3.7.14` | reverse proxy (self-host / local) | MIT |
| `node:24-bookworm-slim`, `nginxinc/nginx-unprivileged`, `python:3.13-slim-bookworm`, `debian:trixie-slim` | base images of the Remyral images | Node.js MIT, nginx BSD-2-Clause, Python PSF; each also contains Debian / Alpine packages under their own licences |

Notes:

- **Redis** stopped being BSD-licensed with 7.4; version 8 adds AGPLv3 as a third option. Running the unmodified image
  as a backing service does not put Remyral under any of these licences, but an operator who modifies Redis or offers
  it as a service should read them.
- **Garage** and **Grafana** are AGPL-3.0: if you modify them and let others use them over a network, the AGPL asks you
  to offer your modified source. Remyral uses them unmodified, as separate programs.
- Images that Remyral builds itself (`remyral-master`, `remyral-web`, the backup and worker runtime images) contain
  Remyral's code plus the dependencies listed above; the `claude-code` runtime image also contains the proprietary SDK
  and CLI described above.
