// The composition root for the REAL Timing_Derivation on this host, split from
// `timing-derivation-port.ts` the way `fetch-node.ts` is split from `fetch.ts`: the seam
// stays runtime-free and injectable, and the Node-and-worker wiring lives here.
//
// ONE RETENTION STORE, HANDED TO BOTH SIDES
//   `SandboxResult.artifacts` carries refs and no bytes, and the runtime removes the
//   workspace in a `finally`, so the derivation could not read back the pre-pass report it
//   just produced. One `BoundedArtifactRetention` goes to the runtime that fills it and to
//   the derivation that reads it, so a ref cannot resolve to different bytes.
//
// AN ABSENT TOOLCHAIN THROWS RATHER THAN REFUSING
//   A host with no worker-capable Python cannot elaborate a netlist, so every design would
//   refuse and the import would hand back a corpus of zero designs - which reads as "the
//   checkout is empty" and not as "this host has no toolchain". Failing at the composition
//   root names the real cause instead.

import {
  BoundedArtifactRetention,
  LocalWorkerRuntime,
  SandboxToolRunner,
  type ResourceLimits,
} from '@app/tools';

import { findWorkerPython } from '../sweep/host-facts.js';
import { FormalPrepassTimingDerivation } from './timing-derivation-port.js';

/**
 * The caps one design's pre-pass runs under.
 *
 * `memMb` is wide because elaboration, not solving, is the expensive part of this job, and
 * `wallMs` is generous because it is paid once per design in an import that runs for minutes
 * either way; the real pre-pass is measured at roughly 0.7 s per design.
 */
export const TIMING_DERIVATION_LIMITS: ResourceLimits = Object.freeze({
  cpu: 1,
  memMb: 1024,
  procs: 128,
  diskMb: 256,
  wallMs: 60_000,
});

/**
 * The real Timing_Derivation over this host's sandbox worker.
 *
 * Probes for a worker-capable Python itself, so a caller that already has none of this
 * wiring threads a derivation through in one line. Throws when the probe finds none; see
 * the module header for why that is louder than refusing every design.
 */
export function localTimingDerivation(): FormalPrepassTimingDerivation {
  const pythonBin = findWorkerPython();
  if (pythonBin === null) {
    throw new Error(
      'no Python interpreter can import the tool_runner_worker package, so no Timing_Contract can be derived for the corpus',
    );
  }
  const artifacts = new BoundedArtifactRetention();
  const runtime = new LocalWorkerRuntime(pythonBin, undefined, artifacts);
  return new FormalPrepassTimingDerivation({
    toolRunner: new SandboxToolRunner(runtime),
    artifacts,
    limits: TIMING_DERIVATION_LIMITS,
  });
}
