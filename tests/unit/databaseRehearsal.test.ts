// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { DatabaseIdentity, SchemaSnapshot } from "../../src/types/database.js";
import type { RunnerMigration } from "../../src/types/databaseExecution.js";
import type { SqlSession } from "../../electron/databases/connections.js";
import { rehearseOnEmptySandbox } from "../../electron/databases/rehearsal.js";

const fixture = vi.hoisted(() => ({ phase: "empty", calls: [] as string[] }));
vi.mock("../../electron/databases/schema.js", () => ({
  captureSchema: async (_session: unknown, identity: DatabaseIdentity) => ({ identity, digest: fixture.phase === "changed" ? "after" : "before", capturedAt: "2026-10-19T00:00:00Z", coverage: { complete: true, limitations: [] }, objects: fixture.phase === "empty" ? [] : [{ objectType: "table", objectPath: "orders/definition", definition: "CREATE TABLE orders (id INT)" }, ...(fixture.phase === "changed" ? [{ objectType: "column", objectPath: "orders.reference", definition: "VARCHAR(64)" }] : [])] }),
}));
const identity = (serverId: string): DatabaseIdentity => ({ serverId, database: "fixture", engine: "mysql", version: "8.4.8", fingerprint: serverId, settings: { sqlMode: "", lowerCaseTableNames: 0, characterSet: "utf8mb4", collation: "utf8mb4_0900_ai_ci" } });
const snapshot = (serverId: string, empty = false): SchemaSnapshot => ({ identity: identity(serverId), digest: "before", capturedAt: "2026-10-19T00:00:00Z", coverage: { complete: true, limitations: [] }, objects: empty ? [] : [{ objectType: "table", objectPath: "orders/definition", definition: "CREATE TABLE orders (id INT)" }] });
const migration: RunnerMigration = { id: "orders/reference", sequence: 1, contentDigest: "hash", upSql: ["ALTER TABLE orders ADD COLUMN reference VARCHAR(64)"], downSql: ["ALTER TABLE orders DROP COLUMN reference"], preconditions: [], postconditions: [], eligibilityChecks: [], transactional: false, recoveryRoute: "tested-down" };
function session(): SqlSession {
  fixture.phase = "empty"; fixture.calls = [];
  return {
    query: async sql => sql.includes("information_schema.TABLES") && fixture.phase !== "empty" ? [{ TABLE_NAME: "orders" }] : [],
    execute: async sql => { fixture.calls.push(sql); if (sql.startsWith("CREATE TABLE")) fixture.phase = "base"; if (sql.includes("ADD COLUMN")) fixture.phase = "changed"; if (sql.includes("DROP COLUMN")) fixture.phase = "base"; if (sql.startsWith("DROP TABLE")) fixture.phase = "empty"; },
    close: async () => undefined,
  };
}
function input(db = session()) { return { session: db, sandbox: snapshot("sandbox", true), baseline: snapshot("managed"), targetId: "production", databaseKey: "shared", releaseDigest: "release", historyDigest: "history", migrations: [migration], appliedIds: [], expectedDev: { ...snapshot("development"), digest: "after" } }; }

describe("isolated rehearsal evidence", () => {
  it("records per-migration structure and up/down/up proof, then removes only its fixture", async () => {
    const result = await rehearseOnEmptySandbox(input());
    expect(result.assessment).toBe("explained");
    expect(result.upDigests).toEqual({ "orders/reference": "after" });
    expect(result.downDigests).toEqual({ "orders/reference": "before" });
    expect(result.testedDownIds).toEqual(["orders/reference"]);
    expect(result.changesByMigration["orders/reference"]).toContain("column:orders.reference");
    expect(fixture.calls.filter(sql => sql.includes("ADD COLUMN"))).toHaveLength(2);
    expect(fixture.phase).toBe("empty");
  });
  it("rejects same-server sandboxes and never clears existing objects", async () => {
    const request = input(); request.sandbox.identity.serverId = request.baseline.identity.serverId;
    await expect(rehearseOnEmptySandbox(request)).rejects.toThrow("separate");
    expect(fixture.calls).toEqual([]);
    request.sandbox = snapshot("sandbox");
    await expect(rehearseOnEmptySandbox(request)).rejects.toThrow("empty");
    expect(fixture.calls).toEqual([]);
  });
  it("does not treat excluded history objects as an empty sandbox or delete them", async () => {
    const db = session();
    db.query = async sql => sql.includes("information_schema.TABLES") ? [{ TABLE_NAME: "db_radar_enrollment", TABLE_TYPE: "BASE TABLE" }] : [];
    await expect(rehearseOnEmptySandbox(input(db))).rejects.toThrow("physically empty");
    expect(fixture.calls).toEqual([]);
  });
  it("cleans owned table names using server casing and preserves unrelated tables", async () => {
    const db = session();
    db.query = async sql => sql.includes("information_schema.TABLES") && fixture.phase !== "empty" ? [{ TABLE_NAME: "orders" }, { TABLE_NAME: "unrelated" }] : [];
    const request = input(db);
    for (const captured of [request.sandbox, request.baseline, request.expectedDev!]) captured.identity.settings.lowerCaseTableNames = 1;
    request.baseline.objects[0].definition = "CREATE TABLE Orders (id INT)";
    await rehearseOnEmptySandbox(request);
    expect(fixture.calls).toContain("DROP TABLE `orders`");
    expect(fixture.calls).not.toContain("DROP TABLE `unrelated`");
    expect(fixture.phase).toBe("empty");
  });
  it("does not turn data-dependent checks or conditional down into successful recovery evidence", async () => {
    const request = input(); request.migrations = [{ ...migration, conditionalDown: true }];
    const result = await rehearseOnEmptySandbox(request);
    expect(result.testedDownIds).toEqual(["orders/reference"]);
    expect(result.notes.join(" ")).toContain("backup/restore");
    const failed = input(); failed.migrations = [{ ...migration, preconditions: [{ sql: "SELECT id FROM orders", expect: "nonempty" }] }];
    await expect(rehearseOnEmptySandbox(failed)).rejects.toThrow("data-dependent");
    expect(fixture.calls.some(sql => sql.includes("ADD COLUMN"))).toBe(false);
  });
  it("leaves mismatched structure unexplained and refuses unsupported definitions before writes", async () => {
    const request = input(); request.expectedDev!.digest = "manual-drift";
    expect((await rehearseOnEmptySandbox(request)).assessment).toBe("unexplained");
    const unsupported = input(); unsupported.baseline.objects.push({ objectType: "view", objectPath: "secret_view", definition: "SELECT * FROM elsewhere" });
    await expect(rehearseOnEmptySandbox(unsupported)).rejects.toThrow("base tables only");
    expect(fixture.calls).toEqual([]);
  });
});
