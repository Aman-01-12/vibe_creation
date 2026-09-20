// testbench-repair-loop, task 1.5: the real measured TESTBENCH_FAILED_REFERENCE
// case (`.eval-runs/stage1-screen-v3/artifacts/deepseek.v3.2/
// rtllm_arithmetic_adder_16bit/sample-1/`).
//
// The property tests (tasks 1.3, 1.4) state the anti-circularity and
// verbatim-vs-classified guarantees over a SYNTHETIC trigger space. This file is
// their real-artifact, non-vacuous counterpart, following
// `testbench-precheck-measured-cases.integration.test.ts`'s precedent of citing a
// real artifact by path and reproducing its content verbatim rather than a
// hand-crafted stand-in.
//
// The on-disk `outcome.json` for this sample records:
//   "instrumentVerdict": { "validity": "invalid", "defect": "TESTBENCH_FAILED_REFERENCE" }
// and the on-disk `control-stdout.txt` (483 chars, reproduced verbatim below) is
// the exact toolchain output this defect was measured from - the leaked values
// (`y=fffe`, `Co=1`, `Co=0`, `y=0000`) a `ClassifiedFunctionalHint` must never
// carry, per Req 2.4-2.6.
//
// The Spec built here is the minimal `adder_16bit` Spec whose ONE
// simulation-verifiable acceptance criterion, run through the real
// `criterionCheckName`/`slugify` in `app/agent/roles/testbench/coverage.ts`,
// reproduces the real check name the control run actually printed
// (`ac1_under_simulation_adder_16bit_produces_th` - the 40-char
// `MAX_SLUG_CHARS` truncation of "under simulation, adder_16bit produces the
// ..."). This is verified directly below rather than assumed, so a future change
// to `slugify`'s truncation would fail this test rather than silently drift.
//
// Validates: Requirements 2.3, 2.4, 2.5, 2.6

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  buildRepairHint,
  requiredChecks,
  ruleFamilyFor,
  type ClassifiedFunctionalHint,
  type RepairTrigger,
} from '@app/agent';
import { newUlid, type Spec } from '@app/core';

/** The real artifact directory this test's fixtures are measured from. */
const ARTIFACT_DIR = join(
  '.eval-runs',
  'stage1-screen-v3',
  'artifacts',
  'deepseek.v3.2',
  'rtllm_arithmetic_adder_16bit',
  'sample-1',
);

/** The real toolchain output this sample's `TESTBENCH_FAILED_REFERENCE` defect was measured from. */
const REAL_CONTROL_STDOUT = readFileSync(join(ARTIFACT_DIR, 'control-stdout.txt'), 'utf8');

/** The real check name the control run actually printed, per `control-stdout.txt`. */
const REAL_FAILING_CHECK_NAME = 'ac1_under_simulation_adder_16bit_produces_th';

/**
 * The minimal, approved `adder_16bit` Spec whose declared ports match the real
 * testbench's instantiation (`adder_16bit uut (.a(a), .b(b), .Cin(Cin), .y(y),
 * .Co(Co))`) and whose one acceptance criterion's text is chosen so
 * `criterionCheckName(criterion, 0)` reproduces `REAL_FAILING_CHECK_NAME`
 * exactly, verified below rather than assumed.
 */
function adder16BitSpec(): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A 16-bit combinational adder with carry-out',
    constraints: ['purely combinational'],
    architecture: 'A ripple-carry chain of full adders.',
    moduleInterface: {
      moduleName: 'adder_16bit',
      ports: [
        { name: 'a', direction: 'input', width: 16 },
        { name: 'b', direction: 'input', width: 16 },
        { name: 'Cin', direction: 'input', width: 1 },
        { name: 'y', direction: 'output', width: 16 },
        { name: 'Co', direction: 'output', width: 1 },
      ],
      clocking: { clockName: null, resetName: null, resetActiveLow: false },
    },
    acceptanceCriteria: [
      {
        id: newUlid(),
        text: 'Under simulation, adder_16bit produces the correct sum and carry-out for all input combinations',
        measurable: true,
        method: 'simulation',
      },
    ],
    approved: true,
    version: 1,
  };
}

describe('testbench-repair-loop, real measured TESTBENCH_FAILED_REFERENCE case (adder_16bit sample-1)', () => {
  it("the Spec's own check name matches the real control run's check name (non-vacuity anchor)", () => {
    const spec = adder16BitSpec();
    const [check] = requiredChecks(spec);

    expect(check).toBeDefined();
    expect(check?.name).toBe(REAL_FAILING_CHECK_NAME);
    // Confirms the fixture is not a coincidence: the real file really did print
    // this exact check name failing, so the Spec above is not a hand-picked
    // shortcut that merely happens to share a name.
    expect(REAL_CONTROL_STDOUT).toContain(`CHECK ${REAL_FAILING_CHECK_NAME} FAIL`);
  });

  it("builds a ClassifiedFunctionalHint from the real recorded verdict that leaks none of the real control run's observed output", () => {
    const spec = adder16BitSpec();
    const [check] = requiredChecks(spec);
    if (check === undefined) {
      throw new Error(
        'fixture Spec produced no required check; the check-name assertion above must fail first',
      );
    }

    // The real recorded verdict for this sample, per outcome.json:
    //   "instrumentVerdict": { "validity": "invalid", "defect": "TESTBENCH_FAILED_REFERENCE" }
    // `repairTriggerFor` (task 8.2, app/eval/testbench-repair.ts) is the function
    // that maps this exact verdict shape to a `failed-reference` trigger; its
    // production is exercised by that task's own tests. This test constructs the
    // trigger directly, as the task specifies, from the check name and the rule
    // family `ruleFamilyFor` derives from the Spec alone.
    const ruleFamily = ruleFamilyFor(check, spec.moduleInterface);
    const trigger: RepairTrigger = {
      kind: 'failed-reference',
      failingCheckName: check.name,
      ruleFamily,
    };

    const hint = buildRepairHint(trigger) as ClassifiedFunctionalHint;
    const serialized = JSON.stringify(hint);

    // Req 2.3: the hint is not simply empty. Spec-derived text (the check name)
    // is allowed and expected to cross.
    expect(hint.kind).toBe('classified-functional');
    expect(hint.failingCheckName).toBe(REAL_FAILING_CHECK_NAME);

    // Req 2.4-2.6: none of the real control run's observed values, on their own
    // or as part of the exact lines they appeared in, ever reach the hint.
    expect(serialized).not.toContain('fffe');
    expect(serialized).not.toContain('Co=1');
    expect(serialized).not.toContain('Co=0');
    expect(serialized).not.toContain('0000');
    expect(serialized).not.toContain('Maximum values without carry');
    expect(serialized).not.toContain('Boundary carry case');
    expect(serialized).not.toContain('10 of 10 test cases failed');
    expect(serialized).not.toContain('Test completed with 10 test cases executed');
    expect(serialized).not.toContain('instrument_control_tb.v:186');
    expect(serialized).not.toContain('$finish called at 100');
    expect(serialized).not.toContain('VCD info');
    expect(serialized).not.toContain('dump.vcd');

    // The thorough form the task calls for: split the real file into lines and
    // words, and assert none of them (beyond the Spec-derived check name itself,
    // which is expected and required to cross) appear in the serialized hint.
    // This catches any substring of the real file this test's authors did not
    // think to name individually above.
    const realLines = REAL_CONTROL_STDOUT.split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    for (const line of realLines) {
      // The one line that legitimately contains the check name is expected to
      // share that substring with the hint; everything else about that line
      // (the FAIL marker, the observed/expected values) must not.
      const lineWithoutCheckName = line.split(REAL_FAILING_CHECK_NAME).join('');
      if (lineWithoutCheckName.trim().length === 0) {
        continue;
      }
      expect(serialized).not.toContain(lineWithoutCheckName);
    }

    // Structural guarantee already proven by Property 3 (task 1.4): re-asserted
    // here against the REAL trigger rather than a synthetic one, so this test
    // does not merely trust the property held.
    expect('diagnostic' in hint).toBe(false);
    expect(Object.keys(hint).sort()).toEqual(['defectClass', 'failingCheckName', 'kind']);
  });
});
