# Remyral code node image, Python (p14-workflow-engine 14.3, K3; ADR-0055).
# The base is pinned by digest and must equal FUNCTION_CODE_BASE_IMAGES.python (packages/protocol/src/function-job.ts;
# asserted by packages/protocol/test/function-code-images.test.ts). Standard library only (no pip at build or run
# time). Runs as 10001 with no network, a read-only root and no secrets (apps/worker/src/functions/code.ts).
FROM python:3.13-slim-bookworm@sha256:a1165e272e578941b84abc79e4ab38a0305cd12803a5c4247979ac7655f4d641

COPY run.py /opt/remyral/run.py
RUN chmod 0555 /opt/remyral /opt/remyral/run.py \
 && (find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true)

ENV HOME=/tmp PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
USER 10001:10001
WORKDIR /tmp
ENTRYPOINT []
CMD ["python3", "-I", "/opt/remyral/run.py"]
