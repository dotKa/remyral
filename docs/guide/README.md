# User guides

The guides under [`tr/`](tr/) are end-user and operator guides for the Remyral console, written in **Turkish**. They
describe what each screen does and how to set up a feature from the console. English operator documentation lives in
[`docs/ops/`](../ops/) (start with [selfhost-install.md](../ops/selfhost-install.md)); design notes and decision
records are in [`docs/design/`](../design/) and [`docs/adr/`](../adr/README.md).

The product links to some of these pages directly (for example the diagnostics screens link to anchors in
`tr/tanilama.md`, and the release bundle ships `tr/kurulum.md` as `KURULUM.md`), so file names and `<a id="…">`
anchors are stable. Translations are welcome; please keep the Turkish file names and anchors unchanged.

## Index

| Area | Guide (Turkish) | Topic |
| --- | --- | --- |
| Getting started | [kurulum.md](tr/kurulum.md) | Self-hosted install, update, backup and removal |
| | [tanilama.md](tr/tanilama.md) | Diagnostics (doctor) and the support report |
| | [mobil-uygulama.md](tr/mobil-uygulama.md) | Installing the console as a phone app (PWA) and push notifications |
| Machines | [makine-yonetimi.md](tr/makine-yonetimi.md) | Machine administration, tools and runtime versions |
| | [uzaktan-islemler.md](tr/uzaktan-islemler.md) | Remote operations (runtime install, login) from the console |
| | [sandbox.md](tr/sandbox.md) | Sandbox status, preparation and unconfined mode |
| | [runtime-politikasi.md](tr/runtime-politikasi.md) | Runtime policy (Settings → Runtimes) |
| | [tam-erisim.md](tr/tam-erisim.md) | Full-access runs |
| | [uptime.md](tr/uptime.md) | The uptime screen |
| Jobs and agents | [chat.md](tr/chat.md) | The ops chat assistant |
| | [orkestrasyon.md](tr/orkestrasyon.md) | Sub-jobs, planner and workflows |
| | [birlestirme.md](tr/birlestirme.md) | Master-managed integration: many agents, one branch, one PR |
| | [calisma-alanlari.md](tr/calisma-alanlari.md) | Workspaces (jobs without a repository) |
| | [ciktilar.md](tr/ciktilar.md) | The outputs screen |
| | [otomasyonlar.md](tr/otomasyonlar.md) | Scheduled and triggered automations |
| | [sablonlar.md](tr/sablonlar.md) | Job templates |
| | [onay-bekleme.md](tr/onay-bekleme.md) | Jobs waiting for approval pause and resume |
| | [oturum-surekliligi.md](tr/oturum-surekliligi.md) | Session continuity across worker restarts |
| | [dogrulama-saglik.md](tr/dogrulama-saglik.md) | Automatic verification and post-deploy health checks |
| Runtimes and cost | [credential-ve-modeller.md](tr/credential-ve-modeller.md) | Credentials and models |
| | [runtime-onerisi.md](tr/runtime-onerisi.md) | Runtime recommendation from past results |
| | [limit-fallback.md](tr/limit-fallback.md) | Usage limits: wait or fall back to another runtime |
| | [limit-gorunurluk.md](tr/limit-gorunurluk.md) | Usage-limit visibility |
| | [maliyet-verimlilik.md](tr/maliyet-verimlilik.md) | Budgets, cost dashboard and weekly report |
| Knowledge | [proje-hafizasi.md](tr/proje-hafizasi.md) | Project memory and semantic search |
| | [hafiza-katmanlari.md](tr/hafiza-katmanlari.md) | Memory layers: rules, facts, decisions, lessons |
| | [hafiza-ice-aktarma.md](tr/hafiza-ice-aktarma.md) | Importing memory from another assistant |
| | [skill-mekanizmasi.md](tr/skill-mekanizmasi.md) | Skills |
| Integrations | [github.md](tr/github.md) | GitHub App connection |
| | [gitlab-bitbucket.md](tr/gitlab-bitbucket.md) | GitLab and Bitbucket |
| | [deploy-entegrasyonlari.md](tr/deploy-entegrasyonlari.md) | Coolify, Cloudflare Pages and DNS |
| | [onizleme-tunelleri.md](tr/onizleme-tunelleri.md) | Preview tunnels (Cloudflare Tunnel) |
| | [depolama.md](tr/depolama.md) | File storage (S3, R2, MinIO or local disk) |
| | [api-anahtarlari.md](tr/api-anahtarlari.md) | API tokens and service accounts |
| Operations | [yedekleme.md](tr/yedekleme.md) | Backups and restore drills |
| | [kesinti-yedek.md](tr/kesinti-yedek.md) | Outage tolerance and standby restore |
| | [operasyon-guvenligi.md](tr/operasyon-guvenligi.md) | Key expiry, rollout circuit breaker, cost brake, rate limits |
