import type { CiWatch } from "./ci.js";

export type PullStrategy = "git-config" | "merge" | "rebase";
export type AiProviderType = "none" | "openai-compatible";
export type AiKeySource = "environment" | "settings";
export type GitHubTokenSource = "environment" | "settings";

export type AppSettings = {
  databaseMcpEnabled: boolean;
  rootFolder: string | null;
  includeNestedRepositories: boolean;
  pullStrategy: PullStrategy;
  refreshIntervalMinutes: number;
  ciWatches: CiWatch[];
  github: {
    tokenSource: GitHubTokenSource;
    token?: string;
  };
  ai: {
    provider: AiProviderType;
    baseUrl: string;
    model: string;
    apiKeySource: AiKeySource;
    apiKey?: string;
  };
};

export const defaultSettings: AppSettings = {
  databaseMcpEnabled: true,
  rootFolder: null,
  includeNestedRepositories: false,
  pullStrategy: "git-config",
  refreshIntervalMinutes: 5,
  ciWatches: [],
  github: {
    tokenSource: "environment"
  },
  ai: {
    provider: "none",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeySource: "environment"
  }
};

export interface DatabaseMcpStatus {
  enabled: boolean;
  running: boolean;
  url?: string;
  error?: string;
}
