// Downstream cancellation plumbing at the API_Gateway boundary (Design: Error
// Handling, streaming and cancellation; Req 17.6).
//
// The Editor cancels a long run by aborting its subscription; the SSE transport
// surfaces that as an `AbortSignal` on the tRPC resolver. This module validates
// that inbound signal at the trust boundary and yields the signal the gateway
// threads into every downstream model and tool call, so an in-flight provider or
// sandbox call is abandoned promptly and no orphaned work remains.
//
// The inbound signal is UNTRUSTED transport input: it is typed `unknown` here and
// accepted only if it is a real `AbortSignal`. When it is absent or malformed the
// boundary fails safe to a fresh never-aborting signal, so a missing signal can
// never crash the pipeline or wrongly cancel downstream work.

/** Structural check that a value is a usable `AbortSignal`. */
function isAbortSignal(value: unknown): value is AbortSignal {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as Partial<AbortSignal>;
  return typeof candidate.aborted === 'boolean' && typeof candidate.addEventListener === 'function';
}

/**
 * Validate the transport-provided cancellation signal and return the signal to
 * thread downstream.
 *
 * A valid inbound `AbortSignal` is passed through unchanged so its aborts reach
 * downstream calls. Anything else (absent or malformed) yields a fresh
 * never-aborting signal, failing safe rather than throwing at the boundary.
 */
export function resolveDownstreamSignal(inbound: unknown): AbortSignal {
  if (isAbortSignal(inbound)) {
    return inbound;
  }
  return new AbortController().signal;
}
