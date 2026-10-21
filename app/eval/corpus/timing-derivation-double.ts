// Test doubles for the Timing_Derivation seam, kept OUT of `timing-derivation-port.ts` the
// way `@app/tools`' `fake-runtime.ts` is kept out of the sandbox seam it stands in for: a
// double that sits in the production module is a double one composition root away from
// production.
//
// WHY A FIXED DOUBLE EXISTS AT ALL
//   Most suites that import the corpus want its problem ids, its golden testbenches, or its
//   reference RTL, and never read `timingContract`. Handing those the real derivation would
//   run one Yosys elaboration per design per suite, and handing them a REFUSING port would
//   quarantine every design and leave them asserting over an empty corpus. So they state a
//   fixed timing and move on.
//
// WHY `timing` IS REQUIRED AND HAS NO DEFAULT
//   An all-`registered` default is exactly the fabrication the importer was carrying, and it
//   made 13 purely combinational designs unwinnable. A caller naming the value in its own
//   source is what keeps the stand-in visible at the call site rather than inherited.

import {
  err,
  makeTimingContract,
  type ModuleInterface,
  type PortTiming,
  type Result,
  type TimingContract,
} from '@app/core';
import type { TimingRefusal } from '@app/tools';

import type { TimingDerivationPort } from './timing-derivation-port.js';

/**
 * A `TimingDerivationPort` placing every declared output port at one caller-named timing.
 *
 * FOR TESTS AND HARNESSES ONLY; never compose this into a measurement whose result is read
 * as a Port_Timing fact. It derives nothing from the design, so what it reports is whatever
 * the caller asked for.
 */
export class FixedTimingDerivation implements TimingDerivationPort {
  readonly #timing: PortTiming;

  constructor(timing: PortTiming) {
    this.#timing = timing;
  }

  derive(request: {
    readonly moduleInterface: ModuleInterface;
  }): Promise<Result<TimingContract, TimingRefusal>> {
    const entries = request.moduleInterface.ports
      .filter((port) => port.direction === 'output')
      .map((port) => ({ portName: port.name, timing: this.#timing }));
    const built = makeTimingContract(request.moduleInterface, entries);
    if (!built.ok) {
      // Unreachable: `entries` names this interface's own output ports, once each.
      throw new Error(`the fixed timing double built an invalid contract: ${built.error.message}`);
    }
    return Promise.resolve(built);
  }
}

/**
 * A `TimingDerivationPort` refusing every design with one caller-named refusal.
 *
 * The negative control for the importer's exclusion path: a suite asserting that a refused
 * design is quarantined with its cause needs a port that refuses deterministically.
 */
export class RefusingTimingDerivation implements TimingDerivationPort {
  readonly #refusal: TimingRefusal;

  constructor(refusal: TimingRefusal) {
    this.#refusal = refusal;
  }

  derive(): Promise<Result<TimingContract, TimingRefusal>> {
    return Promise.resolve(err(this.#refusal));
  }
}
