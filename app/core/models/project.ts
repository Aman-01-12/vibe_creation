// The Project aggregate: the top-level owned entity a Student works within.
//
// Authorization is decided server-side from `ownerId` on every request; this
// type only records the claim, it does not enforce it (enforcement lives at the
// API_Gateway and Project_Store, task 12).

import type { Ulid } from './identifier.js';

/** A Student's project and its current pointers into Spec and module history. */
export interface Project {
  readonly id: Ulid;
  /** Owner claim used for per-object authorization on every access. */
  readonly ownerId: Ulid;
  /** ISO-8601 timestamp. */
  readonly createdAt: string;
  /** ISO-8601 timestamp. */
  readonly updatedAt: string;
  /** The approved Spec, or `null` before one exists. */
  readonly specId: Ulid | null;
  /** The current module version, or `null` before generation. */
  readonly currentModuleVersionId: Ulid | null;
}
