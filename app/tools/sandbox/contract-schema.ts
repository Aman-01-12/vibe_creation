// Canonical JSON Schema for the Tool_Runner job/result seam.
//
// This module is the single source of truth for the language-neutral contract.
// `contract.schema.json` is a byte-mirror of `sandboxContractSchema`, committed so
// the Python worker (task 3.2) can load and validate against the exact same
// schema without importing TypeScript. A drift-guard test deep-equals the two, so
// they can never silently diverge. The TypeScript adapter validates against the
// const (dist-safe, no file read on the hot path); the worker validates against
// the mirror.
//
// Draft-07 is used with `definitions`/`#/definitions/...` refs so the default ajv
// instance validates it without needing a newer metaschema.

import type { SchemaObject } from 'ajv';

/** Stable `$id` of the seam schema; subschemas are referenced under it. */
export const CONTRACT_SCHEMA_ID = 'https://ece.dev/schemas/sandbox-contract.json';

/** JSON pointer to the `SandboxJob` subschema, for compiling a job validator. */
export const SANDBOX_JOB_REF = `${CONTRACT_SCHEMA_ID}#/definitions/SandboxJob`;

/** JSON pointer to the `SandboxResult` subschema, for compiling a result validator. */
export const SANDBOX_RESULT_REF = `${CONTRACT_SCHEMA_ID}#/definitions/SandboxResult`;

/**
 * The rule "`<field>` is present IF AND ONLY IF `kind` is `<kind>`", as one `allOf` member.
 *
 * ONE OWNER OF THE SHAPE, because there are now TWO kind-specific payloads (`formal` and
 * `formalPrepass`) and both halves of both rules are load-bearing: the `then` stops a job of
 * that kind arriving with no parameters, and the `else` stops parameters riding along on a kind
 * whose worker path never reads them. Expressed in the schema rather than only in the worker so
 * ajv refuses a malformed job at the boundary, before it crosses the seam.
 *
 * THE BOOLEAN-SCHEMA BRANCHES ARE NOT A STYLE CHOICE - they are the schema satisfying a strict
 * validator, never the validator relaxed for the schema. `validation.ts` builds ajv with
 * `strict: true`, which turns `strictRequired` ON, and `strictRequired` demands that every name
 * in a `required` be declared in the `properties` of THE SAME subschema; declaring it on the
 * parent does not carry down. A violation throws at ajv COMPILE time, which is module load, so
 * the failure shape is a suite reporting "0 tests" rather than a failing assertion
 * (`chipAgent/_inbox/gotcha-ajv-strictrequired-refuses-required-in-a-then-branch.md`).
 *   - `true` in the `then` says only "declared here", leaving the parent's `$ref` the single
 *     owner of the payload's shape, so a payload violation is reported once rather than twice.
 *   - `false` in the `else` IS the refusal (the field may not appear), and sidesteps the
 *     `not: { required: [...] }` shape `strictRequired` also rejects.
 *   - `type: 'object'` on each branch keeps `strictTypes` quiet.
 *
 * Returned as an `allOf` member because draft-07 permits only ONE `if`/`then`/`else` per schema
 * object, and `SandboxJob` now needs two independent ones.
 */
function payloadBiconditional(kind: string, field: string): SchemaObject {
  return {
    if: { type: 'object', required: ['kind'], properties: { kind: { const: kind } } },
    then: { type: 'object', required: [field], properties: { [field]: true } },
    else: { type: 'object', properties: { [field]: false } },
  };
}

/**
 * "`<field>` may appear only when `kind` is `<kind>`": optional there, refused elsewhere.
 * The `then` names no `required`, so `strictRequired` has nothing to refuse (vault gotcha).
 */
function payloadOnlyUnder(kind: string, field: string): SchemaObject {
  return {
    if: { type: 'object', required: ['kind'], properties: { kind: { const: kind } } },
    then: { type: 'object' },
    else: { type: 'object', properties: { [field]: false } },
  };
}

/**
 * The canonical seam schema. Keep every constraint aligned with the TypeScript
 * types in `contract.ts` and the byte-mirror `contract.schema.json`.
 */
export const sandboxContractSchema: SchemaObject = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  $id: CONTRACT_SCHEMA_ID,
  title: 'Tool_Runner sandbox job/result contract',
  definitions: {
    SourceFile: {
      type: 'object',
      additionalProperties: false,
      required: ['path', 'contents'],
      properties: {
        path: { type: 'string', minLength: 1 },
        contents: { type: 'string' },
      },
    },
    ResourceLimits: {
      type: 'object',
      additionalProperties: false,
      required: ['cpu', 'memMb', 'procs', 'diskMb', 'wallMs'],
      properties: {
        cpu: { type: 'number', exclusiveMinimum: 0 },
        memMb: { type: 'integer', exclusiveMinimum: 0 },
        procs: { type: 'integer', minimum: 1 },
        diskMb: { type: 'integer', exclusiveMinimum: 0 },
        wallMs: { type: 'integer', exclusiveMinimum: 0 },
      },
    },
    RequiredOutput: {
      type: 'string',
      // `formalPrepassReport` is a member because a pre-pass that produced no report
      // produced nothing at all - there is no success case in which it is legitimately
      // absent. The `formal` job's counterexample trace is deliberately NOT a member, by
      // the same rule read the other way: a successful proof writes no trace, so requiring
      // one would classify every proof as `error`. See `RequiredOutput` in `contract.ts`.
      enum: [
        'stdout',
        'stderr',
        'exitCode',
        'vcd',
        'netlistJson',
        'formalReport',
        'formalPrepassReport',
      ],
    },
    FormalJobRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['topModule', 'depth'],
      properties: {
        // A plain Verilog identifier, bounded, because this value is interpolated
        // into `prep -top <topModule>` inside the sandbox. Same form and same
        // ceiling the corpus already holds a module name to
        // (`app/eval/corpus/design-description.ts`). The worker validates it again
        // before use (task 2.2); this is the boundary's own refusal, not a
        // substitute for the worker's.
        topModule: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_$]*$', maxLength: 128 },
        // A positive integer, for the same reason: it becomes `-t <depth>`. The
        // upper ceiling is the worker's (task 2.2), because the ceiling is a
        // property of what the solver can be asked to do, not of the seam.
        depth: { type: 'integer', exclusiveMinimum: 0 },
      },
    },
    FormalPrepassJobRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['topModule'],
      properties: {
        // The CANDIDATE DESIGN's own module name, not a Property_Wrapper's: the pre-pass
        // runs before any wrapper exists. Same bounded plain-identifier form and same
        // ceiling as `FormalJobRequest.topModule`, for the same reason - it is interpolated
        // into `prep -top <topModule>` inside the sandbox. The worker validates it again
        // before use; this is the boundary's own refusal, not a substitute for the worker's.
        topModule: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_$]*$', maxLength: 128 },
        // NO `depth`. The pre-pass runs no solver, so there is no proof depth to carry, and
        // a field the far side never reads is a caller silently believing it asked for
        // something.
      },
    },
    SimulateJobRequest: {
      type: 'object',
      additionalProperties: false,
      required: ['defaultTimescale'],
      properties: {
        // A closed value, never a path or flag: the worker writes the command file itself.
        defaultTimescale: { type: 'string', enum: ['1ns/1ps'] },
      },
    },
    SandboxJob: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'workspaceFiles', 'limits', 'requiredOutputs'],
      properties: {
        kind: { type: 'string', enum: ['simulate', 'synthesize', 'formal', 'formalPrepass'] },
        workspaceFiles: {
          type: 'array',
          items: { $ref: '#/definitions/SourceFile' },
        },
        limits: { $ref: '#/definitions/ResourceLimits' },
        requiredOutputs: {
          type: 'array',
          uniqueItems: true,
          items: { $ref: '#/definitions/RequiredOutput' },
        },
        formal: { $ref: '#/definitions/FormalJobRequest' },
        formalPrepass: { $ref: '#/definitions/FormalPrepassJobRequest' },
        simulate: { $ref: '#/definitions/SimulateJobRequest' },
      },
      // TWO independent biconditionals - `formal` under `'formal'`, `formalPrepass` under
      // `'formalPrepass'` - carried as `allOf` members because draft-07 permits only one
      // `if`/`then`/`else` per schema object. Independent rather than one combined rule, so a
      // job carrying BOTH payloads is refused by both branches at once and a third kind-specific
      // payload joins as a third member rather than as a rewrite. See `payloadBiconditional` for
      // why each branch redeclares its field as a boolean schema.
      allOf: [
        payloadBiconditional('formal', 'formal'),
        payloadBiconditional('formalPrepass', 'formalPrepass'),
        payloadOnlyUnder('simulate', 'simulate'),
      ],
    },
    ArtifactBlobRef: {
      type: 'object',
      additionalProperties: false,
      required: ['name', 'sizeBytes', 'sha256'],
      properties: {
        name: { type: 'string', minLength: 1 },
        sizeBytes: { type: 'integer', minimum: 0 },
        sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
      },
    },
    DeniedOperation: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'detail'],
      properties: {
        kind: { type: 'string', enum: ['filesystem', 'network', 'process'] },
        detail: { type: 'string' },
        path: { type: 'string' },
      },
    },
    ResourceUsage: {
      type: 'object',
      additionalProperties: false,
      required: ['wallMs', 'maxMemMb', 'cpuMs'],
      properties: {
        wallMs: { type: 'number', minimum: 0 },
        maxMemMb: { type: 'number', minimum: 0 },
        cpuMs: { type: 'number', minimum: 0 },
      },
    },
    SandboxResult: {
      type: 'object',
      additionalProperties: false,
      required: [
        'verdict',
        'timedOut',
        'exitCode',
        'stdout',
        'stderr',
        'stdoutTruncated',
        'stderrTruncated',
        'diskLimitExceeded',
        'artifacts',
        'deniedOperations',
        'resourceUsage',
      ],
      properties: {
        verdict: { type: 'string', enum: ['pass', 'fail', 'error'] },
        // Required, not optional: `error` collapses timeout / infra failure /
        // missing output / truncation, and a wall-clock kill leaves no exit code,
        // no streams, and zeroed usage behind, so an omitted flag would make a
        // timeout indistinguishable from a crash. Classified TypeScript-side
        // alongside `verdict`; the worker does not report it.
        timedOut: { type: 'boolean' },
        exitCode: { type: ['integer', 'null'] },
        stdout: { type: 'string' },
        stderr: { type: 'string' },
        // Required, not optional: the worker bounds how much of a child's output
        // it retains, so a result that omitted the truncation status would let a
        // bounded prefix read as a complete run.
        stdoutTruncated: { type: 'boolean' },
        stderrTruncated: { type: 'boolean' },
        // Required, not optional: the worker enforces `diskMb` by killing the tool
        // mid-run, and unlike a wall-clock kill that leaves nothing behind, a
        // disk-cap kill still reports an exit code and streams. An omitted flag
        // would make it indistinguishable from a tool that failed on its own -
        // which is how a cap that IS enforced comes to look like one that is not.
        diskLimitExceeded: { type: 'boolean' },
        artifacts: {
          type: 'object',
          additionalProperties: { $ref: '#/definitions/ArtifactBlobRef' },
        },
        deniedOperations: {
          type: 'array',
          items: { $ref: '#/definitions/DeniedOperation' },
        },
        resourceUsage: { $ref: '#/definitions/ResourceUsage' },
      },
    },
  },
};
