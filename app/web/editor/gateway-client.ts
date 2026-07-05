// The Editor's only outbound seam: an end-to-end typed tRPC client bound to the
// API_Gateway's `AppRouter` (Design: OD-7 tRPC client, OD-6 SSE streaming; Req
// 1.1).
//
// The Editor talks to the API_Gateway and nothing else - never a model or tool
// provider directly. The client is typed against the server's `AppRouter`, so the
// skeleton simulation input and the streamed `GatewayStreamEvent`s are checked
// against the server contract at compile time. Subscriptions ride Server-Sent
// Events (`httpSubscriptionLink`); discrete calls use `httpLink`.
//
// Auth (Req 1.2): every gateway procedure requires an authenticated principal
// (`authedProcedure`). This client attaches the caller's bearer credential,
// resolved from the host session at call time via `getAuthToken`, as an
// `Authorization` header on HTTP calls and as SSE connection params (EventSource
// cannot set request headers). The token is never embedded in source or the
// client bundle; there is no unauthenticated path.

import { createTRPCClient, httpLink, httpSubscriptionLink, splitLink } from '@trpc/client';

import type { AppRouter, GatewayStreamEvent, SkeletonSimulationInput } from '@app/api';

import { observerToAsyncIterable, type Subscribe } from './subscription-stream.js';

/** Non-secret configuration for the gateway client. */
export interface EditorGatewayConfig {
  /** Absolute URL of the API_Gateway tRPC endpoint (never a provider URL). */
  readonly gatewayUrl: string;
  /**
   * Resolves the current bearer credential for the authenticated principal.
   * Called per request so a refreshed token is always used; the value is never
   * stored in source or the bundle.
   */
  readonly getAuthToken: () => string | Promise<string>;
}

/** The gateway operations the skeleton Editor uses. */
export interface EditorGatewayClient {
  /**
   * Submit the skeleton Verilog + testbench and stream back the run's events.
   * The returned iterable ends at the first terminal (`result`/`error`) event or
   * when `signal` aborts.
   */
  runSkeletonSimulation(
    input: SkeletonSimulationInput,
    signal?: AbortSignal,
  ): AsyncIterable<GatewayStreamEvent>;
}

/** Build the typed gateway client from non-secret configuration. */
export function createEditorGatewayClient(config: EditorGatewayConfig): EditorGatewayClient {
  const client = createTRPCClient<AppRouter>({
    links: [
      splitLink({
        condition: (operation) => operation.type === 'subscription',
        true: httpSubscriptionLink({
          url: config.gatewayUrl,
          connectionParams: async () => ({ token: await config.getAuthToken() }),
        }),
        false: httpLink({
          url: config.gatewayUrl,
          headers: async () => ({ authorization: `Bearer ${await config.getAuthToken()}` }),
        }),
      }),
    ],
  });

  return {
    runSkeletonSimulation(input, signal): AsyncIterable<GatewayStreamEvent> {
      const subscribe: Subscribe<GatewayStreamEvent> = (observer) =>
        client.runSkeletonSimulation.subscribe(input, {
          // Normalize the wire event (where `data` infers optional) back into the
          // server's `GatewayStreamEvent` shape so `data` is always present.
          onData: (event) =>
            observer.onData({ kind: event.kind, seq: event.seq, data: event.data }),
          onError: observer.onError,
          onComplete: observer.onComplete,
        });
      return observerToAsyncIterable(subscribe, signal);
    },
  };
}
