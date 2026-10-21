// Re-export of the reference-RTL module-declaration parser, relocated to
// `@app/tools/verilog/declared-module.ts` (structural-gate-toolchain, DQ-01). Kept here so
// `import.ts` and the existing unit tests in `verilog-module.test.ts` keep their import paths
// unchanged; `app/test/interface-parser-relocation.test.ts` pins that the re-exported symbols
// are the same objects as `@app/tools`'s.

export {
  listDeclaredModuleNames,
  parseDeclaredModule,
  stripVerilogNoise,
  type DeclaredModule,
  type DeclaredPort,
  type ModuleParseResult,
} from '@app/tools';
