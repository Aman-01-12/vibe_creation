// Unit tests for the design-description reader.
//
// The description is untrusted third-party text and is the source of the module name
// the golden testbench instantiates, so these tests pin down three things: that the
// module name is read from the labeled field in both layouts upstream uses, that LLM
// prompt scaffolding never leaks into a Spec goal, and that a description we cannot
// read is REFUSED (so the design is quarantined) rather than yielding an empty goal.

import { describe, expect, it } from 'vitest';

import { parseDesignDescription, type DesignDescription } from './design-description.js';

/** Parse a description, failing the test if it did not parse. */
function parsed(raw: string): DesignDescription {
  const result = parseDesignDescription(raw);
  if (!result.ok) {
    throw new Error(`expected the description to parse but got: ${result.reason}`);
  }
  return result.description;
}

/** The refusal reason, failing the test if the description parsed. */
function reason(raw: string): string {
  const result = parseDesignDescription(raw);
  if (result.ok) {
    throw new Error('expected the description to be refused but it parsed');
  }
  return result.reason;
}

/** The common layout: prose first, module name on the following line. */
const PROSE_FIRST = `Please act as a professional verilog designer.
Implement a module of an 8-bit adder with multiple bit-level adders in combinational logic.
Module name:
    adder_8bit
Input ports:
    a[7:0]: 8-bit input operand A.
Output ports:
    sum[7:0]: 8-bit output representing the sum of A and B.
Implementation:
The module utilizes a series of bit-level adders (full adders) to perform the addition.
Give me the complete code.
`;

/** The other layout: module name first, behaviour under an explicit `Function:` label. */
const FUNCTION_LABELLED = `Please act as a professional Verilog designer.
Module name: 
    up_down_counter
Function:
    A 16-bit counter that can increment or decrement based on control signals.
Input ports:
    clk: Clock signal (1-bit).
Output ports:
    count [15:0]: 16-bit output representing the current counter value.
Implementation:
    The module uses a synchronous process triggered by the rising edge of clk.
Give me the complete code.
`;

describe('parseDesignDescription - the module name (what the judge instantiates)', () => {
  it('reads the module name from the line after the label', () => {
    expect(parsed(PROSE_FIRST).moduleName).toBe('adder_8bit');
  });

  it('reads the module name from the label line itself when it is inline', () => {
    expect(parsed('Do a thing.\nModule name: my_mod\n').moduleName).toBe('my_mod');
  });

  it('tolerates trailing whitespace after the label', () => {
    expect(parsed(FUNCTION_LABELLED).moduleName).toBe('up_down_counter');
  });
});

describe('parseDesignDescription - the problem statement', () => {
  it('takes the unlabeled prose above the first labeled field', () => {
    expect(parsed(PROSE_FIRST).statement).toBe(
      'Implement a module of an 8-bit adder with multiple bit-level adders in combinational logic.',
    );
  });

  it('takes the `Function:` section when the behaviour is labelled instead', () => {
    expect(parsed(FUNCTION_LABELLED).statement).toBe(
      'A 16-bit counter that can increment or decrement based on control signals.',
    );
  });

  it('strips the LLM prompt scaffolding from both ends', () => {
    const description = parsed(PROSE_FIRST);
    expect(description.statement).not.toContain('professional verilog designer');
    expect(description.statement).not.toContain('complete code');
    expect(description.implementation).not.toContain('complete code');
  });

  it('stops the statement at the first labeled field, never absorbing the port prose', () => {
    // Port widths must come from the reference RTL, so they must not leak into the goal.
    expect(parsed(PROSE_FIRST).statement).not.toContain('8-bit input operand A');
  });
});

describe('parseDesignDescription - the implementation note', () => {
  it('reads the implementation section as the architecture note', () => {
    expect(parsed(PROSE_FIRST).implementation).toBe(
      'The module utilizes a series of bit-level adders (full adders) to perform the addition.',
    );
  });

  it('reports an empty note when the description has no implementation section', () => {
    expect(parsed('Do a thing.\nModule name: m\n').implementation).toBe('');
  });
});

describe('parseDesignDescription - refusals (quarantine, never an empty Spec)', () => {
  it('refuses a description with no module name field', () => {
    expect(reason('Implement an adder.\n')).toContain('no "Module name:" field');
  });

  it('refuses a module name that is not a Verilog identifier', () => {
    expect(reason('Do a thing.\nModule name: 8bit-adder!\n')).toContain('not a Verilog identifier');
  });

  it('refuses a description carrying no behavioural statement at all', () => {
    expect(reason('Module name: m\nInput ports:\n    a: one bit.\n')).toContain(
      'no problem statement',
    );
  });

  it('refuses oversized input rather than reading it', () => {
    expect(reason(`Module name: m\n${'pad\n'.repeat(10_000)}`)).toContain('maximum readable size');
  });
});
