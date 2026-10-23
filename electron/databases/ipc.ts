import { BrowserWindow, dialog, ipcMain, safeStorage, type IpcMainInvokeEvent } from "electron";
import { readFile, stat } from "node:fs/promises";
import type { DatabaseDesktopApi } from "../../src/types/databaseApi.js";
import { discoverRepositories } from "../git/discovery.js";
import { getSettings } from "../settings.js";
import { DatabaseService } from "./service.js";
import { databaseStorageDirectory } from "./storagePaths.js";

let service: DatabaseService | undefined;
export function getDatabaseService(directory: string): DatabaseService {
  service ??= new DatabaseService({
    directory: databaseStorageDirectory(directory), protector: safeStorage,
    diagnosticInstructions: "Development diagnostics are configured. The local MCP server starts with Repo Radar when enabled. Open Settings > Databases to see its status and copy the agent connection configuration.",
    root: () => getSettings().rootFolder,
    repositories: async () => {
      const settings = getSettings();
      if (!settings.rootFolder) return [];
      return discoverRepositories(settings.rootFolder, settings.includeNestedRepositories);
    },
    confirm: async plan => {
      const config = await service!.profiles.getConnection(plan.targetId, "migration");
      const result = await dialog.showMessageBox({ type: "warning", title: `Review ${plan.environment} database operation`, message: `${plan.kind === "enroll" ? "Create migration-history tables" : plan.kind === "adopt" ? "Record reviewed baseline adoption" : `Run ${plan.direction} migrations`} on ${plan.environment}?`, detail: `Endpoint: ${config.host}:${config.port}\nDatabase: ${config.database}\n\n${plan.reviewSummary ?? ""}\n\nTarget: ${plan.targetId}\nPlan: ${plan.planId}\nRelease: ${plan.releaseDigest}\nBefore schema: ${plan.beforeSchemaDigest}\nMigrations: ${plan.migrationIds.join(", ") || "none (history setup only)"}\nStatements: ${plan.statementCount}\nExpires: ${plan.expiresAt}\n\nThe exact target, schema, history and recovery evidence will be checked again before execution.`, buttons: ["Cancel", "Run reviewed plan"], defaultId: 0, cancelId: 0, noLink: true });
      return result.response === 1;
    },
    reviewRestoreRecord: async record => {
      if (!record) {
        const chosen = await dialog.showOpenDialog({ title: "Choose externally verified restore evidence", filters: [{ name: "Restore verification record", extensions: ["json"] }], properties: ["openFile"] });
        if (chosen.canceled || !chosen.filePaths[0]) return null;
        if ((await stat(chosen.filePaths[0])).size > 256000) throw new Error("Restore evidence file is too large.");
        return readFile(chosen.filePaths[0], "utf8");
      }
      const result = await dialog.showMessageBox({ type: "warning", title: "Confirm external backup and restore verification", message: "Have you verified this backup is currently available, restored it successfully, and checked its data and recovery limits?", detail: `Backup: ${record.backupIdentity}\nCaptured: ${record.backupCapturedAt}\nRestored: ${record.restoredAt}\nTarget: ${record.targetFingerprint}\nAffected services: ${record.affectedServices.join(", ")}\nMaximum downtime: ${record.downtimeLimitMinutes} minutes\nMaximum data loss: ${record.dataLossLimitMinutes} minutes\n\n${record.verificationLog}\n\nRepo Radar has checked the restored sandbox's structure and migration prerequisites. It cannot verify the external backup provider or the truth of your verification log. Confirm only after independently verifying backup availability, restored data, all shared-database services and application compatibility. This acknowledgment expires after ten minutes.`, buttons: ["Cancel", "I verified the backup, restore and limits"], defaultId: 0, cancelId: 0, noLink: true });
      return result.response === 1;
    },
  });
  return service;
}
export function databaseOperationActive(): boolean { return service?.hasActiveOperation() ?? false; }
export async function invalidateDatabaseSourcePlans(): Promise<void> { service?.invalidateSourcePlans(); await service?.revokeDiagnostics(); }
export async function withDatabaseRootChange<T>(directory: string, operation: () => T | Promise<T>): Promise<T> { return getDatabaseService(directory).serializeRootChange(operation); }

export function registerDatabaseIpc(directory: string): void {
  const methods: (keyof DatabaseDesktopApi)[] = ["overview", "verifyTargets", "saveServerConnection", "getServerConnection", "saveServerCredentials", "discoverDatabases", "assignDatabases", "saveProfile", "saveCredentials", "inspect", "acceptIdentity", "compare", "importProposal", "sealRelease", "history", "createPlan", "runPlan", "rehearse", "exportLibrary", "importLibrary", "configureDiagnostics", "recordRestoreVerification"];
  for (const method of methods) {
    ipcMain.handle(`db:${method}`, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!BrowserWindow.fromWebContents(event.sender) || event.senderFrame !== event.sender.mainFrame) throw new Error("Database operations require Repo Radar's main application view.");
      // Every public service method validates its inputs and fetches trusted capabilities internally.
      const target = getDatabaseService(directory);
      try { return await (target[method] as (...values: unknown[]) => Promise<unknown>).apply(target, args); }
      catch (error) {
        const message = error instanceof Error ? error.message : "Database operation failed.";
        // Raw driver messages can contain statements, data or connection information.
        if (/^ER_|access denied|connect econn|sql syntax|sqlstate|unknown column|unknown database/i.test(message)) throw new Error("Database operation failed. Verify the target prerequisites, permissions and supported SQL.");
        throw error;
      }
    });
  }
}
