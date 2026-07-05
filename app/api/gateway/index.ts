// Public surface of the API_Gateway trust boundary (task 5.1).
//
// The Editor (task 6.2) and Project_Store (task 12.1) wire into these seams: the
// ordered inbound pipeline, the auth and rate-limit adapters, the prompt-
// injection filter, the single error-mapper, boundary + model-output validation,
// and the safe-by-default per-object authorization stub.

export * from './errors.js';
export * from './auth.js';
export * from './rate-limit.js';
export * from './injection-filter.js';
export * from './validation.js';
export * from './authorize-object.js';
export * from './pipeline.js';
