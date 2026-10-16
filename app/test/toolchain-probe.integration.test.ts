// Real-host Formal_Toolchain version probe (task 6.4, Req 8.2).
//
// The one question a hand-built manifest fixture cannot answer: did a recorded version come
// from THIS host's tool, or from a constant? Each entry is checked against a second,
// independent spawn of the same binary, so no version string is pinned. See design.md C16.

import { spawnSync } from 'node:child_process';

import { describe, expect, it } from 'vitest';

import {
  probeFormalToolchainAvailability,
  probeToolchainVersions,
  withoutFilesystemPaths,
  type ManifestToolchain,
  type ProbedVersion,
} from '@app/eval';

/** The single owner of "can this host run a proof"; a skip here is correct, not a pass. */
const CHAIN = probeFormalToolchainAvailability();

if (!CHAIN.available) {
  console.warn(
    `[toolchain-probe.integration] Version provenance was NOT exercised on this host: ${CHAIN.reason}.`,
  );
}

/** Bounded so a tool that never answers terminates this probe rather than the suite. */
const OWN_SPAWN_TIMEOUT_MS = 10_000;

/** The yosys git revision, read independently of `host-facts.ts`'s own pattern. */
const YOSYS_SHA1_RE = /git sha1 ([0-9a-f]{7,40})/;

/** A usage banner, which is what a tool with no version flag prints instead. */
const USAGE_RE = /\busage\b|\[options\]/i;

/** The probe under test, run once so all three examples read one record, as a manifest does. */
let probedOnce: ManifestToolchain | null = null;

function probed(): ManifestToolchain {
  probedOnce ??= probeToolchainVersions(null);
  return probedOnce;
}

/**
 * What this host's own binary prints, read without the module under test.
 *
 * A second reader rather than a reuse of `probeVersion`: one shared parser would cancel out
 * its own bug. Path stripping is shared, because that rule is exported as the rule.
 */
function ownFirstLine(bin: string, args: readonly string[]): string {
  const run = spawnSync(bin, [...args], { encoding: 'utf8', timeout: OWN_SPAWN_TIMEOUT_MS });
  const text = `${run.stdout ?? ''}${run.stderr ?? ''}`;
  return withoutFilesystemPaths(text.split('\n')[0]?.trim() ?? '');
}

/** An entry as a failure should name it: the arm, and the value or reason behind it. */
function stated(entry: ProbedVersion): string {
  return entry.kind === 'read' ? `read: ${entry.value}` : `not-measured: ${entry.reason}`;
}

describe.skipIf(!CHAIN.available)(
  'Formal_Toolchain versions are obtained by probing this host (Req 8.2)',
  () => {
    it('records, for each installed tool, the version line that tool prints here', () => {
      const toolchain = probed();
      const cases = [
        { bin: 'yosys', args: ['-V'], entry: toolchain.yosysVersion },
        { bin: 'bitwuzla', args: ['--version'], entry: toolchain.bitwuzlaVersion },
        { bin: 'z3', args: ['--version'], entry: toolchain.z3Version },
      ] as const;

      for (const { bin, args, entry } of cases) {
        expect(`${bin} ${entry.kind}`).toBe(`${bin} read`);
        const value = entry.kind === 'read' ? entry.value : stated(entry);

        expect(value).toMatch(/\d/);
        expect(value).not.toContain('/');
        // A stale or hardcoded value is not a prefix of what the tool just printed. The
        // comparison is a prefix because the recorded line is bounded in length.
        expect(ownFirstLine(bin, args).slice(0, value.length)).toBe(value);
      }
    });

    it('lands yosys-smtbmc as not-measured with the reason naming its usage banner', () => {
      const entry = probed().yosysSmtBmcVersion;

      expect(stated(entry)).toContain('not-measured');
      expect(stated(entry)).toContain('usage');
      // The independent half: a failure here says upstream grew a version flag, which is a
      // finding against design.md C16 rather than a misreading on our side.
      expect(ownFirstLine('yosys-smtbmc', ['--version'])).toMatch(USAGE_RE);
    });

    it('records the yosys build identifier whenever the release line carries one', () => {
      const { yosysVersion, yosysBuildId } = probed();
      const release = yosysVersion.kind === 'read' ? yosysVersion.value : '';
      const sha1 = YOSYS_SHA1_RE.exec(release)?.[1];

      if (sha1 === undefined) {
        expect(stated(yosysBuildId)).toContain('not-measured');
        return;
      }
      expect(stated(yosysBuildId)).toBe(`read: ${sha1}`);
    });
  },
);
