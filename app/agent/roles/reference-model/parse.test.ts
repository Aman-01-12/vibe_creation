// Reference_Model parser boundary tests (tasks 10.2, 19.2).
// Each refusal case differs from the valid reply in exactly one way, so a refusal cannot pass
// for the wrong reason (for example, the entry count).

import type { ModuleInterface } from '@app/core';
import { describe, expect, it } from 'vitest';

import { parseReferenceModelDraft } from './parse.js';

type Entry = { readonly name: string; readonly body: string };
type RoleEntry = { readonly port: string; readonly role: string };

const VALID: readonly Entry[] = [
  { name: 'ece_reset_state', body: "ece_reset_state = 128'd10;" },
  { name: 'ece_next_state', body: 'ece_next_state = s;' },
  { name: 'ece_expect', body: "ece_expect = 1'b0;" },
];

const VALID_ROLES: readonly RoleEntry[] = [{ port: 'en', role: 'data' }];

const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'm',
  ports: [
    { name: 'en', direction: 'input', width: 1 },
    { name: 'out', direction: 'output', width: 1 },
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

function reply(functions: readonly Entry[], roles: readonly RoleEntry[] = VALID_ROLES): string {
  return JSON.stringify({ functions, roles });
}

function withEntry(index: number, entry: Entry): readonly Entry[] {
  return VALID.map((original, at) => (at === index ? entry : original));
}

function parse(functions: readonly Entry[], roles: readonly RoleEntry[] = VALID_ROLES) {
  return parseReferenceModelDraft(reply(functions, roles), MODULE_INTERFACE);
}

describe('parseReferenceModelDraft', () => {
  it('given a well-formed reply when parsed then it extracts the three bodies and the roles', () => {
    const result = parse(VALID);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.resetStateBody).toContain('ece_reset_state');
      expect(result.value.nextStateBody).toContain('ece_next_state');
      expect(result.value.expectBody).toContain('ece_expect');
      expect(result.value.roles).toEqual([{ portName: 'en', role: 'data' }]);
    }
  });

  it('given a reply still carrying a stimulus function when parsed then it refuses', () => {
    expect(parse([...VALID, { name: 'ece_stimulus', body: "ece_stimulus = {1{1'b0}};" }]).ok).toBe(
      false,
    );
  });

  it('given four function entries when parsed then it refuses', () => {
    expect(parse([...VALID, { name: 'ece_extra', body: 'w' }]).ok).toBe(false);
  });

  it('given a duplicate function name when parsed then it refuses', () => {
    expect(parse(withEntry(0, { name: 'ece_next_state', body: 'x' })).ok).toBe(false);
  });

  it('given an unexpected function name when parsed then it refuses', () => {
    expect(parse(withEntry(2, { name: 'not_a_real_function', body: 'z' })).ok).toBe(false);
  });

  it('given an empty body when parsed then it refuses', () => {
    expect(parse(withEntry(0, { name: 'ece_reset_state', body: '' })).ok).toBe(false);
  });

  it('given a non-JSON reply when parsed then it refuses', () => {
    expect(parseReferenceModelDraft('not json at all', MODULE_INTERFACE).ok).toBe(false);
  });

  it('given a reply wrapped in a markdown fence when parsed then it still extracts', () => {
    expect(
      parseReferenceModelDraft('```json\n' + reply(VALID) + '\n```', MODULE_INTERFACE).ok,
    ).toBe(true);
  });

  it('given a body over the length bound when parsed then it refuses', () => {
    const oversized = withEntry(0, { name: 'ece_reset_state', body: 'x'.repeat(20_001) });
    expect(parse(oversized).ok).toBe(false);
  });

  it('given no roles array when parsed then it refuses with the no-roles reason', () => {
    const result = parseReferenceModelDraft(JSON.stringify({ functions: VALID }), MODULE_INTERFACE);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('model output carried no roles array');
    }
  });

  it('given a malformed role entry when parsed then it refuses with the malformed-entry reason', () => {
    const result = parseReferenceModelDraft(
      JSON.stringify({ functions: VALID, roles: [{ port: 'en' }] }),
      MODULE_INTERFACE,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('model output had a malformed role entry');
    }
  });

  it('given a role outside the vocabulary when parsed then it refuses with the vocabulary reason', () => {
    // Not 'strobe': that name joined the Role_Vocabulary itself, so a hardcoded guess here would
    // stop being outside it the moment the vocabulary widened to include it.
    const result = parse(VALID, [{ port: 'en', role: 'not_a_real_role' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe(
        'model output named a role outside {data, enable, strobe, hold}',
      );
    }
  });

  it('given an empty port name when parsed then it refuses at the envelope step, not as an undeclared port', () => {
    const result = parse(VALID, [{ port: '', role: 'data' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('model output named an empty port name for role "data"');
    }
  });

  it('given more role entries than the interface declares input ports when parsed then it refuses, even though every entry is otherwise well-formed', () => {
    const result = parse(VALID, [
      { port: 'en', role: 'data' },
      { port: 'extra', role: 'data' },
    ]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe(
        'model output carried more role entries than the interface declares input ports',
      );
    }
  });

  it('given one input port named twice when parsed then it refuses with the duplicate reason', () => {
    // Two input ports declared, so two entries is not ALSO a too-many-entries fault - this
    // isolates the duplicate-port check from the entry-count check added for criterion 2.10.
    const twoInputInterface: ModuleInterface = {
      ...MODULE_INTERFACE,
      ports: [...MODULE_INTERFACE.ports, { name: 'en2', direction: 'input', width: 1 }],
    };
    const result = parseReferenceModelDraft(
      reply(VALID, [
        { port: 'en', role: 'data' },
        { port: 'en', role: 'enable' },
      ]),
      twoInputInterface,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('model output named one input port twice');
    }
  });

  it('given a port the interface does not declare when parsed then it refuses with the undeclared-port reason', () => {
    const result = parse(VALID, [{ port: 'nope', role: 'data' }]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('model output named a port the interface does not declare');
    }
  });

  it('given an omitted input port when parsed then it refuses with the omitted-port reason', () => {
    const result = parse(VALID, []);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('model output omitted an input port');
    }
  });

  it('reports the first fault, in fixed check order, when a reply carries two faults', () => {
    // A malformed role entry AND an out-of-vocabulary role elsewhere: malformed wins (check 2 before 3).
    const result = parse(VALID, [{ port: 'en' } as unknown as RoleEntry]);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.reason).toBe('model output had a malformed role entry');
    }
  });
});
