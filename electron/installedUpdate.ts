import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { open } from "node:fs/promises";
import path from "node:path";

type OmarchyInstall = {
  sourceDirectory: string;
  dataHome: string;
  launcher: string;
  node: string;
  npm: string;
};

export function readOmarchyInstall(resourcesPath: string): OmarchyInstall | undefined {
  try {
    const install = JSON.parse(readFileSync(path.join(resourcesPath, "repo-radar-install.json"), "utf8")) as Partial<OmarchyInstall>;
    if ([install.sourceDirectory, install.dataHome, install.launcher, install.node, install.npm].every(value => typeof value === "string" && path.isAbsolute(value))) {
      return install as OmarchyInstall;
    }
  } catch {
    // Install metadata is only present in builds installed by install:omarchy.
  }
}

export async function rebuildOmarchyInstall(install: OmarchyInstall, userData: string): Promise<void> {
  const logPath = path.join(userData, "omarchy-update.log");
  const log = await open(logPath, "w", 0o600);
  try {
    await new Promise<void>((resolve, reject) => {
      const build = spawn(install.node, [install.npm, "run", "update:omarchy"], {
        cwd: install.sourceDirectory,
        env: {
          ...process.env,
          PATH: [path.dirname(install.node), process.env.PATH].filter(Boolean).join(path.delimiter),
          XDG_DATA_HOME: install.dataHome
        },
        shell: false,
        stdio: ["ignore", log.fd, log.fd]
      });
      build.once("error", error => reject(new Error(`Could not start the update from ${install.sourceDirectory}. ${error.message}`)));
      build.once("close", (code, signal) => {
        if (code === 0) resolve();
        else reject(new Error(`The build failed (${signal ?? `exit ${code}`}). See ${logPath}.`));
      });
    });
  } finally {
    await log.close();
  }
}
