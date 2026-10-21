// Unit tests for the Timing_Derivation seam, driven through a FAKE `ToolRunner`, so they run with
// no Yosys installed (timing-contract-inference Req 2.3, 2.5, 3.1).
//
// WHAT THESE CASES ARE FOR
//   The measurable claim of task 5.1 is that an instrument failure is reported as
//   `netlist-unavailable` and NEVER as one of the four design-level causes. Four instrument
//   failures are covered - no report registered, a report that is not JSON, a report that is
//   schema-invalid, and a run that threw - and each is checked against the whole design-level
//   vocabulary rather than only against the cause it is expected to carry.
//
//   The happy path is a POSITIVE CONTROL and the group is incomplete without it: a port that
//   refused unconditionally would satisfy every refusal assertion above, so one well-formed
//   document carrying a derived finding has to produce a real classified contract.

import { describe, expect, it } from 'vitest';

import { makeModuleInterface, makePort, type ModuleInterface, type Port } from '@app/core';
import type {
  ArtifactBlobRef,
  ArtifactTextReader,
  ResourceLimits,
  SandboxJob,
  SandboxResult,
  SourceFile,
  TimingRefusalCause,
  ToolRunner,
} from '@app/tools';

import { FormalPrepassTimingDerivation } from './timing-derivation-port.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const RTL: SourceFile = { path: 'dut_reference.v', contents: 'module counter; endmodule\n' };

/** The artifact key `assembleFormalPrepassJob` names, so a fixture registers the real one. */
const REPORT_KEY = 'formalPrepassReport';

const REPORT_ARTIFACT: ArtifactBlobRef = {
  name: REPORT_KEY,
  sizeBytes: 128,
  sha256: 'a'.repeat(64),
};

/**
 * The four causes that are facts about a DESIGN, which an instrument failure must never report.
 *
 * Spelled as `TimingRefusalCause[]` so a cause added to the union and forgotten here is still a
 * compile error at the annotation rather than a silently unchecked member.
 */
const DESIGN_LEVEL_CAUSES: readonly TimingRefusalCause[] = [
  'netlist-walk-unreliable',
  'port-not-reported',
  'undriven-output-port',
  'input-and-state-independent',
];

/** Build a `Port` through its sole supported constructor, throwing on a fixture we mis-wrote. */
function port(name: string, direction: 'input' | 'output', width: number): Port {
  const made = makePort({ name, direction, width });
  if (!made.ok) {
    throw new Error(`test fixture declared an invalid port: ${made.error.message}`);
  }
  return made.value;
}

/**
 * A clocked design with one registered and one combinational output.
 *
 * The clock and reset sit in `clocking` rather than in `ports`, which is the shape the corpus
 * importer builds. `q`'s cone reaches state and `pass_through`'s reaches the declared data input
 * `en`, so the happy path below produces two DIFFERENT timings and not one repeated value.
 */
const MODULE_INTERFACE: ModuleInterface = (() => {
  const built = makeModuleInterface({
    moduleName: 'counter',
    ports: [port('en', 'input', 1), port('q', 'output', 8), port('pass_through', 'output', 1)],
    clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  });
  if (!built.ok) {
    throw new Error(`test fixture declared an invalid interface: ${built.error.message}`);
  }
  return built.value;
})();

/** A well-formed pre-pass document whose timing finding was derived for both output ports. */
const DERIVED_REPORT = JSON.stringify({
  reset: {
    derived: true,
    resetName: 'rst_n',
    resetActiveLow: true,
    resetKind: 'async',
  },
  clockPolarity: 'posedge',
  initialStatePredicate: 'true',
  timing: {
    derived: true,
    ports: [
      { port: 'q', sources: ['clk', 'rst_n'], reachesState: true, undriven: false },
      { port: 'pass_through', sources: ['en'], reachesState: false, undriven: false },
    ],
  },
});

/** The same document with `clockPolarity` set to a value the closed schema does not admit. */
const SCHEMA_INVALID_REPORT = JSON.stringify({
  reset: { derived: false },
  clockPolarity: 'rising',
  initialStatePredicate: 'true',
  timing: { derived: true, ports: [] },
});

/** A `SandboxResult` registering the pre-pass report, or registering nothing at all. */
function sandboxResult(registerReport: boolean): SandboxResult {
  return {
    verdict: 'pass',
    timedOut: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: registerReport ? { [REPORT_KEY]: REPORT_ARTIFACT } : {},
    deniedOperations: [],
    resourceUsage: { wallMs: 1, maxMemMb: 1, cpuMs: 1 },
  };
}

/** A `ToolRunner` answering with one fixed result, or throwing the way an absent tool does. */
class FakeToolRunner implements ToolRunner {
  readonly jobs: SandboxJob[] = [];
  readonly #answer: SandboxResult | Error;

  constructor(answer: SandboxResult | Error) {
    this.#answer = answer;
  }

  run(job: SandboxJob): Promise<SandboxResult> {
    this.jobs.push(job);
    if (this.#answer instanceof Error) {
      return Promise.reject(this.#answer);
    }
    return Promise.resolve(this.#answer);
  }
}

/** An `ArtifactTextReader` answering with fixed text for the report artifact. */
function artifactReader(text: string | null): ArtifactTextReader {
  return { readText: (artifact) => Promise.resolve(artifact.name === REPORT_KEY ? text : null) };
}

/** Derive once against a scripted runner and reader. */
async function derive(
  answer: SandboxResult | Error,
  text: string | null,
): Promise<Awaited<ReturnType<FormalPrepassTimingDerivation['derive']>>> {
  const derivation = new FormalPrepassTimingDerivation({
    toolRunner: new FakeToolRunner(answer),
    artifacts: artifactReader(text),
    limits: LIMITS,
  });
  return derivation.derive({ rtl: RTL, moduleInterface: MODULE_INTERFACE });
}

describe('an instrument failure refuses as `netlist-unavailable`', () => {
  // Given-When-Then, once per shape of missing evidence. Each asserts the WHOLE refusal, so a
  // leaked field or a widened port list fails here too, and then asserts the cause is outside the
  // design-level vocabulary - which is the clause Req 2.3 actually states.
  const cases: readonly { readonly name: string; readonly run: () => Promise<unknown> }[] = [
    {
      name: 'the run registered no report artifact',
      run: () => derive(sandboxResult(false), DERIVED_REPORT),
    },
    {
      name: 'the report artifact could not be read back',
      run: () => derive(sandboxResult(true), null),
    },
    {
      name: 'the report text is not JSON',
      run: () => derive(sandboxResult(true), 'yosys: command not found'),
    },
    {
      name: 'the report text violates the closed schema',
      run: () => derive(sandboxResult(true), SCHEMA_INVALID_REPORT),
    },
    {
      name: 'the tool run itself errored',
      run: () => derive(new Error('spawn yosys ENOENT: /opt/homebrew/bin/yosys'), DERIVED_REPORT),
    },
  ];

  for (const { name, run } of cases) {
    it(`reports the instrument when ${name} (Req 2.3)`, async () => {
      const result = await run();

      expect(result).toEqual({
        ok: false,
        error: { cause: 'netlist-unavailable', ports: ['q', 'pass_through'] },
      });
    });
  }

  it('never reports a design-level cause for an instrument failure (Req 2.3)', async () => {
    const results = await Promise.all(
      cases.map(async ({ name, run }) => ({ name, run: await run() })),
    );

    for (const { name, run } of results) {
      const cause = (run as { readonly error?: { readonly cause?: string } }).error?.cause;
      expect({
        name,
        isDesignLevel: DESIGN_LEVEL_CAUSES.includes(cause as TimingRefusalCause),
      }).toEqual({ name, isDesignLevel: false });
    }
  });

  it('carries no rejection text, host path, or tool diagnostic into the refusal (Req 2.5)', async () => {
    // The two cases whose inputs CARRY such text: a not-JSON report quoting a tool, and a thrown
    // error quoting a host path. Non-vacuous because both strings are known to appear upstream.
    const refusals = [
      await derive(sandboxResult(true), 'yosys: command not found'),
      await derive(new Error('spawn yosys ENOENT: /opt/homebrew/bin/yosys'), DERIVED_REPORT),
      await derive(sandboxResult(true), SCHEMA_INVALID_REPORT),
    ];

    for (const refusal of refusals) {
      const serialized = JSON.stringify(refusal);
      expect(serialized).not.toContain('yosys');
      expect(serialized).not.toContain('/opt/homebrew');
      expect(serialized).not.toContain('clockPolarity');
      // Two keys and nothing else, so no field could carry text at all.
      expect(Object.keys(refusal.ok ? {} : refusal.error).sort()).toEqual(['cause', 'ports']);
    }
  });
});

describe('a derived finding produces the classified contract', () => {
  it('classifies each declared output port from the pre-pass report (Req 3.1)', async () => {
    const result = await derive(sandboxResult(true), DERIVED_REPORT);

    expect(result).toEqual({
      ok: true,
      value: {
        entries: [
          { portName: 'q', timing: 'registered' },
          { portName: 'pass_through', timing: 'combinational' },
        ],
      },
    });
  });

  it('submits the design under its own module name with no second top name (Req 3.1)', async () => {
    const runner = new FakeToolRunner(sandboxResult(true));
    const derivation = new FormalPrepassTimingDerivation({
      toolRunner: runner,
      artifacts: artifactReader(DERIVED_REPORT),
      limits: LIMITS,
    });

    await derivation.derive({ rtl: RTL, moduleInterface: MODULE_INTERFACE });

    expect(runner.jobs).toEqual([
      {
        kind: 'formalPrepass',
        workspaceFiles: [RTL],
        limits: LIMITS,
        requiredOutputs: [REPORT_KEY],
        formalPrepass: { topModule: 'counter' },
      },
    ]);
  });
});
