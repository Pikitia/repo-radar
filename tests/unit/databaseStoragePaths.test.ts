// @vitest-environment node
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { databaseStorageDirectory, preserveLegacyDatabaseStorage } from "../../electron/databases/storagePaths.js";

const fixtures: string[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });
function fixture() {
  const userData = mkdtempSync(path.join(os.tmpdir(), "radar-storage-paths-"));
  fixtures.push(userData);
  return { userData, legacy: path.join(userData, "databases"), destination: databaseStorageDirectory(userData) };
}

describe("database storage paths", () => {
  it("uses an application-owned directory outside Chromium's reserved databases path", () => {
    expect(databaseStorageDirectory(path.join("fixture", "user-data"))).toBe(path.join("fixture", "user-data", "repo-radar-databases"));
  });

  it("moves the entire legacy store before startup and preserves opaque bytes", () => {
    const { userData, legacy, destination } = fixture();
    mkdirSync(path.join(legacy, "library"), { recursive: true });
    const profiles = Buffer.from([0, 255, 29, 128, 0, 42]);
    writeFileSync(path.join(legacy, "database-profiles.enc"), profiles);
    writeFileSync(path.join(legacy, "evidence.enc"), "opaque evidence fixture");
    writeFileSync(path.join(legacy, "library", "library.json"), "fixture library");
    preserveLegacyDatabaseStorage(userData);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(path.join(destination, "database-profiles.enc"))).toEqual(profiles);
    expect(readFileSync(path.join(destination, "evidence.enc"), "utf8")).toBe("opaque evidence fixture");
    expect(readFileSync(path.join(destination, "library", "library.json"), "utf8")).toBe("fixture library");
    expect(() => preserveLegacyDatabaseStorage(userData)).not.toThrow();
  });

  it("preserves a legacy store containing only the encrypted original-profile backup", () => {
    const { userData, legacy, destination } = fixture();
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "database-profiles.v1.enc.bak"), "opaque backup fixture");
    preserveLegacyDatabaseStorage(userData);
    expect(readFileSync(path.join(destination, "database-profiles.v1.enc.bak"), "utf8")).toBe("opaque backup fixture");
  });

  it.each(["evidence.enc", "diagnostics.enc"])("preserves a legacy store containing only %s", marker => {
    const { userData, legacy, destination } = fixture();
    mkdirSync(legacy);
    const bytes = Buffer.from([0, 128, 255, 42]);
    writeFileSync(path.join(legacy, marker), bytes);
    preserveLegacyDatabaseStorage(userData);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(path.join(destination, marker))).toEqual(bytes);
  });

  it.each(["library", "dev-submissions"])("preserves a legacy store containing only %s/library.json", child => {
    const { userData, legacy, destination } = fixture();
    mkdirSync(path.join(legacy, child), { recursive: true });
    writeFileSync(path.join(legacy, child, "library.json"), "opaque library fixture");
    preserveLegacyDatabaseStorage(userData);
    expect(existsSync(legacy)).toBe(false);
    expect(readFileSync(path.join(destination, child, "library.json"), "utf8")).toBe("opaque library fixture");
  });

  it("leaves Chromium-only directories untouched", () => {
    const { userData, legacy, destination } = fixture();
    mkdirSync(legacy);
    writeFileSync(path.join(legacy, "Databases.db"), "Chromium fixture");
    preserveLegacyDatabaseStorage(userData);
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(path.join(legacy, "Databases.db"), "utf8")).toBe("Chromium fixture");
  });

  it("does not create storage for a fresh installation", () => {
    const { userData } = fixture();
    preserveLegacyDatabaseStorage(userData);
    expect(readdirSync(userData)).toEqual([]);
  });

  it("refuses a collision without modifying either store", () => {
    const { userData, legacy, destination } = fixture();
    mkdirSync(legacy); mkdirSync(destination);
    writeFileSync(path.join(legacy, "database-profiles.enc"), "old fixture");
    writeFileSync(path.join(destination, "database-profiles.enc"), "new fixture");
    expect(() => preserveLegacyDatabaseStorage(userData)).toThrow("Both current and legacy");
    expect(readFileSync(path.join(legacy, "database-profiles.enc"), "utf8")).toBe("old fixture");
    expect(readFileSync(path.join(destination, "database-profiles.enc"), "utf8")).toBe("new fixture");
  });

  it("accepts an existing normal current store while leaving unrelated Chromium storage untouched", () => {
    const { userData, legacy, destination } = fixture();
    mkdirSync(destination); mkdirSync(legacy);
    writeFileSync(path.join(destination, "database-profiles.enc"), "current fixture");
    writeFileSync(path.join(legacy, "Databases.db"), "Chromium fixture");
    expect(() => preserveLegacyDatabaseStorage(userData)).not.toThrow();
    expect(readFileSync(path.join(destination, "database-profiles.enc"), "utf8")).toBe("current fixture");
    expect(readFileSync(path.join(legacy, "Databases.db"), "utf8")).toBe("Chromium fixture");
  });

  it.each(["legacy", "destination"] as const)("rejects a linked %s directory without following it", linked => {
    const paths = fixture();
    const outside = path.join(paths.userData, "outside-fixture"); mkdirSync(outside);
    writeFileSync(path.join(outside, "database-profiles.enc"), "untouched outside fixture");
    symlinkSync(outside, paths[linked], "junction");
    expect(() => preserveLegacyDatabaseStorage(paths.userData)).toThrow("regular application directory");
    expect(readFileSync(path.join(outside, "database-profiles.enc"), "utf8")).toBe("untouched outside fixture");
  });

  it.each(["library", "dev-submissions"])("rejects a linked marker subdirectory %s before traversing it", child => {
    const { userData, legacy, destination } = fixture();
    const outside = path.join(userData, "outside-fixture"); mkdirSync(outside); mkdirSync(legacy);
    writeFileSync(path.join(outside, "library.json"), "untouched outside fixture");
    symlinkSync(outside, path.join(legacy, child), "junction");
    expect(() => preserveLegacyDatabaseStorage(userData)).toThrow("regular application directory");
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(path.join(outside, "library.json"), "utf8")).toBe("untouched outside fixture");
  });

  it.each(["evidence.enc", path.join("library", "library.json")])("rejects a linked marker at %s without moving the store", marker => {
    const { userData, legacy, destination } = fixture();
    const outside = path.join(userData, "outside-fixture"); mkdirSync(outside);
    mkdirSync(path.dirname(path.join(legacy, marker)), { recursive: true });
    writeFileSync(path.join(outside, "fixture"), "untouched outside fixture");
    symlinkSync(outside, path.join(legacy, marker), "junction");
    expect(() => preserveLegacyDatabaseStorage(userData)).toThrow("linked application file");
    expect(existsSync(destination)).toBe(false);
    expect(readFileSync(path.join(outside, "fixture"), "utf8")).toBe("untouched outside fixture");
  });

  it.each(["legacy", "destination"] as const)("rejects a regular file at the %s directory path", key => {
    const paths = fixture();
    writeFileSync(paths[key], "unexpected fixture file");
    expect(() => preserveLegacyDatabaseStorage(paths.userData)).toThrow("regular application directory");
    expect(readFileSync(paths[key], "utf8")).toBe("unexpected fixture file");
  });
});
