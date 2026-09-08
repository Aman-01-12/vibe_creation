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
      enum: ['stdout', 'stderr', 'exitCode', 'vcd', 'netlistJson'],
    },
    SandboxJob: {
      type: 'object',
      additionalProperties: false,
      required: ['kind', 'workspaceFiles', 'limits', 'requiredOutputs'],
      properties: {
        kind: { type: 'string', enum: ['simulate', 'synthesize'] },
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
      },
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
