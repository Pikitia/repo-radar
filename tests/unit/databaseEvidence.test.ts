// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseEvidenceStore } from "../../electron/databases/evidenceStore.js";

const roots: string[] = [];
const protector = { isEncryptionAvailable: () => true, encryptString: (value: string) => Buffer.from(value).reverse(), decryptString: (bytes: Buffer) => Buffer.from(bytes).reverse().toString() };
async function directory() { const root = await mkdtemp(path.join(os.tmpdir(), "repo-radar-evidence-")); roots.push(root); return root; }
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("protected schema and rehearsal evidence", () => {
  it("persists state through a fresh instance without plaintext snapshots", async () => {
    const root = await directory(), store = new DatabaseEvidenceStore(root, protector);
    await store.update(state => { state.runs.push({ profileId: "production-private-name", releaseDigest: "release", migrationIds: [], direction: "up", at: new Date().toISOString(), result: { planId: "plan", state: "succeeded", attemptIds: [] } }); });
    expect((await new DatabaseEvidenceStore(root, protector).read()).runs[0].profileId).toBe("production-private-name");
    expect((await readFile(path.join(root, "evidence.enc"))).includes(Buffer.from("production-private-name"))).toBe(false);
    await store.update(state => { state.runs = []; });
    expect((await store.read()).runs).toEqual([]);
  });
  it("fails closed for unavailable protection or corrupt state", async () => {
    const root = await directory();
    await expect(new DatabaseEvidenceStore(root, { ...protector, isEncryptionAvailable: () => false }).read()).rejects.toThrow("unavailable");
    await writeFile(path.join(root, "evidence.enc"), "unreadable");
    await expect(new DatabaseEvidenceStore(root, protector).read()).rejects.toThrow("corrupt");
  });
  it("preserves parallel inspection writes and accepts updates after a rejected change", async () => {
    const store = new DatabaseEvidenceStore(await directory(), protector);
    const record = (profileId: string) => ({ profileId, releaseDigest: "release", migrationIds: [], direction: "up" as const, at: new Date().toISOString(), result: { planId: profileId, state: "succeeded" as const, attemptIds: [] } });
    await Promise.all(["dev", "production", "sandbox"].map(profileId => store.update(state => { state.runs.push(record(profileId)); })));
    expect((await store.read()).runs.map(run => run.profileId)).toEqual(["dev", "production", "sandbox"]);
    await expect(store.update(() => { throw new Error("Rejected evidence"); })).rejects.toThrow("Rejected");
    await store.update(state => { state.runs.push(record("next")); });
    expect((await store.read()).runs.map(run => run.profileId)).toEqual(["dev", "production", "sandbox", "next"]);
  });
});
