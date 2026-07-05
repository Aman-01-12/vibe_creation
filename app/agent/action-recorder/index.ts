// Action_Recorder: ordered Trace spans with secret exclusion and PII redaction
// (Requirements 3.1-3.6, 8.8; Properties 11, 12). Task 4.1.
//
// Public surface:
//   - `TraceActionRecorder` / `ActionRecorder` / `SpanDraft`: the recorder that
//     assigns monotonic `seq`, redacts at the boundary, and reads the Trace back.
//   - `TracePersistencePort` / `InMemoryTracePersistence`: the injectable persistence
//     seam and its in-memory implementation (durable store lands in task 12.1).
//   - `renderHistory` / `formatHistoryLines` / `HistoryEntry`: the ordered,
//     human-readable history read.
//   - `redactJson` and detection helpers: the reusable redaction transform.

export * from './redaction.js';
export * from './persistence-port.js';
export * from './history.js';
export * from './action-recorder.js';
