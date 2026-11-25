# Pi runtime image — pin from docs/compat/README.md §1.
# p7-supply-chain: installed from the committed package-lock.json (`npm ci`: every tarball, transitive ones
# included, is checked against its lockfile integrity) with install scripts disabled.
ARG BASE=remyral/runtime-base:0.1.0
FROM ${BASE}
USER root
COPY package.json package-lock.json /opt/remyral/runtime/
RUN npm ci --prefix /opt/remyral/runtime --omit=dev --ignore-scripts --no-audit --no-fund \
 && ln -s /opt/remyral/runtime/node_modules/.bin/pi /usr/local/bin/pi \
 && npm cache clean --force \
 && chown -R root:root /opt/remyral/runtime && chmod -R go-w /opt/remyral/runtime
USER 10001:10001
