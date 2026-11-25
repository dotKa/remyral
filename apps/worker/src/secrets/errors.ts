/** Secret errors never carry secret values — only names, references and reasons. */
export class SecretError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SecretError';
  }
}

export class InvalidSecretNameError extends SecretError {
  constructor(readonly secretName: string) {
    super(
      `invalid secret name ${JSON.stringify(secretName.slice(0, 80))}: use 1-64 characters of [A-Za-z0-9_-], starting with a letter or digit`,
    );
    this.name = 'InvalidSecretNameError';
  }
}

export class InvalidSecretRefError extends SecretError {
  constructor(reason: string) {
    super(`invalid secret reference: ${reason}`);
    this.name = 'InvalidSecretRefError';
  }
}

/** A reference to another worker's secret (`worker:<other>/secret:…`): values never cross workers. */
export class ForeignSecretRefError extends SecretError {
  constructor(
    readonly ref: string,
    readonly workerId: string | null,
  ) {
    super(
      workerId === null
        ? `secret reference ${ref} names a worker, but this worker is not enrolled yet`
        : `secret reference ${ref} belongs to another worker (this worker is ${workerId})`,
    );
    this.name = 'ForeignSecretRefError';
  }
}

export class SecretNotFoundError extends SecretError {
  constructor(
    readonly secretName: string,
    location: string,
  ) {
    super(
      `secret "${secretName}" is not stored in ${location} (add it with: remyral-worker secret set ${secretName})`,
    );
    this.name = 'SecretNotFoundError';
  }
}

export class InvalidSecretValueError extends SecretError {
  constructor(reason: string) {
    super(`invalid secret value: ${reason}`);
    this.name = 'InvalidSecretValueError';
  }
}

export class SecretStoreUnavailableError extends SecretError {
  constructor(
    readonly kind: string,
    reason: string,
  ) {
    super(`secret store "${kind}" is unavailable: ${reason}`);
    this.name = 'SecretStoreUnavailableError';
  }
}

/** The backing store (file, Keychain, DPAPI) failed; `detail` never contains the value. */
export class SecretStoreError extends SecretError {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'SecretStoreError';
  }
}

/** Env builder refusals: a passthrough variable that looks secret, a forbidden injection target, ... */
export class JobEnvError extends SecretError {
  constructor(message: string) {
    super(message);
    this.name = 'JobEnvError';
  }
}
