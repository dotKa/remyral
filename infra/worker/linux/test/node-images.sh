# Pinned Node base images for the Linux installer tests (p7-supply-chain: every image by digest).
# Sourced by systemd-e2e.sh and update-e2e.sh. Refresh: docs/security/dependency-policy.md §3.
node_image_for() {
  case "$1" in
    trixie) echo "node:24-trixie-slim@sha256:43b9ba1142b8dcf33fa8f922ca1be85714adc444e0586c7cf7726daaeabc1bea" ;;
    bookworm) echo "node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205" ;;
    *) echo "unknown flavor $1 (trixie|bookworm)" >&2; return 1 ;;
  esac
}
