// @vitest-environment node
import { describe, expect, it } from "vitest";
import { replayMatchesTarget } from "../../electron/databases/service.js";
import type { DatabaseHistory, HistoryEvent, RunnerMigration, RunnerTarget } from "../../src/types/databaseExecution.js";
import type { ReplayEvidence } from "../../electron/databases/rehearsal.js";

const target: RunnerTarget = { targetId: "dev", databaseKey: "shared", environment: "dev", identity: { fingerprint: "dev", serverId: "one", database: "modern", engine: "mysql", version: "8.4.8", settings: { sqlMode: "STRICT_TRANS_TABLES", lowerCaseTableNames: 0, characterSet: "utf8mb4", collation: "utf8mb4_0900_ai_ci" } } };
const migrations: RunnerMigration[] = ["one", "two"].map((name, index) => ({ id: `shared/${name}`, sequence: index + 1, contentDigest: name, upSql: [], downSql: [], preconditions: [], postconditions: [], eligibilityChecks: [], transactional: false, recoveryRoute: "tested-down" }));
const base: DatabaseHistory = { enrolled: true, identityFingerprint: "dev", baselineDigest: "baseline", events: [], digest: "initial-history" };
const proof: ReplayEvidence = { evidenceId: "proof", databaseKey: "shared", targetId: "dev", releaseDigest: "release", createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 60000).toISOString(), assessment: "explained", notes: [], migrationIds: migrations.map(migration => migration.id), beforeSchemaDigest: "baseline", afterSchemaDigest: "after-two", historyDigest: base.digest, history: base, appliedIds: [], testedDownIds: migrations.map(migration => migration.id), upDigests: { "shared/one": "after-one", "shared/two": "after-two" }, downDigests: { "shared/two": "after-one", "shared/one": "baseline" }, changesByMigration: {}, baseline: { identity: target.identity, digest: "baseline", capturedAt: new Date().toISOString(), objects: [], coverage: { complete: true, limitations: [] } } };
function applied(count: number): DatabaseHistory {
  const events: HistoryEvent[] = migrations.slice(0, count).flatMap((migration, index) => [{ eventId: index * 2 + 1, kind: "attempt-start" as const, at: new Date().toISOString(), attemptId: migration.id, migrationId: migration.id, contentDigest: migration.contentDigest, sequence: migration.sequence, direction: "up" as const }, { eventId: index * 2 + 2, kind: "attempt-end" as const, at: new Date().toISOString(), attemptId: migration.id, state: "succeeded" as const }]);
  return { ...base, events, digest: `history-${count}` };
}
describe("rehearsal target and prefix binding", () => {
  it("allows the tested down path after applying only the first of two migrations", () => {
    expect(replayMatchesTarget(proof, target, "release", "after-one", applied(1), migrations, "down")).toBe(true);
    expect(replayMatchesTarget(proof, target, "release", "after-two", applied(2), migrations, "down")).toBe(true);
  });
  it("requires a fresh proof for changed up history and rejects unrelated structure", () => {
    expect(replayMatchesTarget(proof, target, "release", "baseline", base, migrations, "up")).toBe(true);
    expect(replayMatchesTarget(proof, target, "release", "after-one", applied(1), migrations, "up")).toBe(false);
    expect(replayMatchesTarget(proof, target, "release", "manual-drift", applied(1), migrations, "down")).toBe(false);
  });
  it("cannot reuse proof after accepting another engine version or SQL mode with unchanged structure", () => {
    expect(replayMatchesTarget(proof, { ...target, identity: { ...target.identity, version: "8.4.9" } }, "release", "baseline", base, migrations, "up")).toBe(false);
    expect(replayMatchesTarget(proof, { ...target, identity: { ...target.identity, settings: { ...target.identity.settings, sqlMode: "" } } }, "release", "baseline", base, migrations, "up")).toBe(false);
  });
  it("rejects missing baseline journals, changed enrollment and expired evidence", () => {
    expect(replayMatchesTarget({ ...proof, history: undefined }, target, "release", "baseline", base, migrations, "up")).toBe(false);
    expect(replayMatchesTarget(proof, target, "release", "baseline", { ...base, baselineDigest: "replaced" }, migrations, "up")).toBe(false);
    expect(replayMatchesTarget({ ...proof, expiresAt: new Date(0).toISOString() }, target, "release", "baseline", base, migrations, "up")).toBe(false);
  });
});
