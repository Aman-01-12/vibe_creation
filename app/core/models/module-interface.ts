// The validating constructor for `ModuleInterface` (C5).
//
// `ModuleInterface` itself stays in `./spec.js`, where it has lived since this
// aggregate was introduced; this file holds only the invariant that governs its
// `validityOutputName` field: when present, the name must identify one of the
// interface's own declared output ports. `makeModuleInterface` is the sole
// supported constructor, the same way `makePort` is the sole supported
// constructor for the positive-width invariant.

import { domainError, type DomainError } from './domain-error.js';
import { err, ok, type Result } from './result.js';
import type { ClockingContract, ModuleInterface, Port } from './spec.js';

/** Fields a caller supplies to build a `ModuleInterface`. */
interface ModuleInterfaceInput {
  readonly moduleName: string;
  readonly ports: readonly Port[];
  readonly clocking: ClockingContract;
  /** Omit to declare no Validity_Output; the built interface then reads `null`. */
  readonly validityOutputName?: string | null;
}

/**
 * Construct a `ModuleInterface`, validating that `validityOutputName`, when
 * present, names one of `ports`' own declared output ports.
 *
 * This is the sole supported constructor for `ModuleInterface`. The input field
 * is optional so a caller that declares no Validity_Output simply omits it; the
 * output field is always present and filled with `null` in that case, so a
 * caller reads back an explicit absence rather than two spellings of "none".
 */
export function makeModuleInterface(
  input: ModuleInterfaceInput,
): Result<ModuleInterface, DomainError> {
  const validityOutputName = input.validityOutputName ?? null;
  if (validityOutputName !== null && !namesDeclaredOutputPort(input.ports, validityOutputName)) {
    return err(
      domainError(
        'VALIDITY_OUTPUT_NOT_A_DECLARED_OUTPUT_PORT',
        'validityOutputName must name a declared output port',
        'validityOutputName',
      ),
    );
  }
  return ok({
    moduleName: input.moduleName,
    ports: input.ports,
    clocking: input.clocking,
    validityOutputName,
  });
}

/** Return whether `name` identifies one of `ports`' declared output ports. */
function namesDeclaredOutputPort(ports: readonly Port[], name: string): boolean {
  return ports.some((port) => port.direction === 'output' && port.name === name);
}
