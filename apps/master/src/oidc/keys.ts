import { createHash, createPrivateKey, createPublicKey, type KeyObject, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';

/**
 * The ID-token signing key (docs/design/p5-coolify-sso.md §2): RSA, RS256 — the only algorithm Coolify's
 * OIDC client accepts — with `kid` = RFC 7638 JWK thumbprint of the public key.
 */
export interface PublicJwk {
  readonly kty: 'RSA';
  readonly n: string;
  readonly e: string;
  readonly kid: string;
  readonly alg: 'RS256';
  readonly use: 'sig';
}

export class SigningKeyError extends Error {
  override name = 'SigningKeyError';
}

export class SigningKey {
  readonly kid: string;
  readonly jwk: PublicJwk;
  readonly #private: KeyObject;

  constructor(privateKey: KeyObject) {
    if (privateKey.type !== 'private' || privateKey.asymmetricKeyType !== 'rsa') {
      throw new SigningKeyError('OIDC signing key must be an RSA private key');
    }
    const bits = privateKey.asymmetricKeyDetails?.modulusLength ?? 0;
    if (bits < 2048) throw new SigningKeyError('OIDC signing key must have at least 2048 bits');
    this.#private = privateKey;
    const pub = createPublicKey(privateKey).export({ format: 'jwk' });
    if (typeof pub.n !== 'string' || typeof pub.e !== 'string') {
      throw new SigningKeyError('cannot export the public key');
    }
    this.kid = jwkThumbprint({ kty: 'RSA', n: pub.n, e: pub.e });
    this.jwk = { kty: 'RSA', n: pub.n, e: pub.e, kid: this.kid, alg: 'RS256', use: 'sig' };
  }

  /** Reads a PEM private key file. Never logs the content. */
  static async fromFile(path: string): Promise<SigningKey> {
    let pem: string;
    try {
      pem = await readFile(path, 'utf8');
    } catch (err) {
      throw new SigningKeyError(
        `cannot read OIDC_SIGNING_KEY_FILE: ${(err as NodeJS.ErrnoException).code ?? 'error'}`,
      );
    }
    try {
      return new SigningKey(createPrivateKey(pem));
    } catch (err) {
      if (err instanceof SigningKeyError) throw err;
      throw new SigningKeyError('OIDC_SIGNING_KEY_FILE does not contain a readable private key');
    }
  }

  /** A compact JWS (RS256) over `claims`. */
  signJwt(claims: Readonly<Record<string, unknown>>): string {
    const header = b64json({ alg: 'RS256', kid: this.kid, typ: 'JWT' });
    const body = b64json(claims);
    const input = `${header}.${body}`;
    const signature = sign('sha256', Buffer.from(input, 'ascii'), this.#private).toString('base64url');
    return `${input}.${signature}`;
  }
}

function b64json(value: unknown): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** RFC 7638 §3: SHA-256 over the required members in lexicographic order, base64url. */
export function jwkThumbprint(jwk: { readonly kty: 'RSA'; readonly n: string; readonly e: string }): string {
  const canonical = `{"e":"${jwk.e}","kty":"RSA","n":"${jwk.n}"}`;
  return createHash('sha256').update(canonical, 'utf8').digest('base64url');
}

/** OIDC Core §3.1.3.6 at_hash for RS256: base64url of the left half of SHA-256(access token). */
export function atHash(accessToken: string): string {
  const digest = createHash('sha256').update(accessToken, 'ascii').digest();
  return digest.subarray(0, digest.length / 2).toString('base64url');
}
