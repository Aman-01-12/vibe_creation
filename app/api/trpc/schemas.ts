// Zod input schemas for the tRPC procedures the Editor calls.
//
// These are the runtime schema layer (OD-7): tRPC's static types vanish at
// runtime, so every procedure input is validated against one of these before any
// resolver logic runs. The TypeScript input types are inferred from the schemas
// (`z.infer`) so the wire contract has a single source of truth and cannot drift
// from validation.

import { z } from 'zod';

/** Bounds chosen to reject absurd inputs early; the byte-size gate is separate. */
const MAX_DESCRIPTION_CHARS = 20_000;
const MAX_CHANGE_CHARS = 20_000;
const MAX_SOURCE_CHARS = 200_000;

/** A trimmed, non-empty session identifier. */
const sessionId = z.string().trim().min(1).max(64);

/** A trimmed, non-empty opaque object identifier (ULID-shaped in practice). */
const objectId = z.string().trim().min(1).max(64);

/** S0 intent submission. */
export const submitIntentInput = z.object({
  description: z.string().trim().min(1).max(MAX_DESCRIPTION_CHARS),
});
export type SubmitIntentInput = z.infer<typeof submitIntentInput>;

/** Explicit intent confirmation (blocking precondition for generation). */
export const confirmIntentInput = z.object({ sessionId });
export type ConfirmIntentInput = z.infer<typeof confirmIntentInput>;

/** S1 spec approval decision. */
export const approveSpecInput = z.object({ sessionId, approved: z.boolean() });
export type ApproveSpecInput = z.infer<typeof approveSpecInput>;

/** S9 iteration request; carries an idempotency key for the side-effectful re-run. */
export const requestIterationInput = z.object({
  sessionId,
  projectId: objectId,
  change: z.string().trim().min(1).max(MAX_CHANGE_CHARS),
  idempotencyKey: z.string().trim().min(1).max(128),
});
export type RequestIterationInput = z.infer<typeof requestIterationInput>;

/** Reopen a stored project (object-scoped; authorized per object). */
export const openProjectInput = z.object({ projectId: objectId });
export type OpenProjectInput = z.infer<typeof openProjectInput>;

/**
 * M0 skeleton oracle path (Req 1.4): submit a Verilog module and a matching
 * testbench to be compiled and simulated. Not object-scoped: it touches no
 * stored project, so it does not require per-object authorization.
 */
export const skeletonSimulationInput = z.object({
  rtl: z.string().min(1).max(MAX_SOURCE_CHARS),
  testbench: z.string().min(1).max(MAX_SOURCE_CHARS),
});
export type SkeletonSimulationInput = z.infer<typeof skeletonSimulationInput>;
