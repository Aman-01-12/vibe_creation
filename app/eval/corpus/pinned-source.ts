// The PINNED upstream RTLLM benchmark source: what we fetch, at exactly which
// commit, and how its checkout is laid out.
//
// WHY PINNED, AND WHY A NAMED CONSTANT
//   pass@k is only comparable across runs if the problems are identical across
//   runs. A corpus that moves silently invalidates every historical pass@k number
//   and, worse, silently moves the eval-gate baseline the ratchet compares against
//   - a benchmark that got easier would read as a model improvement. So the commit
//   is pinned HERE as a named constant, the fetch verifies the checkout landed on
//   exactly that commit, and a run manifest can cite `RTLLM_PINNED_COMMIT`
//   alongside its numbers.
//
// WHY NOT VENDORED
//   Copying 50 third-party designs into this tree would make our repository the de
//   facto fork of someone else's benchmark: upstream corrections (v2.1 fixed several
//   design descriptions and testbenches) would have to be hand-merged, and a
//   reviewer could no longer tell our code from theirs. The checkout is therefore
//   fetched into a gitignored working location and verified by commit hash, which is
//   content-addressed and so is a stronger integrity guarantee than a vendored copy
//   that nothing checks.
//
// ATTRIBUTION (upstream is MIT licensed; see LICENSE in the fetched checkout)
//   Benchmark: RTLLM - https://github.com/hkust-zhiyao/RTLLM
//   Copyright (c) 2024 Nora Lu. Licensed under the MIT License.
//   Cite, per the upstream README:
//     Lu, Yao; Liu, Shang; Zhang, Qijun; Xie, Zhiyao. "RTLLM: An Open-Source
//     Benchmark for Design RTL Generation with Large Language Model." 2024 29th
//     Asia and South Pacific Design Automation Conference (ASP-DAC), 2024,
//     pp. 722-727, IEEE.
//     Liu, Shang; Lu, Yao; Fang, Wenji; Li, Mengming; Xie, Zhiyao. "OpenLLM-RTL:
//     Open Dataset and Benchmark for LLM-Aided Design RTL Generation (Invited)."
//     Proceedings of 2024 IEEE/ACM International Conference on Computer-Aided
//     Design (ICCAD), 2024, ACM.
//   We redistribute none of it: the fetch step downloads it at run time and this
//   layer only reads it.

/** The upstream benchmark repository this corpus is imported from. */
export const RTLLM_REPOSITORY_URL = 'https://github.com/hkust-zhiyao/RTLLM.git' as const;

/**
 * The exact upstream commit the corpus is pinned to (upstream state "v2.1", which
 * corrected several design descriptions and testbenches).
 *
 * Changing this value changes the benchmark, so it invalidates every recorded
 * pass@k number and the eval-gate baseline measured against the old corpus. Treat
 * a bump as a deliberate, reviewed re-baselining, never as a routine update.
 */
export const RTLLM_PINNED_COMMIT = '51ed553d0ffd32797a1a0a13e051656bf302c81f' as const;

/** The upstream license, recorded so a run manifest can state it without a fetch. */
export const RTLLM_LICENSE = 'MIT' as const;

/**
 * The four top-level category folders, in the order `File_list.md` presents them.
 *
 * Iterated in this fixed order so the imported corpus is deterministic: problem
 * order feeds nothing random, but a stable order keeps two imports of the same
 * checkout byte-identical.
 */
export const RTLLM_CATEGORY_DIRECTORIES: readonly string[] = Object.freeze([
  'Arithmetic',
  'Control',
  'Memory',
  'Miscellaneous',
]);

/** The number of designs upstream ships at the pinned commit (a sanity check, not a filter). */
export const RTLLM_EXPECTED_DESIGN_COUNT = 50;

/** The natural-language problem statement file inside each design folder. */
export const DESIGN_DESCRIPTION_FILENAME = 'design_description.txt' as const;

/** The golden testbench file inside each design folder; never modified by us. */
export const GOLDEN_TESTBENCH_FILENAME = 'testbench.v' as const;

/**
 * Files present in a design folder that are neither the description, the golden
 * testbench, the reference RTL, nor a build script - i.e. the data files a
 * testbench reads with `$readmemh`/`$fscanf` and that must be materialized
 * alongside it for the golden run to work.
 */
export const VCS_MAKEFILE_FILENAME = 'makefile' as const;

/**
 * The prefix upstream puts on its reference RTL files (`verified_<name>.v`).
 *
 * Upstream also prefixes the reference's TOP MODULE with `verified_` for most
 * designs, so the reference does not occupy the module name a candidate must
 * implement. Stage 0 undoes exactly that prefix on the reference (never on the
 * testbench) so the reference answers to the name its own golden testbench
 * instantiates.
 */
export const REFERENCE_PREFIX = 'verified_' as const;

/** The category a design was drawn from, carried through into the corpus. */
export type RtllmCategory = 'Arithmetic' | 'Control' | 'Memory' | 'Miscellaneous';

/** Narrow an untrusted directory name to a known category, or `null`. */
export function asRtllmCategory(name: string): RtllmCategory | null {
  return RTLLM_CATEGORY_DIRECTORIES.includes(name) ? (name as RtllmCategory) : null;
}

/**
 * The stable problem id for one design: `rtllm/<category>/<design>`.
 *
 * The id feeds the deterministic per-sample seed and is referenced by recorded
 * baselines, so it MUST never change once published. It is intentionally derived
 * from the category and design folder names only - never from a subcategory,
 * a file name, or a parsed module name, all of which upstream has already moved
 * at least once.
 */
export function rtllmProblemId(category: RtllmCategory, designName: string): string {
  return `rtllm/${category.toLowerCase()}/${designName}`;
}
