// The Timing_Derivation seam: one design's RTL plus its `ModuleInterface` in, a Timing_Contract or
// one named Timing_Refusal out (timing-contract-inference design.md Component 4; Req 2.3, 3.1).
//
// A PORT, shaped like `CorpusCheckoutPort` next door and injected the same way, for the same
// reason: the Corpus_Importer must not know about Yosys, a sandbox job, or an artifact store, so
// injecting this is what keeps the whole import unit-testable with no toolchain present.
//
// `netlist-unavailable` IS A FACT ABOUT OUR INSTRUMENT, AND THAT DISTINCTION IS THE REQUIREMENT
//   Three situations produce it here, and they are the only three: the run registered no report
//   artifact, the report failed `parseFormalPrepassReport`, or the run itself errored and the
//   toolchain may have been absent. None of them may arrive as `port-not-reported`,
//   `netlist-walk-unreliable`, `undriven-output-port`, or `input-and-state-independent`, because
//   those four are facts about a DESIGN and reporting one here would exclude a design for a tool
//   WE failed to run (Req 2.3). The two sets stay disjoint by construction rather than by care:
//   `classifyPortTiming` cannot produce `netlist-unavailable`, and nothing below produces any
//   other cause.
//
// NOTHING FROM A REJECTION IS CARRIED THROUGH
//   `FormalPrepassRejection`'s `schema-violation` arm carries ajv issue strings, which are tool
//   diagnostic text. Req 2.5 admits declared port names and a closed cause token and nothing else,
//   so the rejection is read for whether it happened and then dropped.

import { err, type ModuleInterface, type Result, type TimingContract } from '@app/core';
import {
  assembleFormalPrepassJob,
  classifyPortTiming,
  parseFormalPrepassReport,
  type ArtifactTextReader,
  type ResourceLimits,
  type SandboxJob,
  type SandboxResult,
  type SourceFile,
  type TimingRefusal,
  type ToolRunner,
} from '@app/tools';

/** One design's Timing_Contract, derived from the formal pre-pass over its own RTL. */
export interface TimingDerivationPort {
  /**
   * Derive the Timing_Contract for one design, or the refusal that excludes it.
   *
   * The request carries NO top module name, and one must not be added:
   * `assembleFormalPrepassJob` already takes the `-top` from `moduleInterface.moduleName`, so a
   * second name here could disagree with the one the pre-pass actually elaborates. The importer
   * passes the renamed reference RTL, so that one name is also the module the harness will see.
   */
  derive(request: {
    readonly rtl: SourceFile;
    readonly moduleInterface: ModuleInterface;
  }): Promise<Result<TimingContract, TimingRefusal>>;
}

/**
 * The refusal for every shape of missing evidence from our own instrument.
 *
 * Names EVERY declared output port, which is Req 2.2's "every" rather than "the first": an absent
 * or unreadable finding establishes nothing about any of them, so none is determined. Deduplicated
 * the way `makeTimingContract` deduplicates, so a name cannot be reported twice.
 */
function netlistUnavailable(moduleInterface: ModuleInterface): TimingRefusal {
  return {
    cause: 'netlist-unavailable',
    ports: [
      ...new Set(
        moduleInterface.ports
          .filter((port) => port.direction === 'output')
          .map((port) => port.name),
      ),
    ],
  };
}

/**
 * A `TimingDerivationPort` backed by the formal pre-pass over the injected Tool_Runner.
 *
 * The `ToolRunner` and the `ArtifactTextReader` are injected, so a fake-runtime-backed runner
 * drives this with no Yosys installed and the real local-worker runtime drives it with one. No
 * concrete sandbox runtime is named here, and the resource caps are constructor state rather than
 * a per-call argument, because every design is derived under the same caps.
 */
export class FormalPrepassTimingDerivation implements TimingDerivationPort {
  readonly #toolRunner: ToolRunner;
  readonly #artifacts: ArtifactTextReader;
  readonly #limits: ResourceLimits;

  constructor(deps: {
    readonly toolRunner: ToolRunner;
    readonly artifacts: ArtifactTextReader;
    readonly limits: ResourceLimits;
  }) {
    this.#toolRunner = deps.toolRunner;
    this.#artifacts = deps.artifacts;
    this.#limits = deps.limits;
  }

  async derive(request: {
    readonly rtl: SourceFile;
    readonly moduleInterface: ModuleInterface;
  }): Promise<Result<TimingContract, TimingRefusal>> {
    const job = assembleFormalPrepassJob(request.rtl, request.moduleInterface, this.#limits);
    const text = await this.#reportText(job);
    if (text === null) {
      return err(netlistUnavailable(request.moduleInterface));
    }
    const parsed = parseFormalPrepassReport(text);
    if (!parsed.ok) {
      // Every rejection reason is the same fact on this side - no readable finding arrived - and
      // the reason itself is dropped rather than mapped, per the module header.
      return err(netlistUnavailable(request.moduleInterface));
    }
    // The classifier owns the five-clause rule and reads the finding UNCHANGED. Its refusals are
    // the design-level causes; the instrument-level one above is the only cause added here.
    return classifyPortTiming(request.moduleInterface, parsed.value.timing);
  }

  /** The pre-pass report's text, or `null` for every shape of missing evidence. */
  async #reportText(job: SandboxJob): Promise<string | null> {
    const submitted = await this.#submit(job);
    if (submitted === null) {
      return null;
    }
    // The artifact key is read off the job's own `requiredOutputs` rather than re-spelled here,
    // which is the read path the existing pre-pass consumers already take: the key has one owner,
    // in `assembleFormalPrepassJob`.
    const artifact = submitted.artifacts[job.requiredOutputs.at(0) ?? ''];
    return artifact === undefined ? null : this.#artifacts.readText(artifact);
  }

  /**
   * Submit one job, or `null` where the submission itself failed.
   *
   * `derive` must never throw - a thrown port would abort the whole import over one design - and
   * there are three ways `run` can throw: a `SandboxContractError` on a job the seam refuses
   * (reachable through `moduleName`, which originates in parsed third-party RTL and becomes
   * `prep -top <name>` inside the sandbox), a runtime failure, and an absent toolchain. All three
   * are the same fact for a caller - we have no netlist - so one guard covers them. Not a silent
   * catch: the caller receives the declared `netlist-unavailable` refusal.
   */
  async #submit(job: SandboxJob): Promise<SandboxResult | null> {
    try {
      return await this.#toolRunner.run(job);
    } catch {
      return null;
    }
  }
}
