// Public surface of the shared edge-case generators (task 1.3).
//
// Later property-test tasks import these arbitraries from `@app/test` rather
// than re-rolling their own. Every generator here produces raw, primitive, or
// structural values only: no I/O, no network, and no dependency on the domain
// types defined in task 2.1.

export * from './identifiers.js';
export * from './paths.js';
export * from './port-widths.js';
export * from './payloads.js';
export * from './web-content.js';
export * from './secrets.js';
export * from './capture-state.js';
export * from './timing-contract.js';
