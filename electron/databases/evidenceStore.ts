import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { SchemaSnapshot } from "../../src/types/database.js";
import type { MigrationRunResult, RecoveryEvidence } from "../../src/types/databaseExecution.js";
import type { DatabaseSecretProtector } from "./profileStore.js";
import type { ReplayEvidence } from "./rehearsal.js";

export interface RecordedRun { result: MigrationRunResult; profileId: string; releaseDigest: string; migrationIds: string[]; direction: "up" | "down"; at: string }
export interface DatabaseEvidenceState {
  version: 1;
  snapshots: Record<string, SchemaSnapshot>;
  replays: ReplayEvidence[];
  runs: RecordedRun[];
  restores: RecoveryEvidence[];
}
/** Production snapshots never share a file or loader with the dev MCP process. */
export class DatabaseEvidenceStore {
  private pending: Promise<void> = Promise.resolve();
  constructor(private readonly directory: string, private readonly protector: DatabaseSecretProtector) {}
  async read(): Promise<DatabaseEvidenceState> {
    if (!this.protector.isEncryptionAvailable()) throw new Error("Protected database evidence storage is unavailable.");
    try {
      const bytes = await readFile(path.join(this.directory, "evidence.enc"));
      if (bytes.length > 64 * 1024 * 1024) throw new Error();
      const state = JSON.parse(this.protector.decryptString(bytes)) as DatabaseEvidenceState;
      if (state.version !== 1 || !state.snapshots || typeof state.snapshots !== "object" || !Array.isArray(state.replays) || !Array.isArray(state.runs)) throw new Error();
      state.restores ??= [];
      if (!Array.isArray(state.restores)) throw new Error();
      return state;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, snapshots: {}, replays: [], runs: [], restores: [] };
      throw new Error("Database evidence is unavailable or corrupt; no execution evidence can be trusted.");
    }
  }
  update(change: (state: DatabaseEvidenceState) => void): Promise<void> {
    // Dev/production inspection runs in parallel in this process. Serialize its
    // writes before taking the separate cross-process filesystem lock.
    const operation = this.pending.then(() => this.write(change));
    this.pending = operation.catch(() => undefined);
    return operation;
  }
  private async write(change: (state: DatabaseEvidenceState) => void): Promise<void> {
    await mkdir(this.directory, { recursive: true });
    const lock = path.join(this.directory, ".evidence-lock");
    try { await mkdir(lock); } catch { throw new Error("Database evidence is being changed by another process or an interrupted writer; review the lock before continuing."); }
    const temporary = path.join(this.directory, `.evidence-${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      change(state);
      const encrypted = this.protector.encryptString(JSON.stringify(state));
      await writeFile(temporary, encrypted, { flag: "wx", mode: 0o600 });
      await rename(temporary, path.join(this.directory, "evidence.enc"));
    } finally {
      await rm(temporary, { force: true });
      await rmdir(lock);
    }
  }
}
