// A Credential_File-backed `SecretManagerPort`, re-read on every request so an operator who
// refreshes the key mid-run is picked up without a restart. The whole trimmed file is the
// credential, so there is no grammar to parse. See design.md of `formal-gate-first-light`, C14.

import { err, ok, type Result } from '@app/core';

import {
  providerCredentialRef,
  usableCredentialValue,
  type SecretManagerPort,
  type SecretResolutionError,
} from './secret-manager.js';

/**
 * UTF-8 contents of one file, or `null` where it cannot be read.
 *
 * Declared here rather than imported: this is the contract `CheckoutPort.readTextFile` already
 * uses, and `app/agent` holds no import of `app/eval`.
 */
export type ReadTextFile = (path: string) => Promise<string | null>;

/** The Credential_File, relative to the repository root. Excluded from version control. */
export const DEFAULT_CREDENTIAL_FILE = '.secrets/bedrock-token';

/** The one ref the Credential_File serves; every other ref is a clean absence. */
const CREDENTIAL_FILE_REF = providerCredentialRef('bedrock-mantle');

/** The only failure reported. Names the ref, which is a pointer, and never the file's contents. */
function notFound(ref: string): Result<string, SecretResolutionError> {
  return err({ code: 'SECRET_NOT_FOUND', reason: `no credential file value for ref ${ref}` });
}

/** What the provider needs: which file to read, and how to read it. */
export interface RefreshingSecretManagerDeps {
  /** The Credential_File path. May be named in a diagnostic; its contents may not. */
  readonly path: string;
  readonly readFile: ReadTextFile;
}

/**
 * A `SecretManagerPort` that resolves the credential from the Credential_File per request.
 *
 * It consults the file alone, with no environment fallback, so a run can always say which
 * source the value it used came from.
 */
export class RefreshingSecretManager implements SecretManagerPort {
  readonly #path: string;
  readonly #readFile: ReadTextFile;

  constructor(deps: RefreshingSecretManagerDeps) {
    this.#path = deps.path;
    this.#readFile = deps.readFile;
  }

  /**
   * Re-read the Credential_File and resolve it, or report a typed absence.
   *
   * The file is external input, so its contents go through the one shared predicate: an
   * unreadable or whitespace-only file counts as unset rather than as a blank credential.
   */
  async resolveSecret(ref: string): Promise<Result<string, SecretResolutionError>> {
    if (ref !== CREDENTIAL_FILE_REF) {
      return notFound(ref);
    }
    const value = usableCredentialValue(await this.#read());
    return value === null ? notFound(ref) : ok(value);
  }

  /** `null` for any file that cannot be read, including a reader that rejects (Req 7.16). */
  async #read(): Promise<string | null> {
    try {
      return await this.#readFile(this.#path);
    } catch {
      // The typed absence is the documented path for an unreadable file, and the rejection
      // itself is not surfaced, because it can quote the file.
      return null;
    }
  }
}
