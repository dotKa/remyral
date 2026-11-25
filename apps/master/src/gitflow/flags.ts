import type { FileChange } from './types.js';

/**
 * Review flags for changed paths (threat model T-INJ-3: an injected change to CI configuration or a new
 * dependency is the classic way to smuggle code into a protected branch). Flags never block a merge on
 * their own; they are shown prominently in the Changes panel and the merge approval summary.
 */
export type FlagKind = 'ci_config' | 'dependency_manifest' | 'repository_policy' | 'executable_hook';

export interface PathFlag {
  readonly path: string;
  readonly kind: FlagKind;
}

const RULES: readonly (readonly [RegExp, FlagKind])[] = [
  [/^\.github\/(workflows|actions)\//, 'ci_config'],
  [/(^|\/)\.gitlab-ci\.ya?ml$/, 'ci_config'],
  [/(^|\/)(Jenkinsfile|azure-pipelines\.ya?ml|\.travis\.ya?ml|bitbucket-pipelines\.ya?ml)$/, 'ci_config'],
  [/^\.circleci\//, 'ci_config'],
  [/^\.buildkite\//, 'ci_config'],
  [
    /(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|yarn\.lock|\.npmrc|\.yarnrc(\.yml)?|bun\.lockb?)$/,
    'dependency_manifest',
  ],
  [
    /(^|\/)(requirements[^/]*\.txt|Pipfile(\.lock)?|pyproject\.toml|poetry\.lock|uv\.lock|setup\.py|setup\.cfg)$/,
    'dependency_manifest',
  ],
  [
    /(^|\/)(go\.mod|go\.sum|Cargo\.toml|Cargo\.lock|Gemfile(\.lock)?|composer\.(json|lock))$/,
    'dependency_manifest',
  ],
  [
    /(^|\/)(pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|gradle\.properties)$/,
    'dependency_manifest',
  ],
  [/(^|\/)(Dockerfile[^/]*|docker-compose[^/]*\.ya?ml|compose\.ya?ml)$/, 'dependency_manifest'],
  [/(^|\/)(AGENTS\.md|CLAUDE\.md|CODEOWNERS|\.gitattributes|\.gitmodules)$/, 'repository_policy'],
  [/^\.github\/(CODEOWNERS|dependabot\.ya?ml)$/, 'repository_policy'],
  [/(^|\/)(\.husky\/|\.githooks\/|\.pre-commit-config\.ya?ml$|lefthook\.ya?ml$)/, 'executable_hook'],
];

export function flagPaths(files: readonly Pick<FileChange, 'path' | 'previousPath'>[]): PathFlag[] {
  const out: PathFlag[] = [];
  const seen = new Set<string>();
  for (const f of files) {
    for (const path of [f.path, f.previousPath].filter((p): p is string => p !== undefined)) {
      for (const [re, kind] of RULES) {
        const key = `${kind}\u0000${path}`;
        if (re.test(path) && !seen.has(key)) {
          seen.add(key);
          out.push({ path, kind });
        }
      }
    }
  }
  return out;
}
