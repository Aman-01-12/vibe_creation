// Reference_Model request and parsed-draft types (C7, Req 5.1, 5.10).

import type { AcceptanceCriterion, ModuleInterface, TimingContract } from '@app/core';
import type { RoleDeclaration } from '@app/tools';

/**
 * No field a Candidate_Design, a Waveform_Signature, or a simulation log could occupy
 * (same discipline as `InstrumentAdmissionRequest`). A Repair_Attempt uses a different,
 * named type (task 11.1) so the two cannot be confused at a call site.
 */
export interface ReferenceModelRequest {
  readonly moduleInterface: ModuleInterface;
  readonly timingContract: TimingContract;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterion[];
}

/**
 * The three untrusted function bodies and the per-port Role_Declaration a Reference_Model
 * reply must supply. No `stimulusBody`: the Harness_Renderer renders the Stimulus_Function
 * from `roles` (Req 1.10), so the type carries no field a model-authored stimulus could fill.
 */
export interface ReferenceModelDraft {
  /** The state right after reset release (Req 5.12). */
  readonly resetStateBody: string;
  readonly nextStateBody: string;
  readonly expectBody: string;
  /** Total over the Declared_Interface's input ports; refused otherwise (Req 1.3). */
  readonly roles: RoleDeclaration;
}

/** Why shaping untrusted model output into a draft failed (non-sensitive). */
export interface ReferenceModelParseError {
  readonly reason: string;
}
