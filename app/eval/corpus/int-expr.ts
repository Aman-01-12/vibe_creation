// Re-export of the integer-expression evaluator, relocated to `@app/tools/verilog/int-expr.ts`
// (structural-gate-toolchain, DQ-01). Kept here so `import.ts` and the existing unit tests in
// `int-expr.test.ts` keep their import paths unchanged; `app/test/interface-parser-relocation.test.ts`
// pins that the re-exported symbol is the same object as `@app/tools`'s.

export { evaluateIntExpression, type IntExprResult, type IntExprScope } from '@app/tools';
