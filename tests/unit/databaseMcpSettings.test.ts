import { beforeEach, describe, expect, it, vi } from "vitest";
import { defaultSettings } from "../../src/types/settings.js";

const fixture = vi.hoisted(() => ({ data: {} as Record<string, unknown> }));
vi.mock("electron-store", () => ({ default: class {
  get store() { return fixture.data; }
  set(value: Record<string, unknown>) { fixture.data = structuredClone(value); }
} }));
import { getSettings, updateSettings } from "../../electron/settings.js";

beforeEach(() => { fixture.data = {}; });
describe("global database MCP setting", () => {
  it("defaults on for existing installations without changing other saved settings", () => {
    fixture.data = { rootFolder: "C:/fixture-root", github: { tokenSource: "environment" } };
    expect(defaultSettings.databaseMcpEnabled).toBe(true);
    expect(getSettings().databaseMcpEnabled).toBe(true);
    expect(getSettings().rootFolder).toBe("C:/fixture-root");
    expect(fixture.data).not.toHaveProperty("databaseMcpEnabled");
  });
  it("retains an explicit off value across unrelated settings updates", () => {
    updateSettings({ databaseMcpEnabled: false });
    expect(getSettings().databaseMcpEnabled).toBe(false);
    updateSettings({ refreshIntervalMinutes: 9 });
    expect(getSettings().databaseMcpEnabled).toBe(false);
    expect(getSettings().refreshIntervalMinutes).toBe(9);
    expect(fixture.data).not.toHaveProperty("token");
  });
  it("rejects non-boolean input without changing the saved switch", () => {
    updateSettings({ databaseMcpEnabled: false });
    expect(() => updateSettings({ databaseMcpEnabled: "true" as never })).toThrow("true or false");
    expect(getSettings().databaseMcpEnabled).toBe(false);
  });
});
