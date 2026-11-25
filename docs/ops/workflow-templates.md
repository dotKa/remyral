# Guide: ready-made workflow templates (Workflow'lar → Şablonlar)

- **Applies to:** master with `WORKFLOW_ENGINE_V2=true` (p14-workflow-engine 14.5); HTTP / e-mail nodes run on
  workers advertising `function-v1`, code nodes on workers with `function-code-v1` (container engine + code images,
  [deploy-coolify.md](deploy-coolify.md), design §19)
- **Audience:** everyone who builds workflows; project admins (templates with HTTP, e-mail or code nodes)
- **Design:** [docs/design/p14-workflow-engine.md](../design/p14-workflow-engine.md) §21,
  [ADR-0055](../adr/0055-general-workflow-engine.md)

A template is a complete, runnable workflow with **placeholders** for everything that is yours: API addresses, vault
credentials, mail server, recipients, schedule, runtime. Templates contain no host, token or address of their own.
Creating one saves a new workflow (version 1) in a project — **nothing runs** until you start it or activate its
triggers.

## 1. Create a workflow from a template

1. Open **Workflow'lar → Şablonlar**. Templates are grouped as Pazarlama, İçerik üretimi and Video üretimi; each card
   shows the graph, the node count, whether some nodes run on a machine (HTTP, e-mail, code) and whether saving needs
   a project admin with a verification code.
2. **Oluştur** opens the wizard:
   1. **Proje ve ad** — a project where you have at least the operator role, and the workflow name. A **workspace
      project** suits these templates best: files pass from step to step (`out/ → in/`). In a repository project
      every run asks for a repository.
   2. **Bağlantılar** — one field per placeholder. Addresses are `https://host[:port]` without a path (the path is a
      separate field with a sensible default). Credentials are picked from the vault (Ayarlar → Kimlik bilgileri):
      kind **http-auth** for APIs, **smtp** for the mail password; a credential is only usable for the hosts it is
      bound to (İzinli adresler) — the wizard warns when it is not bound to the address you entered. API credentials
      are optional (leave empty for a public API); the SMTP credential is required.
   3. **Kontrol ve oluştur** — the master checks the filled workflow exactly like a save (catalog, expressions, the
      project's HTTP allowlist, credential bindings) and lists any issue. **Oluştur** saves it; templates with HTTP /
      e-mail nodes need `workflows.define.network`, with code nodes `workflows.define.code` (project admin) and a
      fresh verification code.
3. The editor opens on the new workflow. Change anything you like, then run it (Çalıştır) or, for scheduled /
   webhook templates, **Tetikleyiciler → Etkinleştir**.

## 2. The templates

| Template | Trigger | What it does | Placeholders |
| --- | --- | --- | --- |
| **Haftalık içerik takvimi** (`marketing-content-calendar`) | weekly schedule (cron, UTC, default Monday 06:00) and manual | AI plans a week of posts per channel (structured output) → operator approval → one POST per post to your social / scheduling API (`{channel, text, publishAt}`) → report → e-mail; a rejection notifies the creator | brand, channels, language, cron, social API address + path + optional credential, SMTP provider + user + credential, sender, report recipient, runtime |
| **Potansiyel müşteri karşılama** (`marketing-lead-intake`) | signed webhook (`email`, `name`, `company`) | enrichment API GET (a failure does not lose the lead) → JavaScript score 0–100 with reasons → above the threshold: CRM POST `status: hot` + notification to operators; else CRM POST `status: nurture` | enrichment address + path + optional credential, CRM address + path + optional credential, threshold, runtime |
| **İçerik üretimi (araştırmadan yayına)** (`content-production`) | manual (`topic`, `audience`, `keyword`, `language`) | search API GET → AI research brief → outline → draft (title, meta, slug, Markdown) → AI review → human approval → Python SEO checks (title / meta length, keyword placement, headings, word count) → POST to your CMS (`draft` or `publish`) + notification; failed checks notify the problems | search address + path + optional credential, CMS address + path + optional credential, CMS status, runtime |
| **Video üretimi** (`video-production`) | manual (`brief`, `duration_sec`, `aspect`, `voice`, `language`) | AI script → AI storyboard (shots with voice-over and asset prompts) → per shot, 2 at a time: TTS POST + asset-generation POST → AI render step in a container with ffmpeg (`out/video.mp4`, poster) → review approval → "create upload" POST (your platform returns `body.id` and a pre-signed `body.uploadUrl`) → upload step (PUT of the file to that URL) → publish POST → notification | TTS address + path + credential, asset address + path + credential, video platform address + upload / publish paths + credential, visibility, runtime |

Provider contracts: the templates send plain JSON and read a few fields of the answers (`body.url` of TTS / asset
answers, `body.id` / `body.uploadUrl` of the upload ticket, `body.url` of a published item). If your provider uses
other field names, change the node's body or the expression in the editor — that is what the templates are for.

## 3. What runs where, and the rules that still apply

- AI steps run on workers like any job (runtime from the template's placeholder, container sandbox, the project's
  approval policy). The video render step needs `ffmpeg` in the container image of the worker that runs it.
- HTTP and e-mail nodes run on a worker as function jobs: the master never calls your APIs. LAN / private / metadata
  addresses are always refused; the project's **HTTP izin listesi** (Projeler → Politika) applies. Credentials are
  attached only to their bound hosts and redacted from results.
- Code nodes (lead score, SEO checks) run in a network-less container on workers with `function-code-v1`.
- E-mail needs TLS (STARTTLS or implicit TLS); the SMTP server comes from the provider preset.
- Approvals use the normal role + verification-code rule.

## 4. Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| Gallery says the engine is off | `WORKFLOW_ENGINE_V2` is not `true` on the master ([deploy-coolify.md](deploy-coolify.md)). |
| `credential_host_not_bound` on the check step | The vault credential is not bound to that host — re-create it with the host in İzinli adresler. |
| `egress_not_allowed` | The project's HTTP allowlist is on and the host is not listed. |
| 403 on Oluştur | Only project admins can save HTTP / e-mail / code nodes; ask an admin, or create it and let an admin save it. |
| A function node fails `no_worker` | No online worker with `function-v1` (`function-code-v1` for code) within the queue timeout. |
| Render step fails | The worker's container has no `ffmpeg`, or an asset URL was not downloadable. |
