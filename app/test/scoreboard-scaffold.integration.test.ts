// The Scoreboard_Scaffold rehearsed on the real toolchain before any paid call (tasks 11.1,
// 11.2). Every Streaming_Group design's scaffold, filled with a hand-written known-good fragment
// fixture, must pass its RTLLM reference through the Positive_Control; scripted faulty references
// must produce exactly the fixed CHECK lines of Requirement 3.
//
// The fixtures prove the scaffold and are never shown to a model, so they cannot tune the
// Treatment_Arm. A fixture correct for its reference that fails here is a scaffold defect.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  assembleScoreboardTestbench,
  normalizeDialect,
  parseFragmentReply,
  renderScoreboardScaffold,
  requiredChecks,
  TestbenchPrecheck,
} from '@app/agent';
import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
  RtllmInstrumentControl,
  scoredRtllmCorpus,
  type EvalProblem,
} from '@app/eval';
import type { ResourceLimits } from '@app/tools';
import { describe, expect, it } from 'vitest';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, 'fixtures', 'scoreboard');
const CAMPAIGN_CONFIG = join(HERE, '..', 'eval', 'sweep', 'sweep.config.scoreboard-ab-v1.json');

/** The Campaign config's `limits`, so the rehearsal runs on the rails the Campaign will. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };
const RUN_TIMEOUT_MS = 120_000;

async function probeCorpus(): Promise<{ readonly available: boolean; readonly reason: string }> {
  const categories = await new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH).listDirectories([]);
  return categories.length === 0
    ? {
        available: false,
        reason: `no RTLLM checkout at ${RTLLM_PINNED_COMMIT}; run \`npm run corpus:fetch\``,
      }
    : { available: true, reason: 'the pinned RTLLM checkout is present' };
}

const CORPUS = await probeCorpus();
const RUNNABLE = PROBE.available && CORPUS.available;
if (!RUNNABLE) {
  console.warn(
    `[scoreboard-scaffold] NOT exercised: ${PROBE.available ? CORPUS.reason : PROBE.reason}. ` +
      'The Positive_Control rehearsal blocks the Campaign until it runs.',
  );
}

/** The Streaming_Group designs the committed Campaign config records. */
async function streamingDesigns(): Promise<readonly string[]> {
  const config = JSON.parse(await readFile(CAMPAIGN_CONFIG, 'utf8')) as {
    readonly scoreboardCampaign: { readonly designGroups: Record<string, string> };
  };
  const groups = config.scoreboardCampaign.designGroups;
  return Object.keys(groups).filter((id) => groups[id] === 'streaming');
}

async function scoredProblem(problemId: string): Promise<EvalProblem> {
  const corpus = scoredRtllmCorpus(
    await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH)),
  );
  const problem = corpus.problems.find((candidate) => candidate.id === problemId);
  if (problem === undefined) {
    throw new Error(`${problemId} is not in the scored corpus`);
  }
  return problem;
}

const shortName = (problemId: string): string => problemId.split('/').pop() ?? problemId;

/** Render, fill through the validator, assemble, and normalize, exactly as the agent and loop do. */
async function assembledTestbench(problem: EvalProblem, fixture: string): Promise<string> {
  const scaffold = renderScoreboardScaffold(
    problem.spec.moduleInterface,
    requiredChecks(problem.spec).map((check) => check.name),
  );
  if (!scaffold.ok) {
    throw new Error(`${problem.id} renders no scaffold: ${scaffold.error.reason}`);
  }
  const fragments = parseFragmentReply(
    await readFile(join(FIXTURES, fixture), 'utf8'),
    scaffold.value,
  );
  if (!fragments.ok) {
    throw new Error(`${fixture} is refused: ${JSON.stringify(fragments.error)}`);
  }
  return normalizeDialect(assembleScoreboardTestbench(scaffold.value, fragments.value)).source;
}

/** Every CHECK line of a run, as `name STATUS`. */
function checkLines(stdout: string): readonly string[] {
  return [...stdout.matchAll(/^CHECK (\S+) (PASS|FAIL)/gm)].map(
    (match) => `${match[1]} ${match[2]}`,
  );
}

describe('scoreboard rehearsal capability probe', () => {
  it('records whether the rehearsal ran here', () => {
    expect(typeof RUNNABLE).toBe('boolean');
  });
});

describe.skipIf(!RUNNABLE)(
  '11.1 Positive_Control rehearsal on every Streaming_Group design',
  () => {
    it('the committed config marks multi_16bit and the four supplement designs streaming', async () => {
      expect((await streamingDesigns()).map(shortName).sort()).toEqual([
        'accu',
        'multi_16bit',
        'parallel2serial',
        'serial2parallel',
        'width_8to16',
      ]);
    });

    it(
      'passes every reference with known-good fragments, through the precheck and the control',
      async () => {
        const corpus = await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH));
        const control = new RtllmInstrumentControl({
          simulator: realOracleAdapter(),
          references: corpus.references,
        });
        const precheck = new TestbenchPrecheck(realOracleAdapter());
        for (const problemId of await streamingDesigns()) {
          const problem = await scoredProblem(problemId);
          const testbench = await assembledTestbench(
            problem,
            `${shortName(problemId)}.fragments.json`,
          );
          const built = await precheck.run(
            { path: `${problem.spec.moduleInterface.moduleName}_tb.v`, contents: testbench },
            problem.spec.moduleInterface,
            LIMITS,
          );
          expect(built, problemId).toBe('undecided');
          const result = await control.check({
            problemId,
            testbench,
            limits: LIMITS,
            requiredCheckNames: [],
          });
          expect(result?.verdict, `${problemId}: ${result?.stdout ?? ''}`).toEqual({
            validity: 'valid',
          });
          const lines = checkLines(result?.stdout ?? '');
          expect(
            lines.filter((line) => line.endsWith('FAIL')),
            problemId,
          ).toEqual([]);
          for (const check of requiredChecks(problem.spec)) {
            expect(lines, problemId).toContain(`${check.name} PASS`);
          }
          expect(lines, problemId).toContain('scoreboard_vacuous PASS');
        }
      },
      RUN_TIMEOUT_MS * 5,
    );
  },
);

// -- 11.2: scripted faulty references --------------------------------------

/** A `width_8to16` whose output side is scripted; the input side matches the reference. */
function scriptedWidth8to16(outputLogic: string): string {
  return `module width_8to16(input clk, input rst_n, input valid_in, input [7:0] data_in,
  output reg valid_out, output reg [15:0] data_out);
  reg [7:0] data_lock; reg flag; reg [3:0] hold;
  always @(posedge clk or negedge rst_n) begin
    if (!rst_n) begin data_lock <= 0; flag <= 0; valid_out <= 0; data_out <= 0; hold <= 0; end
    else begin
      if (valid_in && !flag) data_lock <= data_in;
      if (valid_in) flag <= ~flag;
${outputLogic}
    end
  end
endmodule
`;
}

const FAULTS = {
  // Asserts the qualifier on the FIRST byte of a pair too, before any expectation is queued.
  extraOutput: scriptedWidth8to16(
    '      valid_out <= valid_in; if (valid_in && flag) data_out <= {data_lock, data_in};',
  ),
  // Never asserts the qualifier, so every expectation stays queued until the drain bound.
  missingOutput: scriptedWidth8to16('      valid_out <= 0;'),
  // Stuck asserted after the first result: every later period is an event with nothing queued.
  stuckQualifier: scriptedWidth8to16(
    '      if (valid_in && flag) begin valid_out <= 1; data_out <= {data_lock, data_in}; end',
  ),
  // Correct timing, unknown data.
  unknownData: scriptedWidth8to16(
    "      valid_out <= valid_in && flag; if (valid_in && flag) data_out <= 16'bx;",
  ),
  // Each result's qualifier is held for three periods.
  heldThreePeriods: scriptedWidth8to16(
    '      if (valid_in && flag) begin valid_out <= 1; hold <= 2; data_out <= {data_lock, data_in}; end\n' +
      '      else if (hold != 0) begin hold <= hold - 1; valid_out <= 1; end\n' +
      '      else valid_out <= 0;',
  ),
} as const;

/** A `parallel2serial` that never asserts its qualifier: the one-in-flight hold is observable. */
const SILENT_PARALLEL2SERIAL = `module parallel2serial(input clk, input rst_n, input [3:0] d,
  output valid_out, output dout);
  assign valid_out = 1'b0;
  assign dout = d[3];
endmodule
`;

async function runAgainst(problemId: string, fixture: string, reference: string): Promise<string> {
  const problem = await scoredProblem(problemId);
  const testbench = await assembledTestbench(problem, fixture);
  const verdict = await realOracleAdapter().simulate(
    [{ path: `${problem.spec.moduleInterface.moduleName}.v`, contents: reference }],
    { path: `${problem.spec.moduleInterface.moduleName}_tb.v`, contents: testbench },
    LIMITS,
  );
  return verdict.stdout;
}

const WIDTH = 'rtllm/miscellaneous/width_8to16';
const WIDTH_FIXTURE = 'width_8to16.fragments.json';
/** The width_8to16 fixture sends 8 bytes, so it queues 4 expectations. */
const WIDTH_RESULTS = 4;

describe.skipIf(!RUNNABLE)('11.2 the fixed CHECK lines on scripted faulty references', () => {
  it(
    'an extra output fails unexpected-output, once per output with nothing queued (3.7)',
    async () => {
      const stdout = await runAgainst(WIDTH, WIDTH_FIXTURE, FAULTS.extraOutput);
      const unexpected = checkLines(stdout).filter(
        (line) => line === 'scoreboard_unexpected_output FAIL',
      );
      expect(unexpected).toHaveLength(WIDTH_RESULTS);
      expect(checkLines(stdout)).not.toContain('scoreboard_unexpected_output PASS');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'a missing output fails missing-output exactly once, stating the outstanding count (3.8, 3.22)',
    async () => {
      const stdout = await runAgainst(WIDTH, WIDTH_FIXTURE, FAULTS.missingOutput);
      expect(checkLines(stdout)).toEqual(['scoreboard_missing_output FAIL']);
      expect(stdout).toContain(`${WIDTH_RESULTS} expectations outstanding after the drain bound`);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'a stuck qualifier reports every later period as an unexpected output',
    async () => {
      const stdout = await runAgainst(WIDTH, WIDTH_FIXTURE, FAULTS.stuckQualifier);
      expect(checkLines(stdout)).toContain('scoreboard_unexpected_output FAIL');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'an x on a Data_Output is a mismatch naming the output and both values (3.10, 3.21)',
    async () => {
      const stdout = await runAgainst(WIDTH, WIDTH_FIXTURE, FAULTS.unknownData);
      expect(stdout).toMatch(/CHECK ac1_\S+ FAIL: data_out expected [0-9a-f]{4} observed xxxx/);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'a qualifier held three periods yields three events per result (3.20)',
    async () => {
      const stdout = await runAgainst(WIDTH, WIDTH_FIXTURE, FAULTS.heldThreePeriods);
      const unexpected = checkLines(stdout).filter(
        (line) => line === 'scoreboard_unexpected_output FAIL',
      );
      // The first period of each result consumes its expectation; the other two find none.
      expect(unexpected).toHaveLength(WIDTH_RESULTS * 2);
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'with no Input_Qualifier, at most one transaction is ever in flight (3.14, 3.15)',
    async () => {
      const stdout = await runAgainst(
        'rtllm/miscellaneous/parallel2serial',
        'parallel2serial.fragments.json',
        SILENT_PARALLEL2SERIAL,
      );
      expect(checkLines(stdout)).toEqual(['scoreboard_missing_output FAIL']);
      expect(stdout).toContain('1 expectations outstanding after the drain bound');
    },
    RUN_TIMEOUT_MS,
  );

  it(
    'a never-compared run fails vacuous (3.9)',
    async () => {
      // An empty stimulus fragment queues nothing and compares nothing.
      const stdout = await runAgainst(
        WIDTH,
        'faulty/width_8to16.no-stimulus.fragments.json',
        FAULTS.missingOutput,
      );
      expect(checkLines(stdout)).toContain('scoreboard_vacuous FAIL');
    },
    RUN_TIMEOUT_MS,
  );
});
