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
//   "the credential is missing" is a diagnosis; "put the token in .secrets/bedrock-token"
//   is an instruction. The operator is at a terminal at the moment they read this, so each
//   message ends with the command, the path, or the variable name that resolves it.
//
// PRESENCE IS NOT ACCEPTANCE
//   A resolvable credential can still be one the provider refuses. The pilot's first run
//   held a present and expired key: preflight passed, and all six samples then recorded
//   `provider-unreachable`, which says the network failed when the provider had answered
//   and refused. Only a call tells the two apart, so the credential check makes one.
//
// THE CREDENTIAL IS READ THROUGH THE PORT, AND REACHES EXACTLY ONE CALL
//   It is resolved by asking the injected `SecretManagerPort`, which is the SAME instance
//   every transport resolves through, so the probe cannot accept a credential no request
//   will ever send. The value is handed straight to the model-list call and goes nowhere
//   else: not into a return value, a log, a message, or a comparison. The Credential_File
//   PATH may be named in a message; its contents may not.

import type { SecretManagerPort } from '@app/agent';
import { providerCredentialRef, BEDROCK_CREDENTIAL_ENV_KEY } from '@app/agent';

/** The provider every arm of a bake-off is served from. */
const SWEEP_PROVIDER = 'bedrock-mantle';

/** Lowest HTTP status that counts as the provider accepting the credential. */
const HTTP_OK = 200;

/** First HTTP status that is no longer an acceptance. */
const HTTP_REDIRECT = 300;

/** The two statuses that mean the provider read the credential and rejected it. */
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** Which preflight condition failed; each maps to exactly one operator action. */
export type PreflightFailureCode =
  | 'credential-missing'
  | 'credential-refused'
  | 'provider-unreachable'
  | 'corpus-missing'
  | 'toolchain-missing'
  | 'config-invalid'
  | 'selection-empty'
  | 'campaign-mismatch'
  | 'campaign-resume-limit'
  // The Campaign's host must honour the Default_Timescale_Entry, or every `#` delay in every
  // model-written testbench runs in the wrong unit (testbench-spec-grounding, Req 10.10).
  | 'default-timescale-not-honored'
  // The Replay_Gate must have passed on THIS build's harness constants (Req 6.8).
  | 'replay-gate-not-passed'
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
 * What one authenticated model-list call answered, reduced to what preflight reads.
 *
 * A status and nothing else: the reply body is the provider's, it can echo the credential
 * back, and no decision here needs a field out of it.
 */
export type ModelListAnswer =
  { readonly kind: 'reply'; readonly status: number } | { readonly kind: 'unreachable' };

/**
 * Makes one minimal authenticated model-list call against the provider.
 *
 * A list call rather than a one-token completion: it establishes acceptance without
 * generating, so nothing in preflight is measurable. `cli.ts` builds the real one over the
 * host `fetch`; a test supplies a fixed answer.
 */
export interface ModelListProbePort {
  (credential: string): Promise<ModelListAnswer>;
}

/** What the credential probe needs: the one source, the path to name, and the call. */
export interface CredentialProbeDeps {
  /** The one provider every transport resolves through, so both read the same source. */
  readonly secretManager: SecretManagerPort;
  /** The Credential_File path. It may be named in a message; its contents may not. */
  readonly credentialFilePath: string;
  readonly modelList: ModelListProbePort;
}

/**
 * Whether the provider ACCEPTS the sweep's credential, which is what a run depends on.
 *
 * Three outcomes, and only the first admits a run: accepted, refused by the provider, or
 * the provider never answered. A refusal and an unreachable provider are different
 * operator actions - refresh the token, or fix the network - so they are different codes
 * rather than one "credential problem".
 *
 * A credential that does not resolve costs no call: there is nothing to authenticate with,
 * and that case is reported before the network is touched.
 */
export async function checkCredential(deps: CredentialProbeDeps): Promise<PreflightFailure | null> {
  const resolved = await deps.secretManager.resolveSecret(providerCredentialRef(SWEEP_PROVIDER));
  if (!resolved.ok) {
    return preflightFailure(
      'credential-missing',
      `no ${SWEEP_PROVIDER} credential is available, so every model call would fail`,
      `put the ${BEDROCK_CREDENTIAL_ENV_KEY} token in ${deps.credentialFilePath} and re-run; the file's whole trimmed contents are the credential, no environment variable is consulted, and it never belongs in the sweep config`,
    );
  }
  // The value is passed, never bound: this expression is the only place it appears.
  return classifyAcceptance(await deps.modelList(resolved.value), deps.credentialFilePath);
}

/** Turn the provider's answer into the one preflight outcome it means. */
function classifyAcceptance(
  answer: ModelListAnswer,
  credentialFilePath: string,
): PreflightFailure | null {
  if (answer.kind === 'unreachable') {
    return preflightFailure(
      'provider-unreachable',
      `the ${SWEEP_PROVIDER} endpoint did not answer the credential check, so no sample could reach a model`,
      'restore network access to the provider endpoint, confirm modelHost.region, and re-run',
    );
  }
  if (answer.status >= HTTP_OK && answer.status < HTTP_REDIRECT) {
    return null;
  }
  if (answer.status === HTTP_UNAUTHORIZED || answer.status === HTTP_FORBIDDEN) {
    return preflightFailure(
      'credential-refused',
      `the ${SWEEP_PROVIDER} provider refused the credential (HTTP ${answer.status}), so every model call would fail; a present credential is not an accepted one`,
      `replace the credential in ${credentialFilePath} with a fresh one and re-run; the file's whole contents are the token`,
    );
  }
  return preflightFailure(
    'provider-unreachable',
    `the ${SWEEP_PROVIDER} provider answered the credential check with HTTP ${answer.status}, which is neither an acceptance nor a refusal, so a run could not be trusted to reach a model`,
    'check the provider endpoint and modelHost.region, then re-run',
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

/**
 * Probes whether the COMPOSED formal invocation runs on this host; `host-facts.ts`'s
 * `probeFormalToolchainAvailability` satisfies this, and a test supplies a fixed answer.
 */
export interface FormalToolchainProbePort {
  (): { readonly available: boolean; readonly reason: string };
}

/**
 * Whether a run that enables the FORMAL_GATE may start at all (Req 11.18).
 *
 * THE REFUSAL PRECEDES THE GATE ENTIRELY, and that placement is the point. Running anyway
 * would record `could-not-verify` with `toolchain-unavailable` on every property of every
 * sample, and a wall of those is indistinguishable - from the record alone - from a
 * measurement of the designs. Refusing before the first sample means NO Formal_Verdict is
 * recorded for the run rather than a worthless one for all of it.
 *
 * It leaves Acceptance Criteria 11.7 and 11.15 standing unchanged: those cover a toolchain
 * that became unavailable AFTER the run was admitted, which is a per-sample verdict the
 * Formal_Oracle still owns. The two rules cover different moments and neither replaces the
 * other.
 *
 * A run with the gate DISABLED is admitted whatever the probe would say, because nothing in
 * it invokes the Formal_Oracle - which is also why the probe is only paid for when the gate
 * is on, and why `enabled` is checked before `probe` is called rather than after.
 */
export function checkFormalToolchain(
  enabled: boolean,
  probe: FormalToolchainProbePort,
): PreflightFailure | null {
  if (!enabled) {
    return null;
  }
  const formal = probe();
  if (formal.available) {
    return null;
  }
  return preflightFailure(
    'toolchain-missing',
    `this config enables the formal gate, but the composed yosys-smtbmc invocation cannot run on this host (${formal.reason}), so every proof attempt would report toolchain-unavailable and no sample would measure a design`,
    'install yosys + yosys-smtbmc + bitwuzla + z3 and make `yosys-smtbmc -s bitwuzla` report `Status: PASSED` on a trivial SMT2 file (bitwuzla 0.9.x rejects the `--smt2` and `-i` flags smtio.py passes it), or set `"formalGateEnabled": false` to measure with the simulation oracle alone',
  );
}

/** Render a preflight failure as the two lines the operator reads. */
export function renderPreflightFailure(failure: PreflightFailure): readonly string[] {
  return [`eval sweep refused to start: ${failure.problem}`, `fix: ${failure.fix}`];
}

/**
 * Whether a committed Replay_Gate report clears the Campaign to start (Req 6.8).
 *
 * The report is UNTRUSTED input: it is a file on disk written by an earlier process, so every
 * field is checked rather than read. The constants must equal the RUNNING build's, because a
 * report taken under another harness says nothing about the one about to run. Returns the
 * reasons, so the refusal names every failing field rather than the first.
 */
export function replayGateRefusals(
  raw: unknown,
  build: {
    readonly simulationHarnessVersion: number;
    readonly normalizerVersion: number;
    readonly watchdogBudgetNs: number;
    readonly dumpLimitBytes: number;
  },
): readonly string[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return ['the Replay_Gate report is not an object'];
  }
  const report = raw as Record<string, unknown>;
  const reasons: string[] = [];
  if (report.passed !== true) {
    reasons.push('the Replay_Gate report does not say passed');
  }
  // Refused on the list itself: a hand-edited report can claim `passed` beside it (Req 3.6).
  if (!Array.isArray(report.verdictChanges) || report.verdictChanges.length > 0) {
    reasons.push(verdictChangesReason(report.verdictChanges));
  }
  for (const [field, expected] of Object.entries(build)) {
    if (report[field] !== expected) {
      reasons.push(
        `the report's ${field} is ${JSON.stringify(report[field])}, and this build is ${String(expected)}`,
      );
    }
  }
  return reasons;
}

/** Why a report's `verdictChanges` fails the gate: absent or not a list, or its count. */
function verdictChangesReason(verdictChanges: unknown): string {
  if (!Array.isArray(verdictChanges)) {
    return "the Replay_Gate report's verdictChanges is not a list";
  }
  return `the Replay_Gate report records ${verdictChanges.length} verdict change(s), and a passing gate records 0`;
}
