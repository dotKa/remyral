# PowerShell 7 (pinned, SHA-256 verified) on Debian for the Windows installer plan tests.
# Test-only. mcr.microsoft.com/powershell has no linux/arm64 image, hence this one.
FROM debian:trixie-slim@sha256:a29215f6a35e51e22adffa17f89e9d2ef06214e64a2bad10d765c46aea49f11f
ARG TARGETARCH
ARG PWSH_VERSION=7.6.6
ARG PWSH_SHA256_ARM64=924829e54c983648f6f1419a2dc7f9433c861b2fb5bd57736ff096c24f133729
ARG PWSH_SHA256_X64=ddbc4a2d113bbd46d283cfedcbcd117a70caefd7673f41f2b4e0000badf103bc
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl libicu76 libssl3t64 \
 && rm -rf /var/lib/apt/lists/* \
 && case "$TARGETARCH" in arm64) arch=arm64; sum=$PWSH_SHA256_ARM64 ;; amd64) arch=x64; sum=$PWSH_SHA256_X64 ;; *) echo "unsupported $TARGETARCH"; exit 1 ;; esac \
 && curl -fsSL -o /tmp/pwsh.tgz "https://github.com/PowerShell/PowerShell/releases/download/v${PWSH_VERSION}/powershell-${PWSH_VERSION}-linux-${arch}.tar.gz" \
 && echo "$sum  /tmp/pwsh.tgz" | sha256sum -c - \
 && mkdir -p /opt/pwsh && tar -xzf /tmp/pwsh.tgz -C /opt/pwsh && rm /tmp/pwsh.tgz \
 && chmod +x /opt/pwsh/pwsh && ln -s /opt/pwsh/pwsh /usr/local/bin/pwsh
ENV POWERSHELL_TELEMETRY_OPTOUT=1 DOTNET_CLI_TELEMETRY_OPTOUT=1
ENTRYPOINT ["pwsh", "-NoProfile", "-NonInteractive"]
