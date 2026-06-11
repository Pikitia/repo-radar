import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildCommitPrompt } from "../../electron/aiCommit";
import { runGit } from "../../electron/git/exec";

describe("AI commit prompt", () => {
  it("redacts and truncates diff content", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "repo-radar-ai-"));
    await runGit(dir, ["init"]);
    await runGit(dir, ["config", "user.email", "test@example.com"]);
    await runGit(dir, ["config", "user.name", "Test User"]);
    await writeFile(path.join(dir, "secret.txt"), `api_key=abc123\n${"x".repeat(20000)}`);
    await runGit(dir, ["add", "secret.txt"]);

    const prompt = await buildCommitPrompt(dir, ["secret.txt"]);
    expect(prompt).toContain("api_key=[redacted]");
    expect(prompt).toContain("[Diff truncated]");
    expect(prompt.length).toBeLessThan(16000);
  });
});
