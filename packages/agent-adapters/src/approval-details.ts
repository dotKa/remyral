import {
  type ApprovalDetails,
  type ApprovalShell,
  type ExtractOptions,
  extractApprovalDetails,
  hasApprovalDetails,
} from '@remyral/protocol/approval-details';
import { redactSecrets, type SecretEnv } from './secrets.js';

/**
 * p10-approval-readable (docs/design/p10-approval-readable.md §2): the `details` of an approval request, as every
 * adapter builds them. The tool input is parsed first; then each field is redacted with the job's secret values (the
 * whole field, before it is cut) and bounded on its own. Undefined when nothing beyond the tool name was found (the
 * master then shows `description` as before).
 */
export function runtimeApprovalDetails(
  tool: string,
  input: unknown,
  secrets: SecretEnv,
  opts: Omit<ExtractOptions, 'redact'> = {},
): ApprovalDetails | undefined {
  try {
    const d = extractApprovalDetails(tool, input, { ...opts, redact: (t) => redactSecrets(t, secrets) });
    return hasApprovalDetails(d) ? d : undefined;
  } catch {
    // A display aid: a reading problem must never block or change the approval request itself.
    return undefined;
  }
}

/** The shell of a runtime's shell tool, by name (`Bash`/`bash` → POSIX, `PowerShell`/`powershell`). */
export function shellOfTool(tool: string): ApprovalShell | undefined {
  const t = tool.toLowerCase();
  if (t === 'bash' || t === 'sh') return 'posix';
  if (t === 'powershell' || t === 'pwsh') return 'powershell';
  return undefined;
}
