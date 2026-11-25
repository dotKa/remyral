# p22-site-coolify: a site upload goes live on Coolify from one card

**Problem.** "Bu zip'i coolify'da deploy et, sites.example.org'da bir subdomain'e bağla" took four tool chains and two
cards on 2026-11-04:

1. a copy job;
2. a project card;
3. a repository export;
4. a Coolify project, an application and a DNS record.

It stopped after the job and pushed the files twice. The owner: "bu başlı başına saçma. lokalde claude a söyleseydim
çoktan yapmıştı". Cloudflare Pages already had one card for this (`publish_site_upload`); Coolify had none.

## `publish_site_coolify`

The card is a `coolify_change` card with op `publish_site`.

- **Input.** `uploadId` (a ready site upload, `index.html` at its root) and `domain` (a subdomain of a zone the DNS
  integration sees). Optional:
  - `name`: the project, repository and application name; default: the domain's first label;
  - `project`: an existing repository project without a repository;
  - `private`: default true;
  - `proxied`: default true. Owner rule 2026-11-04: never create a record with the Cloudflare proxy off unless asked.
- **Checked when proposed.** The upload, the domain and its zone (not the apex), that the project id and the GitHub
  repository name are free, and the roles:
  - `projects.create` for a new project;
  - `integrations.github.write`;
  - `deploy.coolify.manage` for an existing project.
- **A new project waits.** A new project makes the card wait for the user (`propose`; projects are created only from a
  confirmed card). With an existing project it runs in the user's own turn.
- **Authenticator-code event.** `projects.policy` for a new project, else `integrations.connections`. The card creates
  a project and a repository, so the application's `deploy.coolify` alone would be too weak.

## Confirming runs the existing steps in order

Each step runs with its own checks and audit:

1. **Project.** A new project (kind repository) with the domain's zone allowed for DNS.
2. **Repository.** A private GitHub repository (auto-initialised), linked to the project.
3. **Files.** The upload's files as one commit on the base branch.
4. **Coolify project.** The Coolify project named like the project, created when missing. The only server must be the
   target. A private repository is read through the Coolify GitHub App of its organization, or else the only private
   one.
5. **Application.** A static application with `https://<domain>`, linked to production, with its first deploy.
6. **DNS.** `A <domain>` → the server's public IPv4 through `dns.upsert`. The project's deploy policy decides; it may
   wait for an approval.
7. **Watch.** A watch on the deploy whose next step checks the site and tells the user the link (p22-watch-next-step).

**Results and stopping.**

- The result lists every step that ran.
- At the first failure the chain stops with `stoppedAt` and the reason. The assistant fixes that step with its own
  tool and does not repeat the steps that ran.
- A server without a public IPv4 in Coolify stops at DNS and names `draft_dns_change`.

**Prompt.** Rules 2 and 34 tell the assistant to use this tool for Coolify and never to build the chain itself. The
tool reaches the model with worker 1.2.18.
