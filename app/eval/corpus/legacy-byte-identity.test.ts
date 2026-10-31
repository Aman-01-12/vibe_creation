// Unit tests for the Legacy_Byte_Identity_Check's shared render logic (C7, task 1.1).
//
// The real corpus run needs the fetched RTLLM checkout and lives in the capture CLI and the
// comparison test (`legacy-byte-identity-comparison.integration.test.ts`). What is tested HERE is
// the logic those two share: the deterministic file-name mapping, the all-`data` Legacy_Role_Set
// declaration, and that rendering a real `EvalProblem`'s own Spec produces non-empty,
// reproducible harness text.

import { describe, expect, it } from 'vitest';

import type { EvalProblem } from '../problem.js';
import { FIXED_EVAL_SUBSET } from '../subset.js';
import {
  legacyGoldenFileName,
  legacyRoleDeclarationFor,
  legacyGoldenRequestFor,
  renderLegacyGoldenCorpus,
  renderLegacyGoldenDesign,
} from './legacy-byte-identity.js';

/** `adder8`: purely combinational, three input ports, no clock. */
const ADDER8 = FIXED_EVAL_SUBSET.find((problem) => problem.id === 'verilogeval/adder8');
/** `counter4`: clocked, one input port beside clk/rst_n. */
const COUNTER4 = FIXED_EVAL_SUBSET.find((problem) => problem.id === 'rtllm/counter4');

function required(problem: EvalProblem | undefined, id: string): EvalProblem {
  if (problem === undefined) {
    throw new Error(`fixture defect: ${id} is not in FIXED_EVAL_SUBSET`);
  }
  return problem;
}

describe('legacyGoldenFileName', () => {
  it('maps a corpus problem id to a flat, `__`-joined file name', () => {
    expect(legacyGoldenFileName('rtllm/arithmetic/accu')).toBe('rtllm__arithmetic__accu.v');
  });

  it('round-trips distinct ids to distinct file names', () => {
    const ids = ['rtllm/control/counter_12', 'rtllm/control/counter', 'rtllm/memory/ram'];
    const names = new Set(ids.map(legacyGoldenFileName));
    expect(names.size).toBe(ids.length);
  });
});

describe('legacyRoleDeclarationFor', () => {
  it('names every input port `data` and no output port', () => {
    const adder8 = required(ADDER8, 'verilogeval/adder8');
    const roles = legacyRoleDeclarationFor(adder8.spec.moduleInterface);

    const inputNames = adder8.spec.moduleInterface.ports
      .filter((port) => port.direction === 'input')
      .map((port) => port.name);
    expect(roles.map((role) => role.portName).sort()).toEqual([...inputNames].sort());
    expect(roles.every((role) => role.role === 'data')).toBe(true);
  });
});

describe('legacyGoldenRequestFor', () => {
  it('carries the real imported moduleInterface and timingContract unchanged', () => {
    const counter4 = required(COUNTER4, 'rtllm/counter4');
    const request = legacyGoldenRequestFor(counter4);

    expect(request.moduleInterface).toBe(counter4.spec.moduleInterface);
    expect(request.timingContract).toBe(counter4.spec.timingContract);
  });
});

describe('renderLegacyGoldenDesign', () => {
  it('renders non-empty text and the file name legacyGoldenFileName would give the same id', () => {
    const counter4 = required(COUNTER4, 'rtllm/counter4');
    const design = renderLegacyGoldenDesign(counter4);

    expect(design.problemId).toBe(counter4.id);
    expect(design.fileName).toBe(legacyGoldenFileName(counter4.id));
    expect(design.contents.length).toBeGreaterThan(0);
    expect(design.contents).toContain(counter4.spec.moduleInterface.moduleName);
  });

  it('is deterministic: two renders of the same problem are byte-identical', () => {
    const adder8 = required(ADDER8, 'verilogeval/adder8');

    expect(renderLegacyGoldenDesign(adder8).contents).toBe(
      renderLegacyGoldenDesign(adder8).contents,
    );
  });
});

describe('renderLegacyGoldenCorpus', () => {
  it('renders every problem given, in order, each keyed by its own id', () => {
    const problems = [required(ADDER8, 'verilogeval/adder8'), required(COUNTER4, 'rtllm/counter4')];
    const designs = renderLegacyGoldenCorpus(problems);

    expect(designs.map((design) => design.problemId)).toEqual(
      problems.map((problem) => problem.id),
    );
  });
});
