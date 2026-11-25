# p22-github-raw: skill imports do not run out of GitHub's rate limit

**Problem.** On 2026-11-04 the assistant installed several skills from public GitHub repositories one after another.
The third card ended as "Taslak geçersiz (skill_import, 3 deneme): GitHub refused the request (rate limit) until
16:02". Two things went wrong:

- The importer read every file with its own REST API request (`/git/blobs/:sha`). Public repositories are read without
  credentials, and the unauthenticated REST API allows 60 requests per hour per IP. One skill of 30 files cost about
  35 requests.
- The chat tool turned the 429 into `invalid`. The assistant retried three times, and the conversation showed a refused
  card for what was a temporary wait.

**Fix.**

- **Files from the raw host.** File contents come from `https://raw.githubusercontent.com/<owner>/<repo>/<commit SHA>/<path>`,
  pinned to the commit the tree was read at. That host does not count against the REST API limit.
  - The bytes are still checked against the tree's git blob hash (`sha1("blob <len>\0" + bytes)`), so the raw host
    cannot change what is imported. A mismatch is refused as `github_integrity`.
  - Any other failure falls back to the API blob: a non-200 answer, a network error, or a size that differs from the
    tree.
  - Same rules as before: https only, `redirect: 'error'`, no cookies, 10 s per request.
  - A private repository, read with the panel GitHub App's token, keeps using the API blob.
  - The catalog listing reads each folder's SKILL.md the same way.
  - Effect: an import costs 3–5 REST requests (repository, commit, trees) instead of 3 + one per file.
- **Rate limit is temporary.** `propose_skill_install` answers `unavailable` for `github_rate_limited` and
  `github_unavailable`, not `invalid`.
  - No hidden refused draft and no "Taslak geçersiz" line are produced.
  - The message tells the assistant that this is temporary, not to retry before the reset time, to tell the user when
    it continues, and to go on then, one skill after another.

**Tests.**

- `apps/master/test/unit/skill-import.test.ts`: the raw host serves the files; a tampered raw file is refused; a failing
  raw host falls back to the API; private repositories use the API.
- `apps/master/test/integration/skill-catalog.test.ts` and `apps/master/test/integration/skill-import.test.ts`: the
  hosts read.
- `apps/master/test/integration/skill-catalog-chat.test.ts`: the rate limit gives no refused card.
