// The closed set of host environment variables the local worker child may inherit, and the
// pure projection that applies it. A deny-list would leak the next credential added anywhere
// in the repository. See design.md of `formal-gate-first-light`, Component 1.

/**
 * Host variable names the worker child may inherit: `PATH` alone, which the toolchain needs
 * to find `iverilog` and `vvp`. Widen only on a measured failure, and only here (Req 1.2).
 */
export const WORKER_ENVIRONMENT_ALLOWLIST: readonly string[] = Object.freeze(['PATH']);

/** One host environment projected onto the allowlist. */
export interface ProjectedWorkerEnvironment {
  /** The allowlisted names the host held, with their values. */
  readonly env: Readonly<Record<string, string>>;
  /**
   * Allowlisted names the host did not hold. Names only, so no diagnostic built from this
   * can emit a value (Req 1.9).
   */
  readonly absent: readonly string[];
}

/**
 * Keep the allowlisted names the host holds, and name the ones it did not.
 *
 * Takes the host environment as an argument rather than reading `process.env`, which keeps it
 * pure and makes the closure testable without spawning anything.
 */
export function projectWorkerEnvironment(
  hostEnv: Readonly<Record<string, string | undefined>>,
): ProjectedWorkerEnvironment {
  const env: Record<string, string> = {};
  const absent: string[] = [];
  for (const name of WORKER_ENVIRONMENT_ALLOWLIST) {
    // An empty string is a value the host holds; only `undefined` means the name is absent.
    const value = hostEnv[name];
    if (value === undefined) {
      absent.push(name);
      continue;
    }
    env[name] = value;
  }
  return { env, absent };
}
