// @vitest-environment node
import os from "node:os";
import path from "node:path";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runGit } from "../../electron/git/exec.js";
import { MigrationLibrary, validateMigrationManifest } from "../../electron/databases/migrations.js";
import type { MigrationManifest } from "../../src/types/migration.js";

let workspace: string;
let library: MigrationLibrary;
let repository: string;
const manifestPath = "db/migrations/change/migration.json";

function manifest(id = "inventory/change", dependsOn: string[] = []): MigrationManifest {
  return {
    formatVersion: 1, id, title: "Add a fixture column", databaseKey: "shared", service: id.split("/")[0], dependsOn,
    engine: { product: "mariadb", minVersion: "10.6.0", requiredSettings: { sql_mode: "STRICT_TRANS_TABLES" }, storageEngines: ["InnoDB"] },
    up: ["up.sql"], preconditions: [{ path: "pre.sql", expect: "scalar-equals", value: 0 }], postconditions: [{ path: "post.sql", expect: "nonempty" }],
    recovery: { mode: "down", down: ["down.sql"], eligibilityChecks: [{ path: "eligible.sql", expect: "empty" }], runbook: "runbook.md", applicationCompatibility: "Version 1 remains compatible", rollbackRoute: "tested-down" },
    dataImpact: { description: "Adds an empty fixture column", destructive: false, requiresWritePause: false, locking: "Metadata lock" },
    applicationCompatibility: "Deploy schema before version 2", expectedSchemaChanges: [{ objectType: "column", objectPath: "stock.note", description: "Add nullable note" }]
  };
}

async function git(repo: string, args: string[]) { return runGit(repo, ["-c", `safe.directory=${repo.replaceAll("\\", "/")}`, ...args]); }

async function makeRepository(name: string): Promise<string> {
  const result = path.join(workspace, name);
  await mkdir(result); await git(result, ["init"]);
  return result;
}

async function writeProposal(repo: string, value = manifest(), sql = "ALTER TABLE stock ADD note TEXT;", relative = manifestPath): Promise<void> {
  const directory = path.dirname(path.join(repo, relative));
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(repo, relative), JSON.stringify(value));
  await Promise.all(Object.entries({ "up.sql": sql, "down.sql": "ALTER TABLE stock DROP note;", "pre.sql": "SELECT 0;", "post.sql": "SELECT 1;", "eligible.sql": "SELECT 1 WHERE FALSE;", "runbook.md": "Pause writes, check compatibility, run eligible down or restore a rehearsed backup." }).map(([file, content]) => writeFile(path.join(directory, file), content)));
}

beforeEach(async () => {
  workspace = await mkdtemp(path.join(os.tmpdir(), "radar-migrations-"));
  repository = await makeRepository("inventory");
  library = new MigrationLibrary(path.join(workspace, "library"));
});
afterEach(async () => { await rm(workspace, { recursive: true, force: true }); });

describe("migration proposal snapshots", () => {
  it("captures dirty/unborn provenance and every referenced byte without changing Git", async () => {
    await writeProposal(repository);
    const before = await git(repository, ["status", "--porcelain=v1"]);
    const proposal = await library.importProposal(repository, manifestPath, workspace);
    expect(proposal.source).toMatchObject({ repositoryPath: repository, commit: null, dirty: true, manifestRelativePath: manifestPath });
    expect(Object.keys(proposal.files)).toHaveLength(6);
    expect(proposal.status).toBe("draft");
    expect(proposal.validationWarnings.join(" ")).toContain("rollback/restore evidence");
    expect((await git(repository, ["status", "--porcelain=v1"])).stdout).toBe(before.stdout);
    await writeFile(path.join(repository, "db/migrations/change/up.sql"), "Changed branch content");
    expect((await library.getProposal(proposal.proposalId)).files["up.sql"]).toContain("ALTER TABLE");
  });

  it("records a real source commit and clean status", async () => {
    await writeProposal(repository);
    await git(repository, ["add", "."]);
    await git(repository, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "fixture"]);
    const proposal = await library.importProposal(repository, manifestPath, workspace);
    expect(proposal.source.commit).toMatch(/^[a-f0-9]{40}$/);
    expect(proposal.source.dirty).toBe(false);
  });

  it("versions changed drafts, resets their status, and freezes sealed content", async () => {
    await writeProposal(repository);
    const first = await library.importProposal(repository, manifestPath, workspace);
    await writeProposal(repository, manifest(), "ALTER TABLE stock ADD note VARCHAR(500);");
    const second = await library.importProposal(repository, manifestPath, workspace);
    expect(second.proposalId).not.toBe(first.proposalId);
    expect(second.status).toBe("draft");
    const release = await library.sealRelease("shared");
    expect(release.migrations[0].proposalId).toBe(second.proposalId);
    expect((await library.getProposal(first.proposalId)).status).toBe("draft");
    await writeProposal(repository, manifest(), "ALTER TABLE stock DROP note;");
    await expect(library.importProposal(repository, manifestPath, workspace)).rejects.toThrow("Sealed migration content cannot change");
    expect((await library.getProposal(second.proposalId)).files["up.sql"]).toContain("VARCHAR(500)");
  });

  it("rejects duplicate identity owned by another repository or database", async () => {
    await writeProposal(repository); await library.importProposal(repository, manifestPath, workspace);
    const other = await makeRepository("other"); await writeProposal(other);
    await expect(library.importProposal(other, manifestPath, workspace)).rejects.toThrow("already owned");
    await writeProposal(repository, { ...manifest(), databaseKey: "other" });
    await expect(library.importProposal(repository, manifestPath, workspace)).rejects.toThrow("already owned");
  });

  it("supports an explicit mapping to existing files within the service repository", async () => {
    await writeProposal(repository);
    await writeFile(path.join(repository, "existing.sql"), "ALTER TABLE stock ADD existing INT;");
    const value = manifest(); value.up = ["../../../existing.sql"];
    await writeFile(path.join(repository, manifestPath), JSON.stringify(value));
    const proposal = await library.importProposal(repository, manifestPath, workspace);
    expect(proposal.files["../../../existing.sql"]).toContain("existing INT");
  });

  it("rejects missing files, directory input, invalid UTF-8 and oversized scripts", async () => {
    await writeProposal(repository);
    const script = path.join(repository, "db/migrations/change/up.sql");
    await rm(script);
    await expect(library.importProposal(repository, manifestPath, workspace)).rejects.toThrow();
    await mkdir(script);
    await expect(library.importProposal(repository, manifestPath, workspace)).rejects.toThrow("not regular");
    await rm(script, { recursive: true });
    await writeFile(script, Buffer.from([0xff, 0xfe]));
    await expect(library.importProposal(repository, manifestPath, workspace)).rejects.toThrow();
    await writeFile(script, "a".repeat(2 * 1024 * 1024 + 1));
    await expect(library.importProposal(repository, manifestPath, workspace)).rejects.toThrow("oversized");
  });

  it("rejects workspace, manifest and referenced-file escapes", async () => {
    await writeProposal(repository);
    await expect(library.importProposal(repository, manifestPath, path.join(repository, "db"))).rejects.toThrow("outside");
    await expect(library.importProposal(path.join(repository, "db"), "migrations/change/migration.json", workspace)).rejects.toThrow("repository root");
    await writeFile(path.join(workspace, "outside.sql"), "outside");
    const value = manifest(); value.up = ["../../../../outside.sql"];
    await writeFile(path.join(repository, manifestPath), JSON.stringify(value));
    await expect(library.importProposal(repository, manifestPath, workspace)).rejects.toThrow("escapes");
    await expect(library.importProposal(repository, "../outside.sql", workspace)).rejects.toThrow("escapes");
  });

  it("rejects junction/symlink escapes", async () => {
    await writeProposal(repository);
    const outside = path.join(workspace, "outside"); await mkdir(outside);
    await writeFile(path.join(outside, "up.sql"), "outside");
    const link = path.join(repository, "linked");
    await symlink(outside, link, "junction");
    const value = manifest(); value.up = ["../../../linked/up.sql"];
    await writeFile(path.join(repository, manifestPath), JSON.stringify(value));
    await expect(library.importProposal(repository, manifestPath, workspace)).rejects.toThrow("escapes");
  });

  it("rejects references into another Git boundary nested inside a service", async () => {
    await writeProposal(repository);
    const nested = path.join(repository, "nested"); await mkdir(nested); await git(nested, ["init"]);
    await writeFile(path.join(nested, "up.sql"), "SELECT 1;");
    const value = manifest(); value.up = ["../../../nested/up.sql"];
    await writeFile(path.join(repository, manifestPath), JSON.stringify(value));
    await expect(library.importProposal(repository, manifestPath, workspace)).rejects.toThrow("nested repository");
  });
});

describe("strict manifest contract", () => {
  it("rejects unknown fields, wrong namespaces, invalid version bounds and missing recovery", () => {
    expect(() => validateMigrationManifest({ ...manifest(), typo: true })).toThrow("Unknown field");
    expect(() => validateMigrationManifest({ ...manifest(), id: "other/change" })).toThrow("namespace");
    const engine = { ...manifest().engine, minVersion: "11.0.0", maxVersion: "10.6.0" };
    expect(() => validateMigrationManifest({ ...manifest(), engine })).toThrow("reversed");
    expect(() => validateMigrationManifest({ ...manifest(), engine: { ...engine, minVersion: "latest" } })).toThrow("major.minor.patch");
    expect(() => validateMigrationManifest({ ...manifest(), recovery: { ...manifest().recovery, down: [] } })).toThrow("Down recovery");
    expect(() => validateMigrationManifest({ ...manifest(), recovery: { ...manifest().recovery, rollbackRoute: "forward-fix" } })).toThrow("tested rollback");
  });

  it("preserves typed scalar values and rejects ambiguous checks", () => {
    for (const value of [null, false, 0, "0"]) {
      const parsed = validateMigrationManifest({ ...manifest(), preconditions: [{ path: "pre.sql", expect: "scalar-equals", value }] });
      expect(parsed.preconditions[0].value).toBe(value);
    }
    expect(() => validateMigrationManifest({ ...manifest(), preconditions: [{ path: "pre.sql", expect: "scalar-equals" }] })).toThrow("typed value");
    expect(() => validateMigrationManifest({ ...manifest(), preconditions: [{ path: "pre.sql", expect: "empty", value: 0 }] })).toThrow("Only scalar");
    expect(() => validateMigrationManifest({ ...manifest(), up: ["C:/secrets.sql"] })).toThrow("relative path");
  });
});

describe("append-only releases and portable library integrity", () => {
  it("topologically orders cross-service proposals by stable ID regardless of submission order", async () => {
    await writeProposal(repository, manifest("inventory/b", ["orders/a"]));
    await library.importProposal(repository, manifestPath, workspace);
    await writeProposal(repository, manifest("inventory/a"), "ALTER TABLE stock ADD a INT;", "db/migrations/a/migration.json");
    await library.importProposal(repository, "db/migrations/a/migration.json", workspace);
    const orders = await makeRepository("orders");
    await writeProposal(orders, manifest("orders/a")); await library.importProposal(orders, manifestPath, workspace);
    const release = await library.sealRelease("shared");
    expect(release.migrations.map((entry) => [entry.sequence, entry.id])).toEqual([[1, "inventory/a"], [2, "orders/a"], [3, "inventory/b"]]);
    expect(await library.sealRelease("shared")).toEqual(release);
    await writeProposal(repository, manifest("inventory/0"), "ALTER TABLE stock ADD zero INT;", "db/migrations/zero/migration.json");
    await library.importProposal(repository, "db/migrations/zero/migration.json", workspace);
    const next = await library.sealRelease("shared");
    expect(next.migrations.slice(0, 3)).toEqual(release.migrations);
    expect(next.migrations[3].id).toBe("inventory/0");
    expect(next.parentReleaseDigest).toBe(release.digest);
  });

  it("rejects missing and cyclic dependencies without partially sealing", async () => {
    await writeProposal(repository, manifest("inventory/a", ["inventory/b"]));
    await library.importProposal(repository, manifestPath, workspace);
    await expect(library.sealRelease("shared")).rejects.toThrow("Missing dependency");
    await writeProposal(repository, manifest("inventory/b", ["inventory/a"]), "SELECT 1;", "db/migrations/b/migration.json");
    await library.importProposal(repository, "db/migrations/b/migration.json", workspace);
    await expect(library.sealRelease("shared")).rejects.toThrow("cycle");
    expect((await library.listProposals()).every((proposal) => proposal.status === "draft")).toBe(true);
    expect(await library.getRelease("shared")).toBeUndefined();
  });

  it("exports sealed SQL to a fresh library and rejects modified SQL or release order", async () => {
    await writeProposal(repository); const proposal = await library.importProposal(repository, manifestPath, workspace);
    const release = await library.sealRelease("shared"), exported = await library.exportLibrary();
    const fresh = new MigrationLibrary(path.join(workspace, "fresh"));
    await fresh.importLibrary(exported);
    expect(await fresh.getRelease("shared")).toEqual(release);
    expect((await fresh.getProposal(proposal.proposalId)).files).toEqual(proposal.files);
    await expect(fresh.importLibrary(exported)).rejects.toThrow("empty library");
    const tampered = JSON.parse(exported); tampered.proposals[0].files["up.sql"] = "DROP DATABASE shared;";
    await expect(new MigrationLibrary(path.join(workspace, "bad")).importLibrary(JSON.stringify(tampered))).rejects.toThrow("digest mismatch");
    const broken = JSON.parse(exported); broken.releases[0].migrations[0].sequence = 10;
    await expect(new MigrationLibrary(path.join(workspace, "bad2")).importLibrary(JSON.stringify(broken))).rejects.toThrow("Invalid release");
  });

  it("adopts broker drafts immutably and safely re-collects older known drafts after sealing", async () => {
    await writeProposal(repository);
    const first = await library.importProposal(repository, manifestPath, workspace);
    const main = new MigrationLibrary(path.join(workspace, "main"));
    await main.importProposalSnapshot(first);
    await writeProposal(repository, manifest(), "ALTER TABLE stock ADD note VARCHAR(20);");
    const second = await library.importProposal(repository, manifestPath, workspace);
    await main.importProposalSnapshot(second); await main.sealRelease("shared");
    expect((await main.importProposalSnapshot(first)).proposalId).toBe(first.proposalId);
    expect((await main.getRelease("shared"))?.migrations[0].proposalId).toBe(second.proposalId);
    const tampered = structuredClone(second); tampered.files["up.sql"] = "DROP DATABASE shared;";
    await expect(main.importProposalSnapshot(tampered)).rejects.toThrow("digest mismatch");
    await expect(main.importProposalSnapshot(await main.getProposal(second.proposalId))).rejects.toThrow("Only draft");
  });

  it("checks persisted integrity on every read and fails closed with an existing writer lock", async () => {
    await writeProposal(repository); await library.importProposal(repository, manifestPath, workspace);
    const storage = path.join(workspace, "library");
    await mkdir(path.join(storage, ".write-lock"));
    await expect(library.sealRelease("shared")).rejects.toThrow("locked");
    expect((await library.listProposals())[0].status).toBe("draft");
    const raw = JSON.parse(await readFile(path.join(storage, "library.json"), "utf8")); raw.proposals[0].manifest.title = "tampered";
    await writeFile(path.join(storage, "library.json"), JSON.stringify(raw));
    await expect(library.listProposals()).rejects.toThrow("digest mismatch");
  });
});
