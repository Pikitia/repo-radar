import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

const packagedExecutable = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
if (packagedExecutable && !existsSync(path.join(path.dirname(packagedExecutable), "resources", "app.asar"))) throw new Error("Target the packaged app in release/win-unpacked. The portable self-extractor does not preserve Playwright's debug streams.");

const userData = await mkdtemp(path.join(os.tmpdir(), "repo-radar-user-data-"));
const databaseDirectory = path.join(userData, "repo-radar-databases");
const profileFile = path.join(databaseDirectory, "database-profiles.enc");
const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), "repo-radar-smoke-ci-"));
const fixtureRepo = path.join(fixtureRoot, "storefront");
await mkdir(fixtureRepo);
function git(args) {
  return execFileSync("git", args, { cwd: fixtureRepo, shell: false, windowsHide: true, encoding: "utf8", timeout: 10000 }).trim();
}
function assertFixturePath(target) {
  if (path.dirname(target) !== os.tmpdir() || !path.basename(target).startsWith("repo-radar-")) throw new Error("Unexpected smoke fixture cleanup path.");
}
git(["init", "-b", "feature/local"]);
git(["config", "user.email", "smoke@example.com"]);
git(["config", "user.name", "Smoke Test"]);
await writeFile(path.join(fixtureRepo, "README.md"), "# Smoke fixture\n");
git(["add", "README.md"]);
git(["commit", "-m", "Initial fixture"]);
git(["remote", "add", "origin", "https://github.com/example/storefront.git"]);
const launch = () => electron.launch({
  ...(packagedExecutable ? { executablePath: packagedExecutable } : {}),
  args: packagedExecutable ? [] : ["."],
  timeout: 30000,
  env: {
    ...process.env,
    REPO_RADAR_USER_DATA: userData
  }
});
let app = await launch();
async function readFixtureDatabaseState(application) {
  assert.equal(await application.evaluate(({ app }) => app.getPath("userData")), userData);
  const fixtureWindow = await application.firstWindow();
  await fixtureWindow.waitForLoadState("domcontentloaded");
  return fixtureWindow.evaluate(async () => {
    const overview = await window.repoRadar.databases.overview();
    return { overview, server: overview.servers[0] ? await window.repoRadar.databases.getServerConnection(overview.servers[0].id) : null };
  });
}

try {
  assert.equal(await app.evaluate(({ app }) => app.getPath("userData")), userData, "Smoke must never use the operator's application-data directory");
  const window = await app.firstWindow();
  window.setDefaultTimeout(10000);
  window.on("console", (message) => console.log(`console:${message.type()}:${message.text()}`));
  window.on("pageerror", (error) => console.error(`pageerror:${error.message}`));
  await window.waitForLoadState("domcontentloaded");
  try {
    await window.getByRole("heading", { name: "Settings" }).waitFor({ timeout: 10000 });
    await window.getByText("Default root folder").waitFor({ timeout: 10000 });
  } catch (error) {
    console.error(`url:${window.url()}`);
    console.error(`title:${await window.title()}`);
    console.error(`root:${await window.locator("#root").evaluate((node) => node.innerHTML).catch(() => "<no root>")}`);
    console.error(await window.locator("body").innerText({ timeout: 1000 }).catch(() => "<no body text>"));
    throw error;
  }
  console.log("Electron smoke passed: first-run settings dialog rendered.");
  const initialMcp = await window.evaluate(() => window.repoRadar.getDatabaseMcpStatus());
  assert.equal(initialMcp.enabled, true);
  assert.equal(initialMcp.running, true, initialMcp.error);
  assert.equal(initialMcp.url, "http://127.0.0.1:47321/mcp");
  assert.equal(Object.hasOwn(initialMcp, "token"), false);
  assert.equal((await fetch(initialMcp.url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status, 401);

  // Provider responses stay deterministic and never contact real repositories.
  await app.evaluate(() => {
    const started = new Date(Date.now() - 90000).toISOString();
    const updated = new Date().toISOString();
    globalThis.fetch = async (input) => {
      const url = String(input);
      const response = url.includes("/jobs?")
        ? { jobs: [{ id: 11, name: "Deploy", status: "in_progress", conclusion: null, started_at: started, completed_at: null, html_url: "https://github.com/example/storefront/actions/runs/41", steps: [{ number: 1, name: "Upload production release", status: "in_progress", conclusion: null }] }] }
        : url.includes("/workflows?")
          ? { workflows: [{ id: 8, name: "Deploy production", path: ".github/workflows/deploy.yml", state: "active" }] }
          : { workflow_runs: [{ id: 41, run_attempt: 2, name: "Deploy production", display_title: "Release search", run_number: 18, head_branch: new globalThis.URL(url).searchParams.get("branch"), head_sha: "abcdef1234567890", status: "in_progress", conclusion: null, created_at: started, run_started_at: started, updated_at: updated, html_url: "https://github.com/example/storefront/actions/runs/41" }] };
      return new globalThis.Response(JSON.stringify(response), { status: 200, headers: { "content-type": "application/json" } });
    };
  });
  await window.evaluate(async (root) => {
    await window.repoRadar.updateSettings({ rootFolder: root, refreshIntervalMinutes: 0 });
  }, fixtureRoot);
  await window.reload();
  await window.getByRole("button", { name: "storefront", exact: false }).waitFor();
  await window.getByRole("button", { name: "Watch main", exact: true }).click();
  await window.getByRole("button", { name: "Watching main", exact: true }).waitFor();
  assert.equal(await window.getByRole("button", { name: "Watching main", exact: true }).isDisabled(), true);
  await window.screenshot({ path: "test-results/repository-watch-main.png" });
  await window.getByRole("tab", { name: "CI Watch", exact: true }).click();
  await window.getByRole("button", { name: "Watch branch", exact: true }).click();
  await window.getByRole("option", { name: /Deploy production/ }).waitFor({ state: "attached" });
  await window.getByLabel("Branch", { exact: true }).fill("production");
  await window.getByRole("combobox", { name: /^Workflow/ }).selectOption("8");
  await window.getByRole("button", { name: "Add watch", exact: true }).click();
  const overview = window.getByRole("tabpanel", { name: "CI Watch", exact: true });
  await overview.getByRole("button", { name: "Expand storefront production Deploy production", exact: true }).locator("..").locator("..").getByText("Running", { exact: true }).waitFor();
  assert.equal(await overview.locator(".ci-summary-row").count(), 2);
  for (const column of ["Repository", "Branch", "Workflow", "Status", "Commit", "Timing", "When run"]) {
    const sort = overview.getByRole("button", { name: `Sort by ${column}`, exact: true });
    await sort.click();
    assert.equal(await sort.locator("..").getAttribute("aria-sort"), "ascending");
    await sort.click();
    assert.equal(await sort.locator("..").getAttribute("aria-sort"), "descending");
  }
  await overview.getByRole("button", { name: "Sort by Branch", exact: true }).click();
  assert.equal(await overview.locator(".ci-summary-row").first().locator("td").nth(2).innerText(), "main");
  await overview.getByRole("button", { name: "Sort by Branch", exact: true }).click();
  assert.equal(await overview.locator(".ci-summary-row").first().locator("td").nth(2).innerText(), "production");
  assert.equal(await overview.locator(".ci-summary-row").first().locator("td").count(), 9);
  assert.match(await overview.locator(".ci-summary-row").first().locator("td").nth(6).innerText(), /^\d+m \d+s$/);
  assert.ok((await overview.locator(".ci-summary-row").first().locator("td").nth(7).innerText()).length > 0);
  assert.ok(await overview.locator(".ci-summary-row").evaluateAll((rows) => rows.every((row) => row.getBoundingClientRect().height <= 44)));
  await overview.getByRole("button", { name: "Expand storefront production Deploy production", exact: true }).click();
  await overview.getByText("1. Upload production release", { exact: true }).waitFor();
  await overview.getByText(/^Status last refreshed/).waitFor();
  await window.screenshot({ path: "test-results/ci-watch.png" });
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(980, 700));
  await window.screenshot({ path: "test-results/ci-watch-compact.png" });
  assert.ok(await overview.locator(".ci-summary-row").evaluateAll((rows) => rows.every((row) => row.getBoundingClientRect().height <= 44)));
  await overview.getByRole("button", { name: "storefront", exact: true }).first().click();
  await window.getByRole("tabpanel", { name: "Repositories", exact: true }).getByRole("heading", { name: "storefront", exact: true }).waitFor();
  await window.getByRole("tab", { name: "CI Watch", exact: true }).click();
  await overview.getByRole("button", { name: "Collapse storefront production Deploy production", exact: true }).waitFor();
  assert.equal(git(["branch", "--show-current"]), "feature/local");
  assert.equal(git(["status", "--porcelain"]), "");
  await window.reload();
  await window.getByRole("tab", { name: "CI Watch", exact: true }).click();
  await overview.getByText("production", { exact: true }).waitFor();
  const persisted = await window.evaluate(async () => (await window.repoRadar.getSettings()).ciWatches);
  assert.equal(persisted.length, 2);
  assert.equal(persisted.find((watch) => watch.branch === "production").workflowId, 8);
  assert.equal(persisted.find((watch) => watch.branch === "main").workflowId, undefined);
  const rejection = await window.evaluate(async (outside) => {
    try { await window.repoRadar.getCiRun(outside, "main"); return "accepted"; }
    catch (error) { return error.message; }
  }, userData);
  assert.match(rejection, /outside the selected root/);
  const pullRequestRejections = await window.evaluate(async (outside) => {
    const errors = [];
    for (const operation of [
      () => window.repoRadar.getDevelopPullRequestPreview(outside),
      () => window.repoRadar.promoteDevelop(outside, { repository: "example/storefront", developSha: "a".repeat(40), mainSha: "b".repeat(40), ahead: 1 })
    ]) {
      try { await operation(); errors.push("accepted"); }
      catch (error) { errors.push(error.message); }
    }
    return errors;
  }, userData);
  for (const error of pullRequestRejections) assert.match(error, /outside the selected root/);
  console.log("Electron smoke passed: typed pull request channels enforce selected-root validation.");
  await overview.getByRole("button", { name: "Remove watch for storefront production Deploy production", exact: true }).click();
  await overview.getByRole("button", { name: "Remove watch for storefront main latest run", exact: true }).click();
  await overview.getByText("No watched branches yet", { exact: true }).waitFor();
  await window.getByRole("tab", { name: "Databases", exact: true }).click();
  const databases = window.getByRole("tabpanel", { name: "Databases", exact: true });
  await databases.getByRole("heading", { name: "Databases", exact: true }).waitFor();
  const databaseState = await window.evaluate(async () => ({ overview: await window.repoRadar.databases.overview(), methods: Object.keys(window.repoRadar.databases) }));
  assert.deepEqual(databaseState.overview.profiles, []);
  assert.deepEqual(databaseState.overview.proposals, []);
  assert.equal(databaseState.methods.includes("query"), false);
  assert.equal(databaseState.methods.includes("getCredentials"), false);
  await window.screenshot({ path: "test-results/databases-overview.png" });
  // Real Windows protected storage, with fake values and no connection attempt.
  const protectedFixture = await window.evaluate(async () => {
    const server = await window.repoRadar.databases.saveServerConnection({ label: "Disposable server", host: "smoke-profile.invalid", port: 33399, tlsMode: "disabled" });
    await window.repoRadar.databases.saveProfile({ databaseKey: "smoke", label: "Disposable smoke profile", environment: "dev", serverConnectionId: server.id, database: "smoke_fixture" });
    await window.repoRadar.databases.saveServerCredentials(server.id, "inspection", { username: "smoke-fixture-reader", password: "smoke-fixture-password-not-a-real-secret" });
    const details = await window.repoRadar.databases.getServerConnection(server.id);
    await window.repoRadar.databases.saveServerCredentials(server.id, "inspection", { username: "smoke-fixture-reader" });
    return { overview: await window.repoRadar.databases.overview(), details, settings: await window.repoRadar.getSettings() };
  });
  assert.equal(protectedFixture.overview.profiles[0].hasInspectionCredentials, true);
  assert.equal(protectedFixture.overview.profiles[0].identity, undefined);
  assert.equal(protectedFixture.details.host, "smoke-profile.invalid");
  assert.equal(protectedFixture.details.tlsMode, "disabled");
  assert.equal(protectedFixture.details.credentialUsernames.inspection, "smoke-fixture-reader");
  assert.doesNotMatch(JSON.stringify(protectedFixture), /smoke-fixture-password-not-a-real-secret/);
  const protectedBytes = await readFile(profileFile);
  assert.doesNotMatch(protectedBytes.toString(), /smoke-profile\.invalid|smoke-fixture-reader|smoke-fixture-password-not-a-real-secret/);
  await databases.getByRole("button", { name: "Refresh databases", exact: true }).click();
  await databases.getByRole("button", { name: "Configure databases", exact: true }).click();
  const settingsDialog = window.getByRole("dialog", { name: "Settings", exact: true });
  await settingsDialog.getByRole("tab", { name: "Databases", exact: true }).waitFor();
  const databaseSettings = settingsDialog.getByRole("region", { name: "Database settings", exact: true });
  await databaseSettings.getByRole("heading", { name: "Server connections", exact: true }).waitFor();
  await window.waitForFunction(() => [...document.querySelectorAll("input")].some(input => input.value === "smoke-profile.invalid"));
  assert.equal(await databaseSettings.getByLabel("Host", { exact: true }).inputValue(), "smoke-profile.invalid");
  assert.equal(await databaseSettings.getByLabel("Port", { exact: true }).inputValue(), "33399");
  assert.equal(await databaseSettings.getByRole("combobox", { name: "TLS", exact: true }).inputValue(), "disabled");
  assert.equal(await databaseSettings.getByLabel("Username", { exact: true }).inputValue(), "smoke-fixture-reader");
  assert.equal(await databaseSettings.getByLabel("Password", { exact: true }).inputValue(), "");
  assert.equal(await databaseSettings.getByLabel("Database name", { exact: true }).inputValue(), "smoke_fixture");
  await databaseSettings.getByRole("checkbox", { name: "Start the development MCP server automatically", exact: true }).waitFor();
  await window.screenshot({ path: "test-results/databases-connections.png" });
  await settingsDialog.getByRole("button", { name: "Close", exact: true }).click();
  // Comparison presentation uses deterministic IPC fixtures, never a live database.
  await app.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler("db:compare");
    ipcMain.handle("db:compare", (_event, key) => ({
      assessment: "unverified", capturedAt: "2026-10-19T00:00:00.000Z", devSchemaDigest: "fixture-dev", productionSchemaDigest: "fixture-prod",
      engines: { development: { engine: "mysql", version: "8.0.42" }, production: { engine: "mariadb", version: "10.6.25-MariaDB-log" } },
      tableStorageEngines: [{ tableName: `${key}_items`, development: "InnoDB", production: "InnoDB" }],
      differences: [
        { objectType: "column", objectPath: `${key}_items.quantity`, devDefinition: JSON.stringify({ TABLE_NAME: `${key}_items`, COLUMN_NAME: "quantity", COLUMN_TYPE: "bigint" }), productionDefinition: JSON.stringify({ TABLE_NAME: `${key}_items`, COLUMN_NAME: "quantity", COLUMN_TYPE: "int" }), assessment: "unverified", migrationIds: [], reason: "Fixture migration has not been replayed" },
        { objectType: "column", objectPath: `${key}_items.note`, devDefinition: JSON.stringify({ TABLE_NAME: `${key}_items`, COLUMN_NAME: "note", COLUMN_TYPE: "text" }), productionDefinition: null, assessment: "unverified", migrationIds: [], reason: "Fixture added column has not been replayed" },
        { objectType: "column", objectPath: `${key}_items.legacy_count`, devDefinition: JSON.stringify({ TABLE_NAME: `${key}_items`, COLUMN_NAME: "legacy_count", ORDINAL_POSITION: "3", COLUMN_DEFAULT: null, IS_NULLABLE: "YES", COLUMN_TYPE: "int", CHARACTER_SET_NAME: null, COLLATION_NAME: null, EXTRA: "", GENERATION_EXPRESSION: null, COLUMN_COMMENT: "" }), productionDefinition: JSON.stringify({ TABLE_NAME: `${key}_items`, COLUMN_NAME: "legacy_count", ORDINAL_POSITION: "3", COLUMN_DEFAULT: "NULL", IS_NULLABLE: "YES", COLUMN_TYPE: "int(11)", CHARACTER_SET_NAME: null, COLLATION_NAME: null, EXTRA: "", GENERATION_EXPRESSION: null, COLUMN_COMMENT: "" }), assessment: "unverified", migrationIds: [], reason: "Fixture combined NULL and display width representations" },
        { objectType: "column", objectPath: `${key}_items.updated`, devDefinition: JSON.stringify({ TABLE_NAME: `${key}_items`, COLUMN_NAME: "updated", ORDINAL_POSITION: "4", COLUMN_DEFAULT: null, IS_NULLABLE: "YES", COLUMN_TYPE: "timestamp", CHARACTER_SET_NAME: null, COLLATION_NAME: null, EXTRA: "on update CURRENT_TIMESTAMP", GENERATION_EXPRESSION: null, COLUMN_COMMENT: "" }), productionDefinition: JSON.stringify({ TABLE_NAME: `${key}_items`, COLUMN_NAME: "updated", ORDINAL_POSITION: "4", COLUMN_DEFAULT: "NULL", IS_NULLABLE: "YES", COLUMN_TYPE: "timestamp", CHARACTER_SET_NAME: null, COLLATION_NAME: null, EXTRA: "on update current_timestamp()", GENERATION_EXPRESSION: null, COLUMN_COMMENT: "" }), assessment: "unverified", migrationIds: [], reason: "Fixture nullable temporal representations" },
        { objectType: "foreign-key", objectPath: `${key}_items.fk_owner.1`, devDefinition: JSON.stringify({ TABLE_NAME: `${key}_items`, CONSTRAINT_NAME: "fk_owner", COLUMN_NAME: "owner_id", ORDINAL_POSITION: "1", REFERENCED_TABLE_NAME: "owners", REFERENCED_COLUMN_NAME: "id", UPDATE_RULE: "NO ACTION", DELETE_RULE: "RESTRICT" }), productionDefinition: JSON.stringify({ TABLE_NAME: `${key}_items`, CONSTRAINT_NAME: "fk_owner", COLUMN_NAME: "owner_id", ORDINAL_POSITION: "1", REFERENCED_TABLE_NAME: "owners", REFERENCED_COLUMN_NAME: "id", UPDATE_RULE: "RESTRICT", DELETE_RULE: "RESTRICT" }), assessment: "unverified", migrationIds: [], reason: "Fixture InnoDB foreign-key action representations" },
        { objectType: "table", objectPath: `${key}_formatting/definition`, devDefinition: `CREATE TABLE \`${key}_formatting\` (\`id\` int DEFAULT NULL, CHECK (\`id\` > 1)) ENGINE=InnoDB`, productionDefinition: `CREATE TABLE \`${key}_formatting\` (\`id\` int(11) DEFAULT NULL, CHECK (\`id\` > 0)) ENGINE=InnoDB`, assessment: "unverified", migrationIds: [], reason: "Fixture table SQL omitted from Review by display preference" }
      ],
      coverage: { complete: false, limitations: ["Fixture routine visibility incomplete"] }
    }));
  });
  await window.evaluate(async () => {
    const server = (await window.repoRadar.databases.overview()).servers[0];
    for (const [databaseKey, environment, database] of [["smoke", "production", "smoke_production"], ["orders", "dev", "orders_development"], ["orders", "production", "orders_production"]]) {
      await window.repoRadar.databases.saveProfile({ databaseKey, environment, database, label: `Disposable ${database}`, serverConnectionId: server.id });
    }
  });
  await databases.getByRole("button", { name: "Refresh databases", exact: true }).click();
  await databases.getByRole("button", { name: "Schema differences", exact: true }).click();
  await databases.getByLabel("Schema differences for orders", { exact: true }).waitFor();
  await databases.getByRole("button", { name: "Compare all databases", exact: true }).click();
  const warnings = databases.getByRole("button", { name: "Coverage warnings (2)", exact: true });
  await warnings.waitFor();
  const showAll = databases.getByRole("button", { name: "Show all differences (8 hidden)", exact: true });
  await showAll.waitFor();
  assert.equal(await showAll.evaluate(element => element.closest(".database-schema-group") === null), true);
  assert.equal(await databases.locator(".database-schema-assessment").count(), 0);
  assert.equal(await warnings.getAttribute("aria-expanded"), "false");
  for (const key of ["orders", "smoke"]) {
    const group = databases.getByLabel(`Schema differences for ${key}`, { exact: true });
    assert.equal(await group.getAttribute("open"), null);
    assert.match(await group.locator(":scope > summary").innerText(), /2 differences/);
  }
  await databases.locator(".database-schema-results").screenshot({ path: "test-results/databases-schema-groups.png" });
  const group = databases.getByLabel("Schema differences for orders", { exact: true });
  await group.locator(":scope > summary").click();
  assert.doesNotMatch(await group.innerText(), /unverified|Captured |History objects excluded|Development: MySQL|Coverage:/);
  assert.equal(await group.getByRole("button", { name: /Show all differences/ }).count(), 0);
  assert.equal(await group.getByLabel("Table differences for orders_formatting in orders", { exact: true }).count(), 0);
  const tableGroup = group.getByLabel("Table differences for orders_items in orders", { exact: true });
  assert.equal(await tableGroup.getAttribute("open"), null);
  await tableGroup.locator(":scope > summary").click();
  assert.equal(await tableGroup.locator(".database-schema-difference").count(), 2);
  const changeList = tableGroup.getByRole("table", { name: "Changes for Table orders_items in orders", exact: true });
  assert.equal(await changeList.getByRole("row").count(), 3);
  await changeList.getByRole("rowheader", { name: "quantity", exact: true }).waitFor();
  await changeList.getByRole("rowheader", { name: "note", exact: true }).waitFor();
  assert.match(await tableGroup.locator(".database-schema-difference > summary").first().innerText(), /Present in development/);
  assert.equal(await tableGroup.locator(".database-schema-difference pre").first().isVisible(), false);
  await showAll.click();
  assert.equal(await changeList.getByRole("row").count(), 6);
  await changeList.getByRole("rowheader", { name: "legacy_count", exact: true }).waitFor();
  await changeList.getByRole("rowheader", { name: "updated", exact: true }).waitFor();
  await changeList.getByRole("rowheader", { name: "foreign-key fk_owner", exact: true }).waitFor();
  const formatting = group.getByLabel("Table differences for orders_formatting in orders", { exact: true });
  assert.equal(await formatting.getAttribute("open"), null);
  await formatting.locator(":scope > summary").click();
  await formatting.locator(".database-schema-difference > summary").click();
  await formatting.locator("pre").filter({ hasText: "CHECK (`id` > 1)" }).waitFor();
  await formatting.locator("pre").filter({ hasText: "CHECK (`id` > 0)" }).waitFor();
  assert.equal(await formatting.getByText(/Representation difference:/).count(), 0);
  assert.equal(await databases.getByLabel("Table differences for smoke_formatting in smoke", { exact: true }).count(), 1);
  await databases.getByRole("button", { name: "Hide noise", exact: true }).click();
  assert.equal(await changeList.getByRole("row").count(), 3);
  assert.equal(await changeList.getByRole("rowheader", { name: "legacy_count", exact: true }).count(), 0);
  assert.equal(await formatting.count(), 0);
  assert.equal(await databases.getByLabel("Table differences for smoke_formatting in smoke", { exact: true }).count(), 0);
  await databases.locator(".database-schema-results").screenshot({ path: "test-results/databases-table-change-list.png" });
  await changeList.getByRole("rowheader", { name: "quantity", exact: true }).locator("..").locator(".database-schema-difference > summary").click();
  await tableGroup.locator(".database-schema-difference pre").filter({ hasText: '"COLUMN_TYPE":"bigint"' }).waitFor();
  await group.screenshot({ path: "test-results/databases-table-groups.png" });
  await warnings.click();
  await databases.getByRole("region", { name: "orders coverage warnings", exact: true }).waitFor();
  await warnings.click();
  assert.equal(await warnings.getAttribute("aria-expanded"), "false");
  await window.getByRole("tab", { name: "Repositories", exact: true }).click();
  console.log("Electron smoke passed: Databases tab, typed API and real Windows protected fixture storage; no database connection attempted or real credentials used.");
  console.log("Electron smoke passed: CI navigation, quick main watch, compact timing/date columns, sorting, persistence, inline jobs, root validation, and unchanged checkout.");
  // Restart against the same owned profile: saved DB settings must survive a full
  // process exit, not just renderer refreshes or an in-memory service instance.
  await window.evaluate(() => window.repoRadar.updateSettings({ rootFolder: null, refreshIntervalMinutes: 0, databaseMcpEnabled: false }));
  assert.deepEqual(await window.evaluate(() => window.repoRadar.getDatabaseMcpStatus()), { enabled: false, running: false });
  const persistedMcpToken = await readFile(path.join(databaseDirectory, "mcp-auth.enc"));
  const persistedProfiles = await readFile(profileFile);
  await app.close();
  assert.deepEqual(await readFile(profileFile), persistedProfiles, "Profile bytes must remain after process exit");
  app = await launch();
  const restored = await readFixtureDatabaseState(app);
  const restartedWindow = await app.firstWindow();
  assert.deepEqual(await restartedWindow.evaluate(() => window.repoRadar.getDatabaseMcpStatus()), { enabled: false, running: false });
  await restartedWindow.evaluate(() => window.repoRadar.updateSettings({ databaseMcpEnabled: true }));
  assert.equal((await restartedWindow.evaluate(() => window.repoRadar.getDatabaseMcpStatus())).running, true);
  assert.deepEqual(await readFile(path.join(databaseDirectory, "mcp-auth.enc")), persistedMcpToken);
  assert.equal(restored.overview.servers.length, 1);
  assert.equal(restored.overview.profiles.length, 4);
  assert.equal(restored.server.credentialUsernames.inspection, "smoke-fixture-reader");
  assert.equal(restored.server.hasInspectionCredentials, true);
  assert.deepEqual(await readFile(profileFile), persistedProfiles);
  console.log("Electron smoke passed: protected server, credentials and four database targets survive a full app restart unchanged; no database connection attempted.");
  // Simulate a surviving old installation before startup. Migration must happen
  // before the first BrowserWindow lets Chromium erase its reserved old folder.
  await app.close();
  const legacyDirectory = path.join(userData, "databases");
  assertFixturePath(userData);
  assert.equal(path.dirname(path.resolve(databaseDirectory)), path.resolve(userData));
  assert.equal(path.dirname(path.resolve(legacyDirectory)), path.resolve(userData));
  assert.equal(existsSync(legacyDirectory), false);
  await rename(databaseDirectory, legacyDirectory);
  app = await launch();
  const migrated = await readFixtureDatabaseState(app);
  assert.equal(migrated.overview.profiles.length, 4);
  assert.equal(migrated.server.credentialUsernames.inspection, "smoke-fixture-reader");
  assert.deepEqual(await readFile(profileFile), persistedProfiles);
  assert.equal(existsSync(legacyDirectory), false);
  console.log("Electron smoke passed: legacy encrypted settings preserved before Chromium startup cleanup.");
  assert.equal((await (await app.firstWindow()).evaluate(() => window.repoRadar.getDatabaseMcpStatus())).running, true);
  console.log("Electron smoke passed: default-on authenticated local MCP, immediate off/on, persisted off across restart and stable encrypted token.");
} finally {
  await app.close().catch(() => undefined);
  for (const target of [userData, fixtureRoot]) {
    assertFixturePath(target);
    await rm(target, { recursive: true, force: true });
  }
}
