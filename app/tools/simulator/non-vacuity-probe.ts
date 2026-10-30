// The Non_Vacuity_Probe renderer (C8; Req 7.1, 7.3, 7.6): a second, small rendered artifact that
// wraps the SAME rendered Stimulus_Function a Consensus_Run's harness renders, in a top module
// that drives nothing and instantiates nothing, and prints the input bundle once per step.
//
// `ECE_STIM` is a deliberately distinct line prefix from the harness's own `ECE_SAMPLE`
// (`consensus-harness.ts`): `reduceSignature` keys on `ECE_SAMPLE` and the nonce, so a probe's
// stdout handed to it by mistake reduces to nothing rather than to a wrong Waveform_Signature.
//
// The probe refuses rather than renders whenever the harness's own boundaries would have refused
// the same Declared_Interface and Role_Declaration, and refuses rather than silently shortening
// its loop when its sized stdout cap falls below the requested Sample_Budget - a shorter loop
// reads fewer whole Hold_Windows than the Session renders.

import {
  domainError,
  err,
  ok,
  type DomainError,
  type ModuleInterface,
  type Result,
} from '@app/core';

import type { SourceFile } from '../sandbox/contract.js';

import {
  renderStimulusFunction,
  renderStimulusMixer,
  requireTotalRoleDeclaration,
  requireVerilogIdentifier,
  requirePositiveSafeInteger,
  sizedSampleBudget,
  type RoleDeclaration,
} from './consensus-harness.js';

/** A hyphenated path, matching `CONSENSUS_HARNESS_PATH`'s own collision-avoidance convention. */
export const NON_VACUITY_PROBE_PATH = 'ece-stimulus-probe.v';

/** The probe's own line prefixes; exported so a reader (C9) owns one source. */
export const STIM_LINE_PREFIX = 'ECE_STIM' as const;
export const STIM_END_PREFIX = 'ECE_STIM_END' as const;

/** The probe module's fixed name; unrelated to `moduleInterface.moduleName` since the probe
 * never instantiates the Candidate_Design. */
const NON_VACUITY_PROBE_MODULE = 'ece_stimulus_probe';

/** One Non_Vacuity_Probe render request; carries no RTL, model output, or Spec prose. */
export interface NonVacuityProbeRequest {
  readonly moduleInterface: ModuleInterface;
  readonly nonce: string;
  readonly roles: RoleDeclaration;
  /** The Session's own effective Sample_Budget, so the windows the probe reads are its windows. */
  readonly sampleBudget: number;
}

/**
 * Render the Non_Vacuity_Probe (Req 7.1, 7.3, 7.6).
 *
 * Pure and total: refuses with a `DomainError` rather than throwing on any invalid input, and
 * two calls with the same `request` produce byte-identical text.
 */
export function renderNonVacuityProbe(
  request: NonVacuityProbeRequest,
): Result<SourceFile, DomainError> {
  const { moduleInterface, nonce, roles, sampleBudget } = request;

  const scalarError = requirePositiveSafeInteger(
    'sampleBudget',
    sampleBudget,
    Number.MAX_SAFE_INTEGER,
  );
  if (scalarError !== null) {
    return err(scalarError);
  }

  const nonceError = requireVerilogIdentifier('nonce', nonce);
  if (nonceError !== null) {
    return err(nonceError);
  }

  const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
  for (const port of inputPorts) {
    const portError = requireVerilogIdentifier(`port "${port.name}"`, port.name);
    if (portError !== null) {
      return err(portError);
    }
  }

  // Re-derived, not read from a flag the parser set: the probe must never render Stimulus_
  // Function text for a Role_Declaration the harness's own boundary would have refused.
  const roleError = requireTotalRoleDeclaration(inputPorts, roles);
  if (roleError !== null) {
    return err(roleError);
  }

  // Mirrors `consensus-harness.ts`'s own bundle-width floor, so the two renderers size the
  // packed input bundle identically.
  const inputBundleWidth = Math.max(
    1,
    inputPorts.reduce((sum, port) => sum + port.width, 0),
  );

  // Req 7.6: the probe's line carries the INPUT bundle, so its stdout is sized against the
  // INPUT bundle width - not the output bundle width the harness checks its own sample lines
  // against. Refused rather than clamped: a shorter loop reads fewer whole Hold_Windows than
  // the Session renders, so the cap is named and the render refused instead of shortened.
  const cap = sizedSampleBudget(nonce.length, inputBundleWidth, sampleBudget);
  if (cap < sampleBudget) {
    return err(
      domainError(
        'NON_VACUITY_PROBE_BUDGET_EXCEEDS_CAP',
        `requested sample budget ${String(sampleBudget)} exceeds the input-bundle-width-sized stdout cap of ${String(cap)}`,
        'sampleBudget',
      ),
    );
  }

  const lines: string[] = [
    // Rendered by the SAME renderStimulusMixer/renderStimulusFunction calls a Session's harness
    // uses, with the same inputPorts, inputBundleWidth and roles, so this text is provably
    // identical to what a Session renders for the same Declared_Interface and Role_Declaration.
    ...renderStimulusMixer(),
    ...renderStimulusFunction(inputPorts, inputBundleWidth, roles),
    `module ${NON_VACUITY_PROBE_MODULE};`,
    `  localparam integer ECE_PROBE_BUDGET = ${String(sampleBudget)};`,
    '  integer step;',
    `  reg [${String(inputBundleWidth - 1)}:0] v;`,
    '  initial begin',
    '    $dumpfile("dump.vcd");',
    `    $dumpvars(0, ${NON_VACUITY_PROBE_MODULE});`,
    '  end',
    '  initial begin',
    '    for (step = 0; step < ECE_PROBE_BUDGET; step = step + 1) begin',
    '      v = ece_stimulus(step);',
    `      $display("${STIM_LINE_PREFIX} %0s %0d %0h", "${nonce}", step, v);`,
    '    end',
    `    $display("${STIM_END_PREFIX} %0s %0d", "${nonce}", ECE_PROBE_BUDGET);`,
    '    $finish;',
    '  end',
    'endmodule',
    '',
  ];

  return ok({ path: NON_VACUITY_PROBE_PATH, contents: lines.join('\n') });
}
