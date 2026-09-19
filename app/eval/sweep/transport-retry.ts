// TRANSPORT-level retry with backoff + jitter, behind a three-state circuit breaker.
//
// ============================================================================
// A RETRY HERE IS NOT A SECOND SAMPLE. READ THIS BEFORE CHANGING ANYTHING.
// ============================================================================
//   pass@k is estimated from n INDEPENDENT samples per problem, of which c passed.
//   Its whole meaning rests on each sample being one attempt at the problem. If a
//   "retry" ever re-ran a sample - re-prompted the model, re-drove the loop, drew a
//   second candidate - then a sample that failed would get extra chances, c would
//   rise, and pass@k would be silently inflated in the flattering direction with no
//   trace in the report. That is the most dangerous defect this module could contain.
//
//   So the retry lives at the LOWEST possible layer: the `JsonHttpPort`, beneath the
//   provider transport, beneath the Model_Router, beneath the agents, beneath the
//   Verification_Loop, beneath the harness. At that layer a retry means exactly one
//   thing: "the same HTTP request did not reach a responding endpoint, so send those
//   same bytes again". The body is byte-identical, seed and temperature included, so
//   the model is asked the same question once - the network just needed two tries to
//   ask it.
//
//   The distinction in one line:
//     transport retry  -> the same question, asked again because the wire failed.
//     re-sampling      -> a different answer, requested because we disliked the
//                         first. NEVER DONE HERE, and if it ever is, pass@k is a lie.
//
//   Consequences accepted on purpose:
//     - A model that returns a refusal, an unparseable reply, or a wrong answer is
//       NOT retried. That is the model failing the task, which is the measurement.
//     - HTTP 4xx other than 429 is NOT retried. A malformed request or a rejected
//       credential is our fault or a config fault, and hammering it would turn a
//       fast, diagnosable failure into a slow one.
//     - Only 429 and the 5xx class retry, plus a transport rejection (DNS, TLS,
//       reset, socket timeout): the provider or the network failing to answer, rather
//       than answering badly.
//
// WHY A CIRCUIT BREAKER TOO
//   A hosted endpoint that goes down stays down for minutes. Without a breaker the
//   matrix grinds through every remaining sample, spends the retry budget on each,
//   and converts a 20-minute outage into a run where every arm scores zero - a result
//   indistinguishable from every model being bad. The breaker turns a sustained
//   outage into a clean stop with the completed samples intact, which is honest.
//
//   Three states, per the resilience standard: CLOSED (calls flow), OPEN (calls fail
//   immediately, no socket opened), HALF-OPEN (after the cooldown, exactly one trial
//   call decides). Trips without an intervening success are counted, and at the
//   configured limit the breaker reports a sustained OUTAGE, which the sweep runner
//   reads as "stop dispatching new samples".
//
// EVERYTHING IS INJECTED
//   The clock, the sleep, and the randomness are injected, so the backoff bounds and
//   the breaker state machine are unit-tested with no real time, no real entropy, and
//   no network.

import type { JsonHttpPort, JsonHttpRequest, JsonHttpResponse } from '@app/agent';

import type { ThrottleGovernor } from './throttle-governor.js';

/** Lowest HTTP status treated as a successful reply by the retry decision. */
const HTTP_OK = 200;

/** First HTTP status past the success range. */
const HTTP_REDIRECT = 300;

/** The one 4xx status meaning "ask again later" rather than "you asked wrong". */
const HTTP_TOO_MANY_REQUESTS = 429;

/** First HTTP status in the server-error class. */
const HTTP_SERVER_ERROR = 500;

/** The retry and breaker knobs for one sweep run; validated at the config boundary. */
export interface TransportRetryPolicy {
  /**
   * Total attempts allowed for ONE HTTP request, including the first.
   *
   * `1` disables retrying. This counts attempts for the same bytes on the wire, never
   * sampling attempts (see the module header).
   */
  readonly maxAttempts: number;
  /** Delay before the second attempt, in milliseconds; doubles per attempt after. */
  readonly baseDelayMs: number;
  /** Ceiling the doubling backoff is clamped to, in milliseconds. */
  readonly maxDelayMs: number;
  /**
   * Fraction of the computed delay randomized away, in [0, 1].
   *
   * Jitter matters because the sweep runs several samples concurrently: without it
   * every one of them retries on the same schedule after a shared 429 and re-creates
   * the burst that caused it.
   */
  readonly jitterRatio: number;
  /** Consecutive retryable failures that trip the breaker from CLOSED to OPEN. */
  readonly breakerFailureThreshold: number;
  /** How long the breaker stays OPEN before admitting one trial call, in ms. */
  readonly breakerCooldownMs: number;
  /** Trips without an intervening success that mean a sustained provider outage. */
  readonly breakerMaxTrips: number;
}

/** The conservative defaults a config may omit; chosen for a rate-limited host. */
export const DEFAULT_TRANSPORT_RETRY_POLICY: TransportRetryPolicy = Object.freeze({
  maxAttempts: 4,
  baseDelayMs: 1_000,
  maxDelayMs: 30_000,
  jitterRatio: 0.5,
  breakerFailureThreshold: 8,
  breakerCooldownMs: 60_000,
  breakerMaxTrips: 3,
});

/** The breaker's three states. */
export type CircuitState = 'closed' | 'open' | 'half-open';

/** Why one attempt is or is not worth repeating. */
export type AttemptClassification =
  /** A reply arrived and the endpoint answered; the caller owns it, good or bad. */
  | 'answered'
  /** The endpoint declined to answer transiently; the same bytes may be resent. */
  | 'retryable'
  /** The endpoint refused in a way we must not hammer (4xx other than 429). */
  | 'terminal';

/**
 * Classify one HTTP status for the retry decision (pure).
 *
 * 2xx is answered. 429 and any 5xx are retryable. Everything else - a 4xx, or a 3xx
 * the port already refuses to follow - is terminal, because repeating it cannot change
 * the answer and would only delay a diagnosable failure.
 */
export function classifyStatus(status: number): AttemptClassification {
  if (status >= HTTP_OK && status < HTTP_REDIRECT) {
    return 'answered';
  }
  if (status === HTTP_TOO_MANY_REQUESTS || status >= HTTP_SERVER_ERROR) {
    return 'retryable';
  }
  return 'terminal';
}

/** Clamp a value into [0, 1], so a hostile ratio or random source cannot escape it. */
function clampUnit(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.min(1, Math.max(0, value));
}

/**
 * The delay before the next attempt, with jitter applied (pure).
 *
 * `attempt` is 1-based and names the attempt that just FAILED, so the first backoff
 * is `baseDelayMs`. The exponential term is clamped to `maxDelayMs` BEFORE jitter, so
 * the result always lies in `[capped * (1 - jitterRatio), capped]` - the invariant the
 * tests pin down. `random` is injected and must yield [0, 1).
 */
export function backoffDelayMs(
  policy: TransportRetryPolicy,
  attempt: number,
  random: () => number,
): number {
  const exponent = Math.max(0, attempt - 1);
  const capped = Math.min(policy.maxDelayMs, policy.baseDelayMs * Math.pow(2, exponent));
  const removed = capped * clampUnit(policy.jitterRatio) * clampUnit(random());
  return Math.max(0, capped - removed);
}

/**
 * A three-state circuit breaker over one sweep run's transport failures.
 *
 * Sole owner of its own state, mutated only through `admitCall` / `recordSuccess` /
 * `recordFailure`. `state()` and `outage()` are DERIVED from that state rather than
 * stored alongside it, so the two can never disagree.
 */
export class TransportCircuitBreaker {
  readonly #policy: TransportRetryPolicy;
  readonly #now: () => number;
  #consecutiveFailures = 0;
  #consecutiveTrips = 0;
  #openedAtMs: number | null = null;
  #trialInFlight = false;

  constructor(policy: TransportRetryPolicy, now: () => number) {
    this.#policy = policy;
    this.#now = now;
  }

  /** The current state, derived from the failure count and the cooldown clock. */
  state(): CircuitState {
    if (this.#openedAtMs === null) {
      return 'closed';
    }
    return this.#now() - this.#openedAtMs < this.#policy.breakerCooldownMs ? 'open' : 'half-open';
  }

  /**
   * Whether the provider looks sustainedly down.
   *
   * True once the breaker has tripped `breakerMaxTrips` times with no successful call
   * in between. The sweep runner reads this at a sample boundary and stops
   * dispatching, so an outage ends the run cleanly instead of filling the matrix with
   * failures that would read as bad models.
   */
  outage(): boolean {
    return this.#consecutiveTrips >= this.#policy.breakerMaxTrips;
  }

  /**
   * Reserve permission to make one call.
   *
   * This MUTATES: HALF-OPEN admits exactly one trial call and reserves that slot, so
   * concurrent callers do not all rush a recovering endpoint. Every `true` must be
   * followed by exactly one `recordSuccess` or `recordFailure`.
   */
  admitCall(): boolean {
    const state = this.state();
    if (state === 'open') {
      return false;
    }
    if (state === 'closed') {
      return true;
    }
    if (this.#trialInFlight) {
      return false;
    }
    this.#trialInFlight = true;
    return true;
  }

  /** Record a call that reached a responding endpoint: the breaker fully resets. */
  recordSuccess(): void {
    this.#consecutiveFailures = 0;
    this.#consecutiveTrips = 0;
    this.#openedAtMs = null;
    this.#trialInFlight = false;
  }

  /** Record a retryable transport failure, tripping the breaker at the threshold. */
  recordFailure(): void {
    this.#trialInFlight = false;
    this.#consecutiveFailures += 1;
    if (this.#consecutiveFailures < this.#policy.breakerFailureThreshold) {
      return;
    }
    this.#consecutiveFailures = 0;
    this.#consecutiveTrips += 1;
    this.#openedAtMs = this.#now();
  }
}

/**
 * The error the retrying port rejects with when the breaker refused the call.
 *
 * Carries a classification only - no URL, host, header, or underlying error - so the
 * transport above classifies it as an unreachable provider exactly as it would a
 * socket failure, and nothing about the endpoint escapes into a log or a record.
 */
export class TransportCircuitOpenError extends Error {
  constructor() {
    super('transport circuit breaker is open');
    this.name = 'TransportCircuitOpenError';
  }
}

/** The collaborators the retrying port needs; no globals, all injected. */
export interface TransportRetryDeps {
  readonly policy: TransportRetryPolicy;
  /** The breaker shared by every call in the run, so an outage is seen run-wide. */
  readonly breaker: TransportCircuitBreaker;
  /**
   * The throttler shared by every call in the run, so a burst seen on one arm slows
   * every other arm sharing this port too. Sibling of `breaker`, not a layer above or
   * below it (see the module header of ./throttle-governor.ts): it only ever lengthens
   * the wait between attempts, and it never influences the breaker's own state.
   */
  readonly governor: ThrottleGovernor;
  /** Resolves after the given delay; injected so no test waits on a real timer. */
  readonly sleep: (ms: number) => Promise<void>;
  /** Uniform [0, 1) source for jitter; injected so backoff bounds are testable. */
  readonly random: () => number;
}

/** One attempt's outcome, kept internal so the retry loop stays flat. */
type AttemptOutcome =
  | { readonly kind: 'answered'; readonly response: JsonHttpResponse }
  | { readonly kind: 'retryable-status'; readonly response: JsonHttpResponse }
  | { readonly kind: 'rejected'; readonly cause: unknown };

/**
 * Perform one attempt and classify it, turning a rejection into a value.
 *
 * A 429 specifically - not any 5xx - also feeds the governor: 429 is the host's own
 * word that WE are asking for too much, which is what the governor exists to slow
 * down. A 5xx says the host is unwell, which is the breaker's concern instead.
 */
async function attemptOnce(
  port: JsonHttpPort,
  request: JsonHttpRequest,
  governor: ThrottleGovernor,
): Promise<AttemptOutcome> {
  try {
    const response = await port(request);
    if (classifyStatus(response.status) !== 'retryable') {
      return { kind: 'answered', response };
    }
    if (response.status === HTTP_TOO_MANY_REQUESTS) {
      governor.recordThrottle();
    }
    return { kind: 'retryable-status', response };
  } catch (cause) {
    // The inner port has already redacted this; it is PRESERVED rather than replaced
    // so that, on exhaustion, the transport above sees the same classification it
    // would have seen with no retry wrapper at all.
    return { kind: 'rejected', cause };
  }
}

/**
 * Wrap a `JsonHttpPort` with transport-level retry and the run-wide breaker.
 *
 * Transparent to its caller: it returns the inner port's reply unchanged, and on
 * exhaustion it surfaces the inner port's own last outcome - the final retryable
 * response, or the final (already redacted) rejection - so the transport above
 * classifies the failure exactly as it normally would. It NEVER manufactures a reply,
 * so an outage can never look like an answer.
 */
export function createRetryingHttpPort(
  inner: JsonHttpPort,
  deps: TransportRetryDeps,
): JsonHttpPort {
  return async (request: JsonHttpRequest): Promise<JsonHttpResponse> => {
    const { policy, breaker, governor } = deps;
    // Seeded with the breaker error so a request refused BEFORE its first attempt fails
    // fast with that classification and nothing else.
    let last: AttemptOutcome = { kind: 'rejected', cause: new TransportCircuitOpenError() };
    for (let attempt = 1; attempt <= policy.maxAttempts; attempt += 1) {
      if (!breaker.admitCall()) {
        // The breaker may trip on THIS request's own retries. Stop retrying, but keep the
        // outcome already observed: a real 503 or a real socket error is more diagnosable
        // than "the breaker is open", and the transport above classifies both the same way.
        break;
      }
      last = await attemptOnce(inner, request, governor);
      if (last.kind === 'answered') {
        breaker.recordSuccess();
        return last.response;
      }
      breaker.recordFailure();
      if (attempt < policy.maxAttempts) {
        // The governor's multiplier lengthens our own adaptive backoff, then that product
        // is clamped to our ceiling - our growth never escapes `maxDelayMs`. The host's
        // own Retry-After is applied as a FLOOR after that clamp, not before it, so a host
        // asking for longer than our ceiling is still obeyed while our own adaptive growth
        // stays bounded by it.
        const computed =
          backoffDelayMs(policy, attempt, deps.random) * governor.backoffMultiplier();
        const clamped = Math.min(policy.maxDelayMs, computed);
        const retryAfterMs = last.kind === 'retryable-status' ? last.response.retryAfterMs : null;
        await deps.sleep(Math.max(clamped, retryAfterMs ?? 0));
      }
    }
    if (last.kind === 'retryable-status') {
      return last.response;
    }
    throw last.cause;
  };
}
