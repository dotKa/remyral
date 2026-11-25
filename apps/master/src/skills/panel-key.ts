import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import {
  type McpSpecInput,
  packMcpSpec,
  packSkillBundle,
  type RuntimeKind,
  type SignedMcpSpec,
  type McpSpec,
  type SignedSkillBundle,
  skillKeyId,
} from '@remyral/protocol';

/**
 * The panel-held skills key (p5-machine-admin, ADR-0021): an Ed25519 key the master holds to sign skills that an
 * administrator confirms in the ops chat. Separate from the owner's offline skills key (which stays primary and the
 * backup), from the lease key and from the release key. Generated on the host like the OIDC key:
 *
 *   sudo sh -c 'umask 077; openssl genpkey -algorithm ed25519 -out skills-panel.pem'
 *
 * and named by SKILLS_PANEL_KEY_FILE. Workers learn its public key only through their signed managed configuration
 * (`panelSkillKeys`), and a machine can refuse it locally (`localCeiling.allowPanelSkills: false`).
 */
export class PanelKeyError extends Error {
  override name = 'PanelKeyError';
}

export class PanelSkillsKey {
  readonly #privateKey: KeyObject;
  /** Raw Ed25519 public key, base64url (the format of SKILLS_PUBLIC_KEYS and `skills.publicKeys`). */
  readonly publicKey: string;
  /** skillKeyId of the public key (first 16 hex of SHA-256). */
  readonly keyId: string;

  constructor(privateKey: KeyObject) {
    if (privateKey.asymmetricKeyType !== 'ed25519' || privateKey.type !== 'private') {
      throw new PanelKeyError('the panel skills key must be an Ed25519 private key');
    }
    this.#privateKey = privateKey;
    this.publicKey = String(createPublicKey(privateKey).export({ format: 'jwk' }).x);
    this.keyId = skillKeyId(this.publicKey);
  }

  /** Reads a PEM file (not readable by group/others). Never logs the content. */
  static async fromFile(path: string): Promise<PanelSkillsKey> {
    let pem: string;
    try {
      const st = await stat(path);
      if (process.platform !== 'win32' && (st.mode & 0o077) !== 0) {
        throw new PanelKeyError('SKILLS_PANEL_KEY_FILE must not be readable by group/others (chmod 600)');
      }
      pem = await readFile(path, 'utf8');
    } catch (err) {
      if (err instanceof PanelKeyError) throw err;
      throw new PanelKeyError(
        `cannot read SKILLS_PANEL_KEY_FILE: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    try {
      return new PanelSkillsKey(createPrivateKey(pem));
    } catch (err) {
      if (err instanceof PanelKeyError) throw err;
      throw new PanelKeyError('SKILLS_PANEL_KEY_FILE does not contain an Ed25519 private key');
    }
  }

  pack(input: {
    readonly id: string;
    readonly title: string;
    readonly version: string;
    readonly description: string;
    readonly runtimes: readonly RuntimeKind[];
    readonly files: Readonly<Record<string, string>>;
    readonly createdAt: string;
  }): { readonly bundle: SignedSkillBundle; readonly manifestSha256: string } {
    return packSkillBundle(input, this.#privateKey, this.publicKey);
  }

  /**
   * p14-mcp-core (ADR-0054): signs an MCP server spec after an admin's always-fresh confirmation — same key, its own
   * context (`remana-mcp/v1\n`), so a skill signature never verifies as an MCP spec and vice versa.
   */
  packMcp(input: McpSpecInput): {
    readonly signed: SignedMcpSpec;
    readonly spec: McpSpec;
    readonly specSha256: string;
  } {
    return packMcpSpec(input, this.#privateKey, this.publicKey);
  }

  toJSON(): unknown {
    return { keyId: this.keyId };
  }
}
