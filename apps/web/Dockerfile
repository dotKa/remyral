# Operator console image: the static Vite build served by nginx (unprivileged) — docs/ops/deploy-coolify.md,
# docs/design/p1-web-skeleton.md §3.
#
#   docker buildx build -f apps/web/Dockerfile -t remyral-web:<tag> .                       # native arch
#   docker buildx build --platform linux/amd64 -f apps/web/Dockerfile -t remyral-web:<tag> .
#
# The server proxies NOTHING: Traefik routes /api/* to the master (prefix stripped) and everything else
# here. Every response carries the master's security headers (helmet defaults + the master's CSP from
# apps/master/src/app.ts); `pnpm e2e:compose` asserts both header sets are identical.
# Runtime: uid 101, port 8080, read-only root fs (needs a tmpfs on /tmp only), no shell entrypoint scripts.

# node:24-bookworm-slim, multi-arch index digest, Node 24.22.1, pinned 2026-10-26 (build stage only).
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205
# nginxinc/nginx-unprivileged:1.30.5-alpine3.24 (stable), multi-arch index digest, pinned 2026-10-13.
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.30.5-alpine3.24@sha256:56b8272e43a0525f67aed68d1e0794a712d10e3e45a563e118e9a77c817e6f86
ARG PNPM_VERSION=12.11.2

# ---------------------------------------------------------------- build (static output: build platform only)
FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build
ARG PNPM_VERSION
ENV CI=true PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN npm install --global --ignore-scripts --no-audit --no-fund "pnpm@${PNPM_VERSION}"
WORKDIR /src
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
RUN --mount=type=cache,id=remyral-pnpm-store,target=/pnpm/store \
    pnpm fetch --store-dir /pnpm/store
COPY . .
RUN --mount=type=cache,id=remyral-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --store-dir /pnpm/store --filter "@remyral/web..."
RUN pnpm --filter @remyral/web run build \
 && test -f apps/web/dist/index.html \
 && test -s apps/web/dist/third-party-licenses.md \
 && ! grep -rqE '<script>|<style>' apps/web/dist/index.html

# ---------------------------------------------------------------- runtime
FROM ${NGINX_IMAGE} AS runtime

COPY <<'EOF' /etc/nginx/security-headers.conf
# Same set and values as the master (@fastify/helmet defaults + CONTENT_SECURITY_POLICY in apps/master/src/app.ts).
add_header Content-Security-Policy "default-src 'self';script-src 'self';style-src 'self';img-src 'self' data:;connect-src 'self';font-src 'self';object-src 'none';base-uri 'none';form-action 'self';frame-ancestors 'none'" always;
add_header Cross-Origin-Embedder-Policy "require-corp" always;
add_header Cross-Origin-Opener-Policy "same-origin" always;
add_header Cross-Origin-Resource-Policy "same-origin" always;
add_header Origin-Agent-Cluster "?1" always;
add_header Referrer-Policy "no-referrer" always;
add_header Strict-Transport-Security "max-age=31536000; includeSubDomains" always;
add_header X-Content-Type-Options "nosniff" always;
add_header X-DNS-Prefetch-Control "off" always;
add_header X-Download-Options "noopen" always;
add_header X-Frame-Options "SAMEORIGIN" always;
add_header X-Permitted-Cross-Domain-Policies "none" always;
add_header X-XSS-Protection "0" always;
EOF

COPY <<'EOF' /etc/nginx/nginx.conf
worker_processes auto;
pid /tmp/nginx.pid;
error_log /dev/stderr warn;

events { worker_connections 1024; }

http {
  include /etc/nginx/mime.types;
  default_type application/octet-stream;
  access_log /dev/stdout;
  server_tokens off;
  sendfile on;
  tcp_nopush on;
  keepalive_timeout 65;
  client_max_body_size 1k;
  gzip on;
  gzip_types text/css application/javascript image/svg+xml application/json;
  client_body_temp_path /tmp/client_temp;
  proxy_temp_path /tmp/proxy_temp;
  fastcgi_temp_path /tmp/fastcgi_temp;
  uwsgi_temp_path /tmp/uwsgi_temp;
  scgi_temp_path /tmp/scgi_temp;

  server {
    listen 8080;
    listen [::]:8080;
    server_name _;
    root /usr/share/nginx/html;
    absolute_redirect off;

    # add_header in a location replaces inherited ones, so every location includes the full set.
    # API paths never belong to the static site: a misrouted /api request must not get index.html.
    location ~ ^/api(/|$) {
      include /etc/nginx/security-headers.conf;
      add_header Cache-Control "no-store" always;
      default_type application/json;
      return 404 '{"error":"not_found","message":"Not found."}';
    }
    location ~ /\. {
      include /etc/nginx/security-headers.conf;
      return 404;
    }
    # p8-pwa: the service worker and the manifest are always revalidated (a new build is picked up at the
    # next check) and never fall back to index.html. The worker's scope is "/" (served from the root).
    location = /sw.js {
      include /etc/nginx/security-headers.conf;
      add_header Cache-Control "no-cache" always;
      limit_except GET { deny all; }
      try_files $uri =404;
    }
    location = /manifest.json {
      include /etc/nginx/security-headers.conf;
      add_header Cache-Control "no-cache" always;
      types { }
      default_type application/manifest+json;
      limit_except GET { deny all; }
      try_files $uri =404;
    }
    # Licence texts of the third-party code and fonts in this bundle (vite.config.ts build.license), readable in a browser.
    location = /third-party-licenses.md {
      include /etc/nginx/security-headers.conf;
      add_header Cache-Control "no-cache" always;
      types { }
      default_type "text/markdown; charset=utf-8";
      limit_except GET { deny all; }
      try_files $uri =404;
    }
    # Content-hashed bundles. p14-web-perf (docs/design/p14-web-perf.md §3): JS/CSS/SVG are precompressed at build
    # time (apps/web/perf-plugin.ts writes x.js.br + x.js.gz): brotli when the browser accepts it (internal rewrite
    # to the .br file, served by the nested location below with Content-Encoding: br), else the .gz (gzip_static),
    # else on-the-fly gzip. Every answer varies on Accept-Encoding (shared caches keep one copy per encoding).
    location /assets/ {
      include /etc/nginx/security-headers.conf;
      add_header Cache-Control "public, max-age=31536000, immutable" always;
      add_header Vary "Accept-Encoding" always;
      gzip_static on;
      set $remyral_br "";
      if ($http_accept_encoding ~* "(^|[\s,])br($|[\s,;])") {
        set $remyral_br "A";
      }
      if (-f $request_filename.br) {
        set $remyral_br "${remyral_br}B";
      }
      if ($remyral_br = "AB") {
        rewrite ^(.*)$ $1.br last;
      }
      try_files $uri =404;

      location ~ \.js\.br$ {
        include /etc/nginx/security-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Vary "Accept-Encoding" always;
        add_header Content-Encoding "br" always;
        gzip off;
        types { }
        default_type application/javascript;
        try_files $uri =404;
      }
      location ~ \.css\.br$ {
        include /etc/nginx/security-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Vary "Accept-Encoding" always;
        add_header Content-Encoding "br" always;
        gzip off;
        types { }
        default_type text/css;
        try_files $uri =404;
      }
      location ~ \.svg\.br$ {
        include /etc/nginx/security-headers.conf;
        add_header Cache-Control "public, max-age=31536000, immutable" always;
        add_header Vary "Accept-Encoding" always;
        add_header Content-Encoding "br" always;
        gzip off;
        types { }
        default_type image/svg+xml;
        try_files $uri =404;
      }
    }
    # Client-side routing: unknown paths fall back to index.html, which is always revalidated.
    location / {
      include /etc/nginx/security-headers.conf;
      add_header Cache-Control "no-cache" always;
      limit_except GET { deny all; }
      try_files $uri /index.html;
    }
  }
}
EOF

COPY --from=build --chown=root:root /src/apps/web/dist/ /usr/share/nginx/html/
USER 101:101
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD ["wget", "-q", "-O", "/dev/null", "http://127.0.0.1:8080/index.html"]
# nginx directly (no /docker-entrypoint.d scripts that rewrite config at start).
ENTRYPOINT ["nginx", "-g", "daemon off;"]
