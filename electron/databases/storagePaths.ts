import { lstatSync, renameSync, type Stats } from "node:fs";
import path from "node:path";

/** Chromium deletes its reserved userData/databases directory during startup. */
export function databaseStorageDirectory(userData: string): string {
  return path.join(userData, "repo-radar-databases");
}

function entry(file: string): Stats | undefined {
  try { return lstatSync(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}

function directory(file: string): boolean {
  const value = entry(file);
  if (!value) return false;
  if (value.isSymbolicLink() || !value.isDirectory()) throw new Error("Database storage must use a regular application directory.");
  return true;
}

/** Run synchronously before creating any BrowserWindow, without opening secrets. */
export function preserveLegacyDatabaseStorage(userData: string): void {
  const legacy = path.join(userData, "databases");
  const destination = databaseStorageDirectory(userData);
  const destinationExists = directory(destination);
  if (!directory(legacy)) return;
  let hasApplicationData = false;
  const markers = ["database-profiles.enc", "database-profiles.v1.enc.bak", "evidence.enc", "diagnostics.enc"];
  // Inspect owned subdirectories before looking for nested markers, so marker
  // recognition never follows a link outside the legacy application directory.
  for (const child of ["library", "dev-submissions"]) {
    if (directory(path.join(legacy, child))) markers.push(path.join(child, "library.json"));
  }
  for (const marker of markers) {
    const value = entry(path.join(legacy, marker));
    if (value?.isSymbolicLink()) throw new Error("Legacy database storage contains a linked application file and requires review.");
    if (value?.isFile()) hasApplicationData = true;
  }
  if (!hasApplicationData) return;
  if (destinationExists) throw new Error("Both current and legacy database storage exist; preserve both and review them before starting Repo Radar.");
  // Move the complete encrypted store, including evidence and migration artifacts.
  // On this Windows application, rename refuses an existing destination directory.
  renameSync(legacy, destination);
}
