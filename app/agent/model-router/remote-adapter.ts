// Vendor-neutral plumbing shared by the real provider adapters.
//
// This resolves an adapter's OWN credential via its provider-scoped resolver at
// the point of use and hands it to a vendor-specific transport - the seam where a
// real vendor SDK lives. The credential value exists only as a local passed into
// the transport; it is never returned, logged, stored, or embedded in an error
// (Req 12.6, 12.7, 12.9).
//
// Real-vs-fake: the transport is injected, exactly like the sandbox's real gVisor
// runtime is injected behind the `SandboxRuntime` port. In this environment no
// vendor SDK is installed and no credential is provisioned, so no transport is
// wired and the adapter fails safe with `provider-unavailable` rather than
// fabricating a model result - the same graceful-unavailable behavior the real
// sandbox runtime shows when gVisor is absent. Deployment injects a concrete
// transport that talks to the vendor SDK behind this same interface.

import { err, type Result } from '@app/core';

import type {
  ModelRequest,
  ModelResult,
  ProviderCallError,
  ProviderCallOptions,
} from './contract.js';
import type { ProviderCredentialResolver } from './secret-manager.js';

/** The inputs a vendor transport needs; the credential is used here and only here. */
export interface ProviderTransportInput {
  readonly credential: string;
  readonly request: ModelRequest;
  /**
   * The model id the routing policy selected for this call, when one was routed.
   *
   * Absent only when an adapter is driven directly rather than through the router;
   * a transport then uses its own configured default model. Configuration, never a
   * secret.
   */
  readonly modelId?: string;
}

/**
 * The vendor-specific outbound call: where a real provider SDK is invoked.
 *
 * A transport receives the resolved credential and the request and returns a
 * provider-neutral result. It must never echo the credential into its result or
 * error. Supplied by deployment; absent (null) in this environment.
 */
export type ProviderTransport = (
  input: ProviderTransportInput,
) => Promise<Result<ModelResult, ProviderCallError>>;

/**
 * Resolve the adapter's own credential at the point of use and invoke the vendor
 * transport, confining the credential to that call and failing safe otherwise.
 *
 * Order matters for confinement: when no transport is wired we return before ever
 * resolving a credential, so an unconfigured adapter touches no secret at all.
 */
export async function callViaTransport(
  resolver: ProviderCredentialResolver,
  transport: ProviderTransport | null,
  request: ModelRequest,
  options?: ProviderCallOptions,
): Promise<Result<ModelResult, ProviderCallError>> {
  if (transport === null) {
    return err({
      kind: 'provider-unavailable',
      reason: `${resolver.provider} transport not configured in this environment`,
    });
  }
  const resolved = await resolver.resolve();
  if (!resolved.ok) {
    // Report failure by provider name only; never surface the resolution detail
    // or the ref value in a way that could leak into the Trace or an error path.
    return err({
      kind: 'credential-unavailable',
      reason: `credential unavailable for ${resolver.provider}`,
    });
  }
  try {
    return await transport({
      credential: resolved.value,
      request,
      ...(options === undefined ? {} : { modelId: options.modelId }),
    });
  } catch {
    // Swallow the raw error deliberately: a vendor SDK error can embed a host,
    // URL, or an echoed credential. Fail safe with a generic, redacted reason.
    return err({ kind: 'provider-unavailable', reason: `${resolver.provider} call failed` });
  }
}

/** Guard that a resolver is scoped to the expected provider (a DI wiring error). */
export function assertResolverProvider(
  resolver: ProviderCredentialResolver,
  expected: ProviderCredentialResolver['provider'],
): void {
  if (resolver.provider !== expected) {
    throw new Error(
      `Model_Router wiring error: ${expected} adapter was given a ${resolver.provider}-scoped credential resolver`,
    );
  }
}
