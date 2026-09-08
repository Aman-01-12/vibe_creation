// Deterministic, dependency-free helpers for the Iteration_Agent: the edit-time
// demotion, the Module_Interface change detector, and the RTL line diff presented
// with the new verdict (Req 10.2, 10.6, 10.7).
//
// These are pure functions with no I/O and no model calls, so the demotion
// (Property 20) and the spec-consistent, interface-aware re-verification
// (Property 21) can be stated directly over them.

import {
  unverified,
  type LabeledArtifact,
  type ModuleInterface,
  type UnverifiedArtifact,
} from '@app/core';

import type { DiffLine } from './types.js';

/**
 * Demote the edited module to `Unverified` (Req 10.7).
 *
 * Demotion is expressed by DERIVING an `Unverified` label for the edited artifact,
 * not by clearing a flag: editing produces a new design with no passing oracle span
 * yet, so it cannot be `Verified` until the Verification_Loop records a fresh pass.
 * This is idempotent for a module that was already `Unverified` or `Not_Applicable`.
 */
export function demoteOnEdit(edited: LabeledArtifact): UnverifiedArtifact {
  return unverified(edited.artifactRef);
}

/** Whether two ports declare the same name, direction, and bit width. */
function portsEqual(
  a: ModuleInterface['ports'][number],
  b: ModuleInterface['ports'][number],
): boolean {
  return a.name === b.name && a.direction === b.direction && a.width === b.width;
}

/** Whether two clocking contracts are identical. */
function clockingEqual(a: ModuleInterface['clocking'], b: ModuleInterface['clocking']): boolean {
  return (
    a.clockName === b.clockName &&
    a.resetName === b.resetName &&
    a.resetActiveLow === b.resetActiveLow
  );
}

/**
 * Whether two Module_Interfaces are structurally identical (Req 10.2).
 *
 * Compares the module name, the ordered ports (name, direction, width), and the
 * clocking contract. Any difference means the iteration changed the interface, so
 * the Spec must be updated and the Testbench regenerated from the updated Spec.
 */
export function moduleInterfacesEqual(a: ModuleInterface, b: ModuleInterface): boolean {
  if (a.moduleName !== b.moduleName || a.ports.length !== b.ports.length) {
    return false;
  }
  if (!clockingEqual(a.clocking, b.clocking)) {
    return false;
  }
  return a.ports.every((port, index) => portsEqual(port, b.ports[index]!));
}

/** Whether the iteration changed the Module_Interface (drives Spec/Testbench regen). */
export function interfaceChangedBetween(previous: ModuleInterface, next: ModuleInterface): boolean {
  return !moduleInterfacesEqual(previous, next);
}

/** Split source into lines without keeping a trailing empty element for a final newline. */
function toLines(source: string): readonly string[] {
  if (source.length === 0) {
    return [];
  }
  const lines = source.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') {
    return lines.slice(0, -1);
  }
  return lines;
}

/** Build the longest-common-subsequence length table for two line sequences. */
function lcsTable(previous: readonly string[], next: readonly string[]): number[][] {
  const table: number[][] = Array.from({ length: previous.length + 1 }, () =>
    new Array<number>(next.length + 1).fill(0),
  );
  for (let i = previous.length - 1; i >= 0; i -= 1) {
    for (let j = next.length - 1; j >= 0; j -= 1) {
      table[i]![j] =
        previous[i] === next[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  return table;
}

/**
 * Build a line-level diff from the previous RTL to the new RTL (Req 10.6).
 *
 * Uses a longest-common-subsequence walk so shared lines are `context`, lines only
 * in the previous version are `removed`, and lines only in the new version are
 * `added`. A `null` previous version (no baseline) yields an all-`added` diff.
 */
export function buildRtlDiff(previousRtl: string | null, newRtl: string): readonly DiffLine[] {
  const previous = previousRtl === null ? [] : toLines(previousRtl);
  const next = toLines(newRtl);
  const table = lcsTable(previous, next);
  const diff: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < previous.length && j < next.length) {
    if (previous[i] === next[j]) {
      diff.push({ kind: 'context', text: previous[i]! });
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      diff.push({ kind: 'removed', text: previous[i]! });
      i += 1;
    } else {
      diff.push({ kind: 'added', text: next[j]! });
      j += 1;
    }
  }
  for (; i < previous.length; i += 1) {
    diff.push({ kind: 'removed', text: previous[i]! });
  }
  for (; j < next.length; j += 1) {
    diff.push({ kind: 'added', text: next[j]! });
  }
  return diff;
}
