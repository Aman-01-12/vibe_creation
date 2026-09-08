// Public surface of the fail-closed Display_Layer (task 15.1).
//
// The Display_Layer applies the per-Trust_Tier visual treatment behind a
// fail-closed integrity check on each label's oracle provenance, makes the
// Trust_Tier visible on every rendered artifact (Req 14.5), and records a
// discrepancy when a `Verified` claim is rejected (Req 14.15). The pure decision
// (`decideTrustTreatment`) is exported separately so Property 2 (task 15.2) can
// state over it directly.

export { decideTrustTreatment, type TrustTreatmentDecision } from './trust-treatment.js';
export {
  createDisplayLayer,
  type ArtifactDisplayModel,
  type DisplayLayer,
} from './display-layer.js';
export {
  type DiscrepancyEmitPort,
  type DiscrepancyReason,
  type ProvenanceDiscrepancy,
} from './discrepancy.js';
