// Re-export of the deterministic Verilog mutant generator, relocated to
// `@app/tools/mutation/generator.ts` (reference-model-consensus-gate, design-answers-round3.md).
// Kept here so `mutation-calibration.ts`, `property-set-admission.ts`, and the existing unit
// tests in `verilog-mutation.test.ts` keep their import paths unchanged.

export { generateMutants, MAX_MUTATED_SOURCE_CHARS } from '@app/tools';
