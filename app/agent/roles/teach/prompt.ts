// Prompt construction for Teach_Mode.
//
// This builder assembles the teaching-model prompt (routed to the orchestration/
// teaching model, Gemini Flash) that asks for plain-language claims, each grounded
// in a specific session artifact the prompt enumerates (Req 11.1, 11.2). The Spec
// text is UNTRUSTED input; the API_Gateway has already injection-filtered it
// upstream, and this module only embeds it as clearly delimited data, never as
// instructions. The model's reply is re-validated at the boundary (model-output.ts)
// and then grounded against the ACTUAL session artifacts (teach-claims.ts), so a
// prompt the model ignores can never bypass grounding: a claim citing an artifact
// the session does not have is labeled `Unverified` regardless of what was asked.

import type { TeachSession, ToolOutputRef } from './types.js';

/** The JSON contract the model is asked to follow; re-validated after the call. */
const OUTPUT_CONTRACT = [
  'Respond with a single JSON object and nothing else, using exactly this shape:',
  '{ "claims": [ ...claim ] } where each claim is ONE of:',
  '- A design claim about THIS design or its results:',
  '  { "kind": "design", "statement": string, "grounding": <one grounding ref below> }',
  '  A grounding ref is exactly one of:',
  '    { "kind": "oracle-verdict", "verificationResultId": id, "oracleSpanId": id }',
  '    { "kind": "trace-span", "spanId": id }',
  '    { "kind": "waveform-reading", "waveformArtifactId": id, "signal": name, "atSimTimeNs": number }',
  '  Use ONLY ids and signals listed in GROUNDABLE_ARTIFACTS below; never invent one.',
  '- A general domain fact:',
  '  { "kind": "general", "statement": string, "citation": { "claim": string, "sourceUrl": string, "sourceTitle": string } }',
  '  Use ONLY a citation listed in AVAILABLE_CITATIONS below.',
  'Do not claim the design is correct beyond what the oracle verdict supports. If you',
  'cannot ground a statement in one of the artifacts below, omit it.',
].join('\n');

/** The role framing shared by every teaching turn. */
const ROLE_PREAMBLE =
  'You are the teach-mode stage for a tool that builds ONE Verilog hardware module at a time. ' +
  'Explain design choices, waveform readings, and verification results in plain language, tied ' +
  'to the actual session artifacts listed below. Ground every design-specific claim in verified ' +
  'tool output and every general fact in a citation.';

/** Delimit untrusted text so it is read as data, not as instructions. */
function fencedBlock(label: string, content: string): string {
  return `${label}:\n"""\n${content}\n"""`;
}

/** Render the grounding references the model is allowed to cite for design claims. */
function renderGroundableArtifacts(session: TeachSession): string {
  const lines: string[] = [];
  const verification = session.verification;
  if (verification !== null) {
    lines.push(
      `oracle-verdict: verificationResultId=${verification.id} oracleSpanId=${verification.oracleSpanId} ` +
        `verdict=${verification.verdict}`,
    );
  }
  if (session.waveform !== null) {
    lines.push(
      `waveform: waveformArtifactId=${session.waveform.waveformArtifactId} ` +
        `signals=[${session.waveform.signals.join(', ')}]`,
    );
  }
  for (const spanId of session.traceSpanIds) {
    lines.push(`trace-span: spanId=${spanId}`);
  }
  return lines.length === 0 ? '(none available)' : lines.join('\n');
}

/** Render the citations the model is allowed to cite for general facts. */
function renderAvailableCitations(session: TeachSession): string {
  if (session.availableCitations.length === 0) {
    return '(none available)';
  }
  return session.availableCitations
    .map((citation) => `- ${citation.sourceTitle} <${citation.sourceUrl}>: ${citation.claim}`)
    .join('\n');
}

/** Render the verification verdict and any failing case as plain context. */
function renderVerdictContext(session: TeachSession): string {
  const verification = session.verification;
  if (verification === null) {
    return 'No verification run has been recorded for this module yet.';
  }
  if (verification.verdict === 'pass') {
    return 'The module passed the spec-derived testbench in the simulator (Verified).';
  }
  const failingCase = verification.failingCase;
  if (failingCase === undefined) {
    return `The module did not pass (verdict=${verification.verdict}); no failing case was localized.`;
  }
  return (
    `The module did not pass (verdict=${verification.verdict}). Failing check "${failingCase.checkName}": ` +
    `expected ${failingCase.expected}, observed ${failingCase.observed}.`
  );
}

/**
 * Build the Teach_Mode prompt from the session's actual artifacts (Req 11.1, 11.2).
 *
 * It supplies the Spec goal, the verdict context, and the exhaustive lists of
 * groundable artifacts and available citations, so the model can only produce
 * grounded claims. Grounding is still enforced after the call, independent of this
 * prompt.
 */
export function buildTeachPrompt(session: TeachSession): string {
  return [
    ROLE_PREAMBLE,
    fencedBlock('MODULE_GOAL', session.spec.goal),
    fencedBlock('VERIFICATION_CONTEXT', renderVerdictContext(session)),
    fencedBlock('GROUNDABLE_ARTIFACTS', renderGroundableArtifacts(session)),
    fencedBlock('AVAILABLE_CITATIONS', renderAvailableCitations(session)),
    OUTPUT_CONTRACT,
  ].join('\n\n');
}

/** Re-exported for tests that assert a grounding ref is one of the allowed kinds. */
export type GroundingRefKind = ToolOutputRef['kind'];
