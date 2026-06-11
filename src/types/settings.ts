export type PullStrategy = "git-config" | "merge" | "rebase";
export type AiProviderType = "none" | "openai-compatible";
export type AiKeySource = "environment" | "settings";

export type AppSettings = {
  rootFolder: string | null;
  includeNestedRepositories: boolean;
  pullStrategy: PullStrategy;
  ai: {
    provider: AiProviderType;
    baseUrl: string;
    model: string;
    apiKeySource: AiKeySource;
    apiKey?: string;
  };
};

export const defaultSettings: AppSettings = {
  rootFolder: null,
  includeNestedRepositories: false,
  pullStrategy: "git-config",
  ai: {
    provider: "none",
    baseUrl: "https://api.openai.com/v1",
    model: "gpt-4o-mini",
    apiKeySource: "environment"
  }
};
