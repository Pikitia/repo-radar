import type { AppSettings } from "../src/types/settings.js";
import { tryGit } from "./git/exec.js";

const MAX_DIFF_CHARS = 14000;
const SECRET_PATTERNS = [
  /(api[_-]?key\s*[:=]\s*)[^\s'"]+/gi,
  /(token\s*[:=]\s*)[^\s'"]+/gi,
  /(password\s*[:=]\s*)[^\s'"]+/gi
];

export type CommitMessageInput = {
  repoPath: string;
  files: string[];
};

export interface CommitMessageProvider {
  isAvailable(): Promise<boolean>;
  generate(input: CommitMessageInput): Promise<string>;
}

function redact(text: string): string {
  return SECRET_PATTERNS.reduce((current, pattern) => current.replace(pattern, "$1[redacted]"), text);
}

export async function buildCommitPrompt(repoPath: string, files: string[]): Promise<string> {
  const stat = await tryGit(repoPath, ["diff", "--staged", "--stat", "--", ...files]);
  const diff = await tryGit(repoPath, ["diff", "--staged", "--", ...files]);
  const redactedDiff = redact(diff.stdout);
  const truncated = redactedDiff.length > MAX_DIFF_CHARS ? `${redactedDiff.slice(0, MAX_DIFF_CHARS)}\n\n[Diff truncated]` : redactedDiff;
  return [
    "Write an editable Git commit message for the staged changes.",
    "Use an imperative short summary, then an optional concise body when useful.",
    "Do not use markdown fences.",
    "",
    "Files:",
    files.map((file) => `- ${file}`).join("\n"),
    "",
    "Stats:",
    stat.stdout.trim(),
    "",
    "Diff content may be truncated and obvious secrets have been redacted.",
    "",
    "Diff:",
    truncated
  ].join("\n");
}

export class NoCommitMessageProvider implements CommitMessageProvider {
  async isAvailable(): Promise<boolean> {
    return false;
  }

  async generate(): Promise<string> {
    throw new Error("AI commit message generation is unavailable. Configure an OpenAI-compatible provider in Settings or environment.");
  }
}

export class OpenAiCompatibleCommitProvider implements CommitMessageProvider {
  constructor(private readonly settings: AppSettings) {}

  private getApiKey(): string | undefined {
    if (this.settings.ai.apiKeySource === "settings") return this.settings.ai.apiKey;
    return process.env.REPO_RADAR_OPENAI_API_KEY || process.env.OPENAI_API_KEY;
  }

  async isAvailable(): Promise<boolean> {
    return this.settings.ai.provider === "openai-compatible" && Boolean(this.getApiKey());
  }

  async generate(input: CommitMessageInput): Promise<string> {
    const apiKey = this.getApiKey();
    if (!apiKey) throw new Error("AI provider is not configured.");
    const prompt = await buildCommitPrompt(input.repoPath, input.files);
    const response = await fetch(`${this.settings.ai.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: this.settings.ai.model,
        messages: [
          { role: "system", content: "You write concise, accurate Git commit messages." },
          { role: "user", content: prompt }
        ],
        temperature: 0.2
      })
    });
    if (!response.ok) {
      throw new Error(`AI provider returned ${response.status}: ${await response.text()}`);
    }
    const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
    return body.choices?.[0]?.message?.content?.trim() || "";
  }
}

export function createCommitProvider(settings: AppSettings): CommitMessageProvider {
  if (settings.ai.provider === "openai-compatible") return new OpenAiCompatibleCommitProvider(settings);
  return new NoCommitMessageProvider();
}
