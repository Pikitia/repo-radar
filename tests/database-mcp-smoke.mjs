import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import electron from "electron";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync } from "node:fs";

const packagedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (packagedExecutable && !existsSync(path.join(path.dirname(packagedExecutable), "resources", "app.asar"))) throw new Error("Target release/win-unpacked/Repo Radar.exe for MCP. The portable self-extractor does not preserve stdio.");

// Owned disposable app-data directory; the legacy marker is fake opaque data.
const directory = await mkdtemp(path.join(os.tmpdir(), "repo-radar-mcp-smoke-"));
assert.equal(path.dirname(directory), os.tmpdir());
assert.ok(path.basename(directory).startsWith("repo-radar-mcp-smoke-"));
const legacyFile = path.join(directory, "databases", "database-profiles.enc");
const legacyBytes = Buffer.from("opaque fake desktop vault; MCP must leave this untouched");
await mkdir(path.dirname(legacyFile));
await writeFile(legacyFile, legacyBytes);
const client = new Client({ name: "repo-radar-fixture", version: "1.0.0" });
const transport = new StdioClientTransport({ command: packagedExecutable ?? electron, args: packagedExecutable ? ["--database-mcp"] : [".", "--database-mcp"], cwd: process.cwd(), env: { ...Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !["ELECTRON_RUN_AS_NODE", "NODE_OPTIONS"].includes(key.toUpperCase()))), REPO_RADAR_USER_DATA: directory }, stderr: "pipe" });
let errorOutput = "";
transport.stderr?.on("data", chunk => { errorOutput = (errorOutput + chunk.toString()).slice(-8000); });
let timer;
try {
  await Promise.race([client.connect(transport), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Dedicated MCP process did not initialize within 15 seconds.")), 15000); })]);
  clearTimeout(timer);
  const listed = await client.listTools();
  assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["get_dev_schema", "get_submission_status", "list_dev_databases", "query_dev_data", "submit_migration"].sort());
  const denied = await client.callTool({ name: "list_dev_databases", arguments: {} });
  assert.equal(denied.isError, true);
  assert.equal(JSON.stringify(denied).includes("password"), false);
  assert.deepEqual(await readFile(legacyFile), legacyBytes);
  assert.equal(existsSync(path.join(directory, "repo-radar-databases")), false);
  console.log("Dedicated Electron MCP smoke passed: five restricted tools, missing enrollment fails closed, legacy desktop vault untouched; no database connection attempted.");
} catch (error) {
  if (errorOutput) console.error(errorOutput);
  throw error;
} finally {
  clearTimeout(timer);
  await client.close();
  await rm(directory, { recursive: true, force: true });
}
