// The reviewed per-design Validity_Output declarations (Q-18).
//
// A declaration, not a name match, so the corpus takes the same path a student Spec does.
// Every design absent from this table declares no Validity_Output.

/** Problem id to the output port its Spec declares as the Validity_Output. */
export const RTLLM_VALIDITY_OUTPUTS: Readonly<Record<string, string>> = Object.freeze({
  // The Spec says no output before four inputs; the reference shows partial sums meanwhile.
  'rtllm/arithmetic/accu': 'valid_out',
});

/** The declared Validity_Output for `problemId`, or `null` when it declares none. */
export function validityOutputFor(problemId: string): string | null {
  return Object.hasOwn(RTLLM_VALIDITY_OUTPUTS, problemId)
    ? (RTLLM_VALIDITY_OUTPUTS[problemId] ?? null)
    : null;
}
