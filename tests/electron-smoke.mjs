import { _electron as electron } from "playwright";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const userData = await mkdtemp(path.join(os.tmpdir(), "repo-radar-user-data-"));
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
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    REPO_RADAR_USER_DATA: userData
  }
});

try {
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
  console.log("Electron smoke passed: CI navigation, quick main watch, compact timing/date columns, sorting, persistence, inline jobs, root validation, and unchanged checkout.");
} finally {
  await app.close();
  for (const target of [userData, fixtureRoot]) {
    assertFixturePath(target);
    await rm(target, { recursive: true, force: true });
  }
}
