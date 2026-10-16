// Formal oracle adapter: Yosys lowers RTL plus a stated property to SMT2 and Z3 decides it
// (design.md Component 4; ADR-019 layer 2). A sibling of `simulator/` and `synth/`, because all
// three are interpretations of the same `ToolRunner` rather than variations on one adapter.
//
// The five-condition gate lands here FIRST, as a pure function, before any wiring: a `PASSED`
// from the chain is `Verified` only when the assertion count is non-zero, the assumptions are
// satisfiable, the antecedent's cover was reached, the base case from the design's real reset
// state passed, and temporal induction succeeded. Everything else is `could-not-verify`, a THIRD
// label. `conditions.ts` is the one place that rule is written down, which is what lets it be
// asserted with no toolchain present.
//
// `report.ts` is the validating parse of the worker's `formal-report.json` - untrusted text at a
// trust boundary - and `interpret.ts` is the pure, total function that turns one parsed report
// plus one `SandboxResult` into one `PropertyResult`. `interpret.ts` CALLS `admitProved` rather
// than re-deriving the rule, so the gate keeps exactly one owner.
//
// `adapter.ts` is the only impure module here and it decides nothing: it calls the pre-pass over
// the design alone, reads the reset and clock contracts off it through `prepass.ts`, renders the
// wrapper, climbs the deterministic depth ladder inside the Property_Time_Budget, and classifies
// through `interpretFormalReport`. Two jobs, a render between them, a ladder, and a budget.
//
// This folder may import `@app/core` and its own package only - never `@app/agent` and never
// `@app/eval`.

export {
  assembleFormalJob,
  assembleFormalPrepassJob,
  CLOCKED_DEPTH_LADDER,
  COMBINATIONAL_DEPTH,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  proofDepthsFor,
  PROPERTY_WRAPPER_FILE_NAME,
  PROPERTY_WRAPPER_MODULE_NAME,
  YosysSmtBmcFormalOracle,
  type CounterexampleCapture,
  type CounterexampleRefusal,
  type FormalArtifactReader,
  type FormalOracleDeps,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProveRequest,
  type FormalProveSetRequest,
  type FormalResourceCaps,
} from './adapter.js';

export {
  admitProved,
  COULD_NOT_VERIFY_CAUSES,
  FORMAL_VERDICTS,
  type CouldNotVerifyCause,
  type CoverCondition,
  type FormalVerdict,
  type NonZeroAssertionCount,
  type ProofConditions,
  type PropertyResult,
  type ProvedEvidence,
} from './conditions.js';

export {
  COUNTEREXAMPLE_ARTIFACT_KEY,
  interpretFormalReport,
  MAX_DIAGNOSTIC_CHARS,
  refusedWithoutProof,
  type FormalRunContext,
} from './interpret.js';

export {
  CLOCK_POLARITIES,
  deriveFormalPrepassReport,
  formalPrepassReportSchema,
  FREE_INITIAL_STATE_PREDICATE,
  MAX_PREPASS_REPORT_CHARS,
  parseFormalPrepassReport,
  readFormalPrepassContract,
  readFormalPrepassReport,
  readFreeInitialState,
  type ClockPolarity,
  type FormalPrepassDocument,
  type FormalPrepassRefusal,
  type FormalPrepassRejection,
  type FormalPrepassReport,
  type PrepassResetFinding,
  type ResetContract,
  type ResetEnable,
} from './prepass.js';

export {
  formalReportSchema,
  MAX_REPORT_CHARS,
  parseFormalReport,
  type FormalCheckReport,
  type FormalChecksReport,
  type FormalCrossCheckReport,
  type FormalLoweringReport,
  type FormalReport,
  type FormalReportRejection,
} from './report.js';
