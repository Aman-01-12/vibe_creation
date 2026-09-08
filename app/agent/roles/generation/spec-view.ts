// The Spec Module_Interface as the flat, generation-facing port set.
//
// The Spec keeps declared ports separate from the clock/reset contract, but a
// Verilog module header lists clock and reset as ordinary input ports. This module
// is the single place that flattens the Spec into the full expected port set
// (declared ports plus width-1 clock/reset inputs), so the prompt, the interface
// exactness check, and the compile harness all agree on exactly which ports a
// candidate must expose (Req 6.1, 6.4). Deriving it once keeps a single owner.

import type { ModuleInterface, Spec } from '@app/core';

import type { PortSignature } from './types.js';

/** The flattened, generation-facing view of a Spec's module interface. */
export interface ModelInterfacePortsView {
  readonly moduleName: string;
  /** Declared ports plus the clock/reset contract, as width-annotated signatures. */
  readonly ports: readonly PortSignature[];
}

/** The clock and reset signals a module must expose as width-1 input ports. */
function clockingPorts(moduleInterface: ModuleInterface): readonly PortSignature[] {
  const ports: PortSignature[] = [];
  const { clockName, resetName } = moduleInterface.clocking;
  if (clockName !== null) {
    ports.push({ name: clockName, direction: 'input', width: 1 });
  }
  if (resetName !== null) {
    ports.push({ name: resetName, direction: 'input', width: 1 });
  }
  return ports;
}

/** The full set of ports the Spec requires: declared ports plus clock/reset. */
export function expectedInterfacePorts(moduleInterface: ModuleInterface): readonly PortSignature[] {
  const declared: PortSignature[] = moduleInterface.ports.map((port) => ({
    name: port.name,
    direction: port.direction,
    width: port.width,
  }));
  return [...declared, ...clockingPorts(moduleInterface)];
}

/** Flatten a Spec into the generation-facing interface view. */
export function specInterfaceView(spec: Spec): ModelInterfacePortsView {
  return {
    moduleName: spec.moduleInterface.moduleName,
    ports: expectedInterfacePorts(spec.moduleInterface),
  };
}
