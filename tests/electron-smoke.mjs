import { _electron as electron } from "playwright";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const userData = await mkdtemp(path.join(os.tmpdir(), "repo-radar-user-data-"));
const app = await electron.launch({
  args: ["."],
  env: {
    ...process.env,
    REPO_RADAR_USER_DATA: userData
  }
});

try {
  const window = await app.firstWindow();
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
} finally {
  await app.close();
}
