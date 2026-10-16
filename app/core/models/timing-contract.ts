// The Timing_Contract: whether each declared output port settles
// combinationally or on a clock edge (C5).
//
// Sits beside `ModuleInterface` on `Spec`, not on `Port`: an input port has no
// settling time, the contract is amended by student answers to
// Behaviour_Questions on a different schedule from the interface, and omission
// must be representable (Req 6.4), which a constructor-enforced `Port` field
// cannot do. `makeTimingContract` is the sole supported constructor and leaves
// no default branch, so a gap is always a named refusal rather than a guess
// (Req 6.2).

import { domainError, type DomainError } from './domain-error.js';
import { err, ok, type Result } from './result.js';
import type { ModuleInterface } from './spec.js';

/** Whether a declared output port settles combinationally or on a clock edge. */
export type PortTiming = 'registered' | 'combinational';

/**
 * The closed `PortTiming` vocabulary, checked by `Set` membership.
 *
 * Never indexed as a `Record<PortTiming, ...>`: a record index stringifies and
 * walks the prototype chain, so `record['__proto__']` or `record['constructor']`
 * reads as a real member even when neither was ever set. `Set.has` has no such
 * coercion.
 */
const PORT_TIMINGS: ReadonlySet<PortTiming> = new Set(['registered', 'combinational']);

/** Narrow an untrusted string to the closed `PortTiming` union, by membership. */
export function isPortTiming(value: string): value is PortTiming {
  return PORT_TIMINGS.has(value as PortTiming);
}

/** One declared output port's timing. */
export interface TimingContractEntry {
  readonly portName: string;
  readonly timing: PortTiming;
}

/**
 * Total over the output ports of one `ModuleInterface`, by construction.
 *
 * `entries` is a list rather than a `Record<string, PortTiming>`, for the same
 * key-coercion reason `PortTiming` is decoded by `Set` membership above: a
 * record keyed by port name would read a port literally named `__proto__` or
 * `constructor` through the prototype chain instead of through an explicit
 * entry.
 */
export interface TimingContract {
  readonly entries: readonly TimingContractEntry[];
}

/** The declared output port names of `moduleInterface`, as a `Set`. */
function outputPortNames(moduleInterface: ModuleInterface): ReadonlySet<string> {
  return new Set(
    moduleInterface.ports.filter((port) => port.direction === 'output').map((port) => port.name),
  );
}

/** Build the `MISSING_PORT_TIMING` error naming every uncovered output port. */
function missingPortTimingError(missingPortNames: readonly string[]): DomainError {
  return domainError(
    'MISSING_PORT_TIMING',
    `Missing timing entries for output port(s): ${missingPortNames.join(', ')}`,
  );
}

/**
 * Construct a `TimingContract`, requiring exactly one entry per declared output
 * port of `moduleInterface` and no entry for anything else.
 *
 * Refuses an entry naming a port that is not a declared output
 * (`TIMING_ENTRY_NOT_AN_OUTPUT_PORT`), a second entry for one port
 * (`DUPLICATE_PORT_TIMING_ENTRY`), and a `declared` list that omits any output
 * port (`MISSING_PORT_TIMING`, naming every omitted port at once rather than
 * only the first). There is no default branch: a gap is always one of these
 * named refusals, never a guessed value (Req 6.2).
 */
export function makeTimingContract(
  moduleInterface: ModuleInterface,
  declared: readonly TimingContractEntry[],
): Result<TimingContract, DomainError> {
  const outputNames = outputPortNames(moduleInterface);
  const seenPortNames = new Set<string>();
  for (const entry of declared) {
    if (!outputNames.has(entry.portName)) {
      return err(
        domainError(
          'TIMING_ENTRY_NOT_AN_OUTPUT_PORT',
          `"${entry.portName}" is not a declared output port`,
          'portName',
        ),
      );
    }
    if (seenPortNames.has(entry.portName)) {
      return err(
        domainError(
          'DUPLICATE_PORT_TIMING_ENTRY',
          `"${entry.portName}" has more than one timing entry`,
          'portName',
        ),
      );
    }
    seenPortNames.add(entry.portName);
  }
  const missingPortNames = [...outputNames].filter((name) => !seenPortNames.has(name));
  if (missingPortNames.length > 0) {
    return err(missingPortTimingError(missingPortNames));
  }
  return ok({ entries: declared });
}
