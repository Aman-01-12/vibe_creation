// Property 3 over `PROPERTY_FIXTURE`. The collection is fixed, so the three clauses are checked
// exhaustively over it, and fast-check then generalizes them to any entry the helpers build, so a
// later entry is covered without this file changing. See design.md, Component C4.
//
// **Validates: Requirements 2.1, 2.3, 2.9**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { propertyShapeRejection, validateExpression, type FormalProperty } from '@app/tools';

import { arbPropertyText } from './formal-arbitraries.js';
import {
  clockedProperty,
  combinationalProperty,
  guardedProperty,
  PROPERTY_FIXTURE,
  type FixtureProperty,
} from './formal-fixtures.js';
import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 3: Every Fixture_Property is validated, attributed, and source-free
const PROPERTY =
  'formal-gate-first-light, Property 3: Every Fixture_Property is validated, attributed, and source-free';

/** The exact fields an entry carries. A fifth would be a channel source text could ride in. */
const ENTRY_FIELDS = ['criterionRef', 'designId', 'expectedVerdict', 'property'] as const;

/** The closed verdict vocabulary an author may state. */
const VERDICTS = ['proved', 'refuted', 'could-not-verify'] as const;

/**
 * Verilog keywords no expression can legitimately carry, because none is a legal identifier.
 * Their presence would mean design source text, not a property.
 */
const STRUCTURAL_KEYWORD =
  /\b(module|endmodule|always|assign|initial|begin|end|input|output|inout|reg|wire|parameter|localparam)\b/;

/** Every expression one entry carries, which is the whole text that reaches the renderer. */
function expressionsOf(property: FormalProperty): readonly string[] {
  if (property.kind === 'combinational') {
    return [property.consequent];
  }
  return [
    property.clock,
    property.consequent,
    ...(property.antecedent === null ? [] : [property.antecedent]),
  ];
}

/** The three clauses, over one entry, wherever it came from. */
function clauseFailuresOf(entry: FixtureProperty): readonly string[] {
  const failures: string[] = [];
  const label = entry.property.id;

  // Validated: re-run the sole constructor. An entry cast past the brand fails here.
  for (const expression of expressionsOf(entry.property)) {
    if (!validateExpression(expression).ok) {
      failures.push(`${label}: an expression the Property_Validator refuses`);
    }
  }

  // Attributed: the design, the criterion, and the author's expectation.
  if (entry.designId.trim().length === 0) {
    failures.push(`${label}: no designId`);
  }
  if (entry.criterionRef.trim().length === 0) {
    failures.push(`${label}: no criterionRef`);
  }
  if (!VERDICTS.includes(entry.expectedVerdict)) {
    failures.push(`${label}: expected verdict outside the vocabulary`);
  }
  if (label.trim().length === 0) {
    failures.push('an entry with no property id');
  }

  // Source-free: a fixed field set, and no expression that looks like design source.
  if ([...Object.keys(entry)].sort().join(',') !== [...ENTRY_FIELDS].join(',')) {
    failures.push(`${label}: fields other than the four an entry carries`);
  }
  for (const expression of expressionsOf(entry.property)) {
    if (expression.includes('\n') || expression.includes(';')) {
      failures.push(`${label}: an expression spanning a statement`);
    }
    if (STRUCTURAL_KEYWORD.test(expression)) {
      failures.push(`${label}: an expression carrying a structural keyword`);
    }
  }
  return failures;
}

describe(PROPERTY, () => {
  it('holds for every entry the shipped fixture carries', () => {
    // Non-vacuity: a fixture that lost its entries would pass the loop below silently.
    expect(PROPERTY_FIXTURE.length).toBeGreaterThan(0);

    expect(PROPERTY_FIXTURE.flatMap(clauseFailuresOf)).toEqual([]);
  });

  it('names the design each entry covers by identifier, never by its source', () => {
    // The mechanism that keeps source out: an entry points at the corpus rather than holding RTL.
    const notAnIdentifier = PROPERTY_FIXTURE.filter(
      (entry) => !/^[A-Za-z0-9_\-/]+$/.test(entry.designId),
    ).map((entry) => entry.property.id);

    expect(notAnIdentifier).toEqual([]);
  });

  it('holds for any entry the fixture helpers build, so a later entry is covered', () => {
    let accepted = 0;
    let refused = 0;

    fc.assert(
      fc.property(arbPropertyText(), fc.integer({ min: 0, max: 2 }), (text, shape) => {
        // Only the accepted arm is this property's; the refused arm is Property 4's.
        const expression = validateExpression(text);
        if (!expression.ok) {
          refused += 1;
          return;
        }
        accepted += 1;
        // A combinational `$past` or `$stable` is refused where a property is ASSEMBLED, so the
        // helper throws for that draw rather than returning an entry. That refusal is Property
        // 37's, not this one's, so the draw leaves here instead of being filtered out upstream.
        if (
          shape === 0 &&
          propertyShapeRejection({
            kind: 'combinational',
            id: 'generated-combinational',
            criterionRef: '2.1',
            consequent: expression.value,
          }) !== null
        ) {
          return;
        }
        const built: FormalProperty =
          shape === 0
            ? combinationalProperty('generated-combinational', text)
            : shape === 1
              ? clockedProperty('generated-clocked', text, text)
              : guardedProperty('generated-guarded', text, text, text);

        expect(
          clauseFailuresOf({
            designId: 'rtllm/arithmetic/adder_8bit',
            criterionRef: '2.1',
            property: built,
            expectedVerdict: 'proved',
          }),
        ).toEqual([]);
      }),
      propertyParameters(),
    );

    expect(accepted, 'no draw produced an in-dialect expression').toBeGreaterThan(0);
    expect(refused, 'no draw produced a refused expression').toBeGreaterThan(0);
  });
});
