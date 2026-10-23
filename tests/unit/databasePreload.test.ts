import { describe, expect, it, vi } from "vitest";
import type { RepoRadarApi } from "../../src/types/api.js";

const electron = vi.hoisted(() => ({ exposeInMainWorld: vi.fn(), invoke: vi.fn(), on: vi.fn(), removeListener: vi.fn() }));
vi.mock("electron", () => ({ contextBridge: { exposeInMainWorld: electron.exposeInMainWorld }, ipcRenderer: electron }));
describe("database preload boundary", () => {
  it("exposes only named typed database capabilities, without raw connection or SQL access", async () => {
    await import("../../electron/preload.js");
    const api = electron.exposeInMainWorld.mock.calls[0][1] as RepoRadarApi;
    await api.databases.verifyTargets(["dev", "prod"]);
    expect(electron.invoke).toHaveBeenCalledWith("db:verifyTargets", ["dev", "prod"]);
    await api.getDatabaseMcpStatus();
    expect(electron.invoke).toHaveBeenCalledWith("database-mcp:status");
    await api.copyDatabaseMcpConfig();
    expect(electron.invoke).toHaveBeenCalledWith("database-mcp:copyConfig");
    await api.databases.createPlan({ profileId: "dev", kind: "enroll", direction: "up", migrationIds: [] });
    expect(electron.invoke).toHaveBeenCalledWith("db:createPlan", { profileId: "dev", kind: "enroll", direction: "up", migrationIds: [] });
    await api.databases.runPlan("plan");
    expect(electron.invoke).toHaveBeenCalledWith("db:runPlan", "plan");
    await api.databases.getServerConnection("server");
    expect(electron.invoke).toHaveBeenCalledWith("db:getServerConnection", "server");
    await api.databases.saveServerConnection({ label: "Shared server", host: "db.invalid", port: 3306, tlsMode: "disabled" });
    expect(electron.invoke).toHaveBeenCalledWith("db:saveServerConnection", { label: "Shared server", host: "db.invalid", port: 3306, tlsMode: "disabled" });
    await api.databases.saveServerCredentials("server", "inspection", { username: "reader" });
    expect(electron.invoke).toHaveBeenCalledWith("db:saveServerCredentials", "server", "inspection", { username: "reader" });
    await api.databases.discoverDatabases("server");
    expect(electron.invoke).toHaveBeenCalledWith("db:discoverDatabases", "server");
    await api.databases.assignDatabases("server", []);
    expect(electron.invoke).toHaveBeenCalledWith("db:assignDatabases", "server", []);
    expect(Object.keys(api.databases)).not.toContain("query");
    expect(Object.keys(api.databases)).not.toContain("getCredentials");
    expect(Object.keys(api.databases)).not.toContain("issueApproval");
  });
});
