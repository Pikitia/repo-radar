import { useEffect, useState } from "react";
import type { AppSettings } from "../types/settings";

type Props = {
  open: boolean;
  onClose(): void;
  onSaved(settings: AppSettings): void;
};

export function SettingsDialog({ open, onClose, onSaved }: Props) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [debug, setDebug] = useState<{ gitPath: string; version: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    void window.repoRadar.getSettings().then(setSettings);
    void window.repoRadar.getDebugInfo().then(setDebug).catch(() => setDebug(null));
  }, [open]);

  if (!open) return null;

  async function chooseRoot() {
    const folder = await window.repoRadar.chooseRootFolder();
    if (folder) setSettings((current) => current ? { ...current, rootFolder: folder } : current);
  }

  async function save() {
    if (!settings) return;
    setError(null);
    try {
      const saved = await window.repoRadar.updateSettings(settings);
      onSaved(saved);
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="modal settings-modal">
        <header>
          <h2>Settings</h2>
          <button onClick={onClose}>Close</button>
        </header>
        {!settings ? <div className="empty-panel">Loading settings...</div> : (
          <div className="settings-grid">
            {error && <div className="issue-box">{error}</div>}
            <label>
              Default root folder
              <div className="path-picker">
                <input readOnly value={settings.rootFolder ?? ""} placeholder="No folder selected" />
                <button onClick={chooseRoot}>Choose</button>
              </div>
            </label>
            <label className="inline-check">
              <input type="checkbox" checked={settings.includeNestedRepositories} onChange={(event) => setSettings({ ...settings, includeNestedRepositories: event.target.checked })} />
              Include nested repositories
            </label>
            <label>
              Pull strategy
              <select value={settings.pullStrategy} onChange={(event) => setSettings({ ...settings, pullStrategy: event.target.value as AppSettings["pullStrategy"] })}>
                <option value="git-config">Use Git config</option>
                <option value="merge">Merge</option>
                <option value="rebase">Rebase</option>
              </select>
            </label>
            <label>
              Refresh interval minutes
              <input
                type="number"
                min="0"
                max="120"
                step="1"
                value={settings.refreshIntervalMinutes}
                onChange={(event) => setSettings({ ...settings, refreshIntervalMinutes: Math.max(0, Number(event.target.value) || 0) })}
              />
            </label>
            <label>
              GitHub token source
              <select value={settings.github.tokenSource} onChange={(event) => setSettings({ ...settings, github: { ...settings.github, tokenSource: event.target.value as AppSettings["github"]["tokenSource"] } })}>
                <option value="environment">Environment variable</option>
                <option value="settings">Settings</option>
              </select>
            </label>
            {settings.github.tokenSource === "settings" && (
              <label>
                GitHub token
                <input type="password" value={settings.github.token ?? ""} onChange={(event) => setSettings({ ...settings, github: { ...settings.github, token: event.target.value } })} />
              </label>
            )}
            <div className="debug-box">
              <strong>GitHub Actions access</strong>
              <span>Private repositories need a GitHub token with repository access and Actions read permission.</span>
              <span>Environment mode reads GITHUB_TOKEN or GH_TOKEN when Repo Radar starts.</span>
            </div>
            <label>
              AI provider
              <select value={settings.ai.provider} onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, provider: event.target.value as AppSettings["ai"]["provider"] } })}>
                <option value="none">None</option>
                <option value="openai-compatible">OpenAI-compatible</option>
              </select>
            </label>
            <label>
              API key source
              <select value={settings.ai.apiKeySource} onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, apiKeySource: event.target.value as AppSettings["ai"]["apiKeySource"] } })}>
                <option value="environment">Environment variable</option>
                <option value="settings">Settings</option>
              </select>
            </label>
            <label>
              Base URL
              <input value={settings.ai.baseUrl} onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, baseUrl: event.target.value } })} />
            </label>
            <label>
              Model
              <input value={settings.ai.model} onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, model: event.target.value } })} />
            </label>
            {settings.ai.apiKeySource === "settings" && (
              <label>
                API key
                <input type="password" value={settings.ai.apiKey ?? ""} onChange={(event) => setSettings({ ...settings, ai: { ...settings.ai, apiKey: event.target.value } })} />
              </label>
            )}
            <div className="debug-box">
              <strong>Debug</strong>
              <span>{debug?.version ?? "Git version unavailable"}</span>
              <span>{debug?.gitPath ?? "Git path unavailable"}</span>
            </div>
            <button className="primary" onClick={save}>Save Settings</button>
          </div>
        )}
      </div>
    </div>
  );
}
