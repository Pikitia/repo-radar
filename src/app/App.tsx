import { useEffect, useMemo, useState } from "react";
import type { AppSettings } from "../types/settings";
import { defaultSettings } from "../types/settings";
import type { RepoFilter, RepoStatus } from "../types/repo";
import { RepoSidebar } from "../components/RepoSidebar";
import { RepoDetail } from "../components/RepoDetail";
import { SettingsDialog } from "../components/SettingsDialog";

export function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filter, setFilter] = useState<RepoFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  const selected = useMemo(() => repos.find((repo) => repo.id === selectedId) ?? null, [repos, selectedId]);

  async function refresh(fetch = true) {
    if (!settings.rootFolder) {
      setSettingsOpen(true);
      return;
    }
    setLoading(true);
    setMessage(fetch ? "Refreshing repositories..." : "Scanning repositories...");
    try {
      const next = await window.repoRadar.scanRepositories({
        root: settings.rootFolder,
        includeNestedRepositories: settings.includeNestedRepositories,
        fetch
      });
      setRepos(next);
      setSelectedId((current) => current && next.some((repo) => repo.id === current) ? current : next[0]?.id ?? null);
      setMessage(`${next.length} repositories loaded.`);
    } catch (err) {
      setMessage(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void window.repoRadar.getSettings().then((loaded) => {
      setSettings(loaded);
      if (!loaded.rootFolder) setSettingsOpen(true);
    });
  }, []);

  useEffect(() => {
    if (settings.rootFolder) void refresh(false);
  }, [settings.rootFolder, settings.includeNestedRepositories]);

  useEffect(() => {
    if (!settings.rootFolder || settings.refreshIntervalMinutes <= 0 || loading) return;
    const timer = window.setInterval(() => {
      void refresh(true);
    }, settings.refreshIntervalMinutes * 60 * 1000);
    return () => window.clearInterval(timer);
  }, [settings.rootFolder, settings.includeNestedRepositories, settings.refreshIntervalMinutes, loading]);

  function updateRepo(updated: RepoStatus) {
    setRepos((current) => current.map((repo) => repo.id === updated.id ? updated : repo));
  }

  return (
    <div className="app-shell">
      <RepoSidebar
        rootFolder={settings.rootFolder}
        repos={repos}
        selectedId={selectedId}
        filter={filter}
        loading={loading}
        onFilterChange={setFilter}
        onSelect={(repo) => setSelectedId(repo.id)}
        onRefresh={() => refresh(true)}
        onSettings={() => setSettingsOpen(true)}
      />
      <RepoDetail repo={selected} onRepoUpdated={updateRepo} onMessage={setMessage} />
      <footer className="toast" aria-live="polite">{message}</footer>
      <SettingsDialog
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        onSaved={(next) => {
          setSettings(next);
          setMessage("Settings saved.");
        }}
      />
    </div>
  );
}
