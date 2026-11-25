# Systemd-capable Debian image with Node 24 for testing the Linux worker installer
# (infra/worker/linux/test/systemd-e2e.sh). Test-only: never used to run a real worker.
# Node comes from the official node:24 image (root-owned /usr/local/bin/node), which is
# what the installer's node checks expect from a system-wide install.
ARG NODE_IMAGE=node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea
FROM ${NODE_IMAGE}
ENV container=docker DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
 && apt-get install -y --no-install-recommends systemd systemd-sysv dbus procps passwd \
 && rm -rf /var/lib/apt/lists/* \
 # Units that make no sense (or hang) inside a container.
 && systemctl mask systemd-firstboot.service systemd-udevd.service systemd-modules-load.service \
      sys-kernel-debug.mount sys-kernel-tracing.mount getty.target console-getty.service \
 # The node image ships a uid-1000 user "node"; keep it as the "interactive user" whose
 # home must stay invisible to the worker (ProtectHome).
 && install -d -o node -g node -m 0700 /home/node/.ssh \
 && echo canary > /home/node/.ssh/id_canary && chown node:node /home/node/.ssh/id_canary
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
