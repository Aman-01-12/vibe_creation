// PREFLIGHT: everything that must be true before the sweep is allowed to spend money.
//
// THE RULE THIS MODULE ENFORCES
//   Never start a run that cannot produce a real verdict, and never silently substitute a
//   fake for a missing dependency. A sweep whose credential is absent, whose corpus is not
//   checked out, or whose EDA toolchain is missing would either fail every sample or -
//   far worse - appear to run while measuring nothing. Both outcomes waste an overnight
//   window; the second also produces numbers that look real.
//
// EVERY FAILURE NAMES ITS FIX
//   "the credential is missing" is a diagnosis; "set AWS_BEARER_TOKEN_BEDROCK in .env" is
//   an instruction. The operator is at a terminal at the moment they read this, so each
//   message ends with the command or the variable name that resolves it.
//
// THE CREDENTIAL IS CHECKED THROUGH THE PORT, NEVER READ HERE
//   Presence is established by asking the injected `SecretManagerPort` to resolve the
//   provider's credential ref and looking only at whether it succeeded. The VALUE is
//   never bound to a variable, logged, echoed, measured, or compared. The env-backed
//   manager remains the only reader of the process environment.

import type { SecretManagerPort } from '@app/agent';
import { providerCredentialRef, BEDROCK_CREDENTIAL_ENV_KEY } from '@app/agent';

/** The provider every arm of a bake-off is served from. */
const SWEEP_PROVIDER = 'bedrock-mantle';

/** Which preflight condition failed; each maps to exactly one operator action. */
export type PreflightFailureCode =
  | 'credential-missing'
  | 'corpus-missing'
  | 'toolchain-missing'
  | 'config-invalid'
  | 'selection-empty'
  | 'output-unwritable';

/** One preflight failure: what is wrong, and the command or variable that fixes it. */
export interface PreflightFailure {
  readonly code: PreflightFailureCode;
  readonly problem: string;
  readonly fix: string;
}

/** Build a preflight failure. */
export function preflightFailure(
  code: PreflightFailureCode,
  problem: string,
  fix: string,
): PreflightFailure {
  return { code, problem, fix };
}

/**
 * Whether the bedrock-mantle credential is resolvable, without reading its value.
 *
 * Returns a failure naming the environment variable and the file it belongs in. The
 * resolved secret is deliberately discarded on the same line it is obtained.
 */
export async function checkCredential(
  secretManager: SecretManagerPort,
): Promise<PreflightFailure | null> {
  const resolved = await secretManager.resolveSecret(providerCredentialRef(SWEEP_PROVIDER));
  if (resolved.ok) {
    return null;
  }
  return preflightFailure(
    'credential-missing',
    `no ${SWEEP_PROVIDER} credential is available, so every model call would fail`,
    `set ${BEDROCK_CREDENTIAL_ENV_KEY} in your .env (see .env.example) and re-run; never put it in the sweep config`,
  );
}

/** Probes whether the corpus checkout is present; the fetch module's port satisfies this. */
export interface CheckoutPresencePort {
  inspect(path: string): Promise<'absent' | 'non-repository' | 'git-repository'>;
}

/**
 * Whether the pinned RTLLM checkout is present.
 *
 * A non-repository directory is treated as missing too: the fetch verifies the pinned
 * commit, and a hand-copied tree has no verifiable provenance, so scoring against it
 * would silently invalidate the numbers.
 */
export async function checkCorpus(
  probe: CheckoutPresencePort,
  checkoutPath: string,
): Promise<PreflightFailure | null> {
  const presence = await probe.inspect(checkoutPath);
  if (presence === 'git-repository') {
    return null;
  }
  return preflightFailure(
    'corpus-missing',
    presence === 'absent'
      ? 'the pinned RTLLM corpus checkout is missing, so there are no problems to run'
      : 'the RTLLM corpus path is not a verified git checkout, so its provenance cannot be confirmed',
    'run `npm run corpus:fetch` to fetch and verify the pinned commit, then re-run',
  );
}

/** Turn an unavailable toolchain into an actionable preflight failure. */
export function toolchainFailure(reason: string): PreflightFailure {
  return preflightFailure(
    'toolchain-missing',
    `the real EDA toolchain is not usable on this host (${reason}), so no sample could get an oracle verdict`,
    'install iverilog + vvp and make a Python interpreter available that can import the sandbox worker (see dev-tooling.md), then re-run',
  );
}

/** Render a preflight failure as the two lines the operator reads. */
export function renderPreflightFailure(failure: PreflightFailure): readonly string[] {
  return [`eval sweep refused to start: ${failure.problem}`, `fix: ${failure.fix}`];
}
