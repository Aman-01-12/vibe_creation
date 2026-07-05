// The tRPC procedures the Editor calls (Design: Components and Interfaces,
// API_Gateway; EditorClient).
//
// Every procedure is authenticated and rate limited via `authedProcedure` and
// validates its input against a Zod schema (OD-7). There is NO unauthenticated
// mutation path. Free-text fields destined for the Orchestrator's model calls
// are injection-filtered here; the skeleton simulate path is deliberately NOT
// filtered because its Verilog goes to the deterministic oracle, not a model,
// and must not be mangled. Object-scoped procedures pass through the
// safe-by-default `authorizeObject` seam (completed in task 12.1).
//
// The Orchestrator and Project_Store are reached through the injected
// `GatewayHandlers` port so this layer stays independent of their internals;
// tasks 6 and 12 provide the concrete implementation.

import { isErr } from '@app/core';

import type { AuthenticatedPrincipal } from '../gateway/auth.js';
import { authorizeObject, type ObjectAuthorizer } from '../gateway/authorize-object.js';
import { filterInjection } from '../gateway/injection-filter.js';
import {
  approveSpecInput,
  confirmIntentInput,
  openProjectInput,
  requestIterationInput,
  skeletonSimulationInput,
  submitIntentInput,
  type OpenProjectInput,
  type RequestIterationInput,
  type SubmitIntentInput,
} from './schemas.js';
import { authedProcedure, router, throwGateway } from './trpc.js';

/** A single server-to-client streamed event (SSE frame, OD-6). */
export interface GatewayStreamEvent {
  readonly kind: 'progress' | 'result' | 'error';
  /** Monotonic sequence for resumable streams (Last-Event-ID). */
  readonly seq: number;
  readonly data: unknown;
}

/**
 * A reopened project's snapshot. Minimal placeholder for the wire contract;
 * task 12.1 (Project_Store) refines its shape.
 */
export interface ProjectSnapshot {
  readonly projectId: string;
}

/**
 * The port into the Orchestrator and Project_Store.
 *
 * The gateway owns authentication, authorization, validation, and sanitization;
 * these handlers own the spine behavior. Streaming stages return an async
 * iterable of events; discrete actions return a promise.
 */
export interface GatewayHandlers {
  submitIntent(
    principal: AuthenticatedPrincipal,
    input: SubmitIntentInput,
  ): AsyncIterable<GatewayStreamEvent>;
  confirmIntent(principal: AuthenticatedPrincipal, input: { sessionId: string }): Promise<void>;
  approveSpec(
    principal: AuthenticatedPrincipal,
    input: { sessionId: string; approved: boolean },
  ): AsyncIterable<GatewayStreamEvent>;
  requestIteration(
    principal: AuthenticatedPrincipal,
    input: RequestIterationInput,
  ): AsyncIterable<GatewayStreamEvent>;
  openProject(principal: AuthenticatedPrincipal, input: OpenProjectInput): Promise<ProjectSnapshot>;
  runSkeletonSimulation(
    principal: AuthenticatedPrincipal,
    input: { rtl: string; testbench: string },
  ): AsyncIterable<GatewayStreamEvent>;
}

/** Collaborators injected when the router is composed (task 6 / task 12). */
export interface AppRouterDeps {
  readonly handlers: GatewayHandlers;
  readonly objectAuthorizer: ObjectAuthorizer;
}

/** Build the API_Gateway tRPC router over its injected dependencies. */
export function createAppRouter(deps: AppRouterDeps) {
  return router({
    // S0: submit a natural-language idea; description is injection-filtered.
    submitIntent: authedProcedure.input(submitIntentInput).subscription(async function* ({
      ctx,
      input,
    }) {
      const clean: SubmitIntentInput = {
        description: filterInjection(input.description).sanitized,
      };
      yield* deps.handlers.submitIntent(ctx.principal, clean);
    }),

    // S0: explicit confirmation gate before generation.
    confirmIntent: authedProcedure
      .input(confirmIntentInput)
      .mutation(({ ctx, input }) => deps.handlers.confirmIntent(ctx.principal, input)),

    // S1: approve (or reject) the spec.
    approveSpec: authedProcedure
      .input(approveSpecInput)
      .subscription(({ ctx, input }) => deps.handlers.approveSpec(ctx.principal, input)),

    // S9: object-scoped iteration; authorize the project, then filter the change text.
    requestIteration: authedProcedure.input(requestIterationInput).subscription(async function* ({
      ctx,
      input,
    }) {
      await ensureObjectAccess(deps.objectAuthorizer, ctx.principal, input.projectId);
      const clean: RequestIterationInput = {
        ...input,
        change: filterInjection(input.change).sanitized,
      };
      yield* deps.handlers.requestIteration(ctx.principal, clean);
    }),

    // Reopen a stored project; object-scoped, authorized per object.
    openProject: authedProcedure.input(openProjectInput).query(async ({ ctx, input }) => {
      await ensureObjectAccess(deps.objectAuthorizer, ctx.principal, input.projectId);
      return deps.handlers.openProject(ctx.principal, input);
    }),

    // M0 oracle path (Req 1.4): NOT injection-filtered (code goes to the oracle).
    runSkeletonSimulation: authedProcedure
      .input(skeletonSimulationInput)
      .subscription(({ ctx, input }) => deps.handlers.runSkeletonSimulation(ctx.principal, input)),
  });
}

/** Enforce per-object access, converting a denial into a sanitized error. */
async function ensureObjectAccess(
  authorizer: ObjectAuthorizer,
  principal: AuthenticatedPrincipal,
  objectId: string,
): Promise<void> {
  const decision = await authorizeObject(authorizer, principal, objectId);
  if (isErr(decision)) {
    throwGateway(decision.error);
  }
}

/** The composed router type, exported for the Editor's end-to-end typed client. */
export type AppRouter = ReturnType<typeof createAppRouter>;
