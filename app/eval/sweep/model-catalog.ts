// The bake-off model catalog: the bedrock-mantle model ids proven reachable on this
// host, offered as a CONVENIENCE DEFAULT and nothing more.
//
// WHY THIS IS NOT A VALIDATION LIST
//   The bedrock-mantle catalog changes upstream without our code changing. A runtime
//   allow-list built from this constant would reject a newly available model - and
//   the pressure that creates is worse than the mistake it prevents, because the
//   obvious fix is to disable the check. So `parseSweepConfig` accepts ANY non-blank
//   model id the config names, and this list exists only so an operator writing a
//   config has the known-good ids in front of them and so the example config is not
//   invented.
//
//   The real protection against a typo'd model id is not a list: it is that the
//   arm's calls fail, the arm's records show it, and the summary reports the failure
//   rate. A bake-off that hides a model's failures is the defect; one that reports
//   them is working.
//
// WHAT "REACHABLE" MEANS
//   Each id here answered a real Chat Completions call on the bedrock-mantle host
//   with the credential in `AWS_BEARER_TOKEN_BEDROCK`. Reachability is not a claim
//   about quality - deciding that is the entire point of the sweep.

/**
 * The bedrock-mantle model ids a bake-off arm may name, in a stable order.
 *
 * Frozen so a caller cannot mutate the shared default, and ordered so a config
 * generated from it is deterministic.
 */
export const BAKEOFF_MODEL_CATALOG: readonly string[] = Object.freeze([
  'moonshotai.kimi-k2.5',
  'zai.glm-5',
  'zai.glm-4.7',
  'deepseek.v3.2',
  'qwen.qwen3-coder-480b-a35b-instruct',
  'qwen.qwen3-coder-next',
  'qwen.qwen3-coder-30b-a3b-instruct',
  'qwen.qwen3-235b-a22b-2507',
  'mistral.mistral-large-3-675b-instruct',
  'mistral.devstral-2-123b',
  'minimax.minimax-m2.5',
]);
