import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { AppSettings } from "../types/settings";
import { defaultSettings } from "../types/settings";
import type { RepoFilter, RepoStatus } from "../types/repo";
import { RepoSidebar } from "../components/RepoSidebar";
import { RepoDetail } from "../components/RepoDetail";
import { SettingsDialog } from "../components/SettingsDialog";
import { CiWatch } from "../components/CiWatch.js";
import { Databases } from "../components/Databases.js";
import { ciPathKey } from "../state/ciLogic.js";

const sidebarDefaultWidth = 355;
const sidebarMinWidth = 260;
const detailMinWidth = 560;
const splitBarWidth = 6;

function clampSidebarWidth(width: number) {
  const viewportWidth = typeof window === "undefined" ? sidebarDefaultWidth + detailMinWidth + splitBarWidth : window.innerWidth;
  const maxWidth = Math.max(sidebarMinWidth, viewportWidth - detailMinWidth - splitBarWidth);
  return Math.min(Math.max(width, sidebarMinWidth), maxWidth);
}

export function App() {
  const [settings, setSettings] = useState<AppSettings>(defaultSettings);
  const [repos, setRepos] = useState<RepoStatus[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [view, setView] = useState<"repositories" | "ci" | "databases">("repositories");
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [filter, setFilter] = useState<RepoFilter>("all");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsTab, setSettingsTab] = useState<"general" | "databases">("general");
  const [settingsProfileId, setSettingsProfileId] = useState<string>();
  const [databaseConfigurationVersion, setDatabaseConfigurationVersion] = useState(0);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");
  const [watchMainBusy, setWatchMainBusy] = useState(false);
  const watchRoot = useRef(settings.rootFolder);
  watchRoot.current = settings.rootFolder;
  const [sidebarWidth, setSidebarWidth] = useState(() => clampSidebarWidth(sidebarDefaultWidth));

  const selected = useMemo(() => repos.find((repo) => repo.id === selectedId) ?? null, [repos, selectedId]);

  useEffect(() => {
    function handleResize() {
      setSidebarWidth((current) => clampSidebarWidth(current));
    }

    window.addEventListener("resize", handleResize);
    return () => window.removeEventListener("resize", handleResize);
  }, []);

  async function refresh(fetch = true) {
    if (!settings.rootFolder) {
      setSettingsOpen(true);
      return;
    }
    setLoading(true);
    setMessage(fetch ? "Refreshing repositories..." : "Scanning repositories...");
    try {
      const shells = await window.repoRadar.discoverRepositories({
        root: settings.rootFolder,
        includeNestedRepositories: settings.includeNestedRepositories
      });
      setRepos(shells);
      setRepoRoot(settings.rootFolder);
      setSelectedId((current) => current && shells.some((repo) => repo.id === current) ? current : shells[0]?.id ?? null);
      setMessage(`${shells.length} repositories found. Loading status...`);

      await Promise.all(shells.map(async (repo) => {
        try {
          const status = await window.repoRadar.refreshRepository(repo.absolutePath, fetch);
          updateRepo(status);
          updateRepo({ ...status, branchComparisonLoading: true });
          try {
            const comparison = await window.repoRadar.getBranchComparison(repo.absolutePath);
            updateRepo({
              ...status,
              branchComparison: comparison,
              branchComparisonLoaded: true,
              branchComparisonLoading: false
            });
          } catch (err) {
            updateRepo({
              ...status,
              branchComparison: null,
              branchComparisonLoaded: true,
              branchComparisonLoading: false,
              warnings: [
                ...status.warnings,
                { code: "branch-comparison-failed", message: "Could not load Develop/Main comparison.", detail: err instanceof Error ? err.message : String(err) }
              ]
            });
          }
        } catch (err) {
          updateRepo({
            ...repo,
            statusLoading: false,
            errors: [{ code: "status-failed", message: "Could not read repository status.", detail: err instanceof Error ? err.message : String(err) }]
          });
        }
      }));
      setMessage(`${shells.length} repositories loaded.`);
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
    setRepos((current) => current.map((repo) => {
      if (repo.id !== updated.id) return repo;
      return {
        ...updated,
        branchComparison: updated.branchComparisonLoaded ? updated.branchComparison : repo.branchComparison,
        branchComparisonLoaded: updated.branchComparisonLoaded ?? repo.branchComparisonLoaded,
        branchComparisonLoading: updated.branchComparisonLoading ?? repo.branchComparisonLoading
      };
    }));
  }

  async function watchMain(repo: RepoStatus) {
    if (watchMainBusy) return;
    const startingRoot = settings.rootFolder;
    setWatchMainBusy(true);
    try {
      const ciWatches = await window.repoRadar.addCiWatch({ repoPath: repo.absolutePath, branch: "main" });
      setSettings((current) => current.rootFolder === startingRoot ? { ...current, ciWatches } : current);
      if (watchRoot.current === startingRoot) setMessage(`Watching main for ${repo.name} in CI Watch.`);
    } catch (error) {
      if (watchRoot.current === startingRoot) setMessage(`Could not watch main: ${error instanceof Error ? error.message : String(error)}`);
    } finally { setWatchMainBusy(false); }
  }

  return (
    <div className="app-shell" style={{ "--sidebar-width": `${sidebarWidth}px` } as CSSProperties}>
      <RepoSidebar
        rootFolder={settings.rootFolder}
        repos={repos}
        selectedId={selectedId}
        filter={filter}
        loading={loading}
        onFilterChange={setFilter}
        onSelect={(repo) => { setSelectedId(repo.id); setView("repositories"); }}
        onRefresh={() => refresh(true)}
        onSettings={() => { setSettingsTab("general"); setSettingsProfileId(undefined); setSettingsOpen(true); }}
      />
      <div
        className="split-resizer"
        role="separator"
        aria-label="Resize repository list"
        aria-orientation="vertical"
        aria-valuemin={sidebarMinWidth}
        aria-valuemax={Math.max(sidebarMinWidth, window.innerWidth - detailMinWidth - splitBarWidth)}
        aria-valuenow={Math.round(sidebarWidth)}
        tabIndex={0}
        onPointerDown={(event) => {
          event.currentTarget.setPointerCapture(event.pointerId);
          document.body.classList.add("resizing-panels");
        }}
        onPointerMove={(event) => {
          if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
          setSidebarWidth(clampSidebarWidth(event.clientX));
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          document.body.classList.remove("resizing-panels");
        }}
        onPointerCancel={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          document.body.classList.remove("resizing-panels");
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowLeft") {
            event.preventDefault();
            setSidebarWidth((current) => clampSidebarWidth(current - (event.shiftKey ? 50 : 20)));
          }
          if (event.key === "ArrowRight") {
            event.preventDefault();
            setSidebarWidth((current) => clampSidebarWidth(current + (event.shiftKey ? 50 : 20)));
          }
          if (event.key === "Home") {
            event.preventDefault();
            setSidebarWidth(sidebarMinWidth);
          }
          if (event.key === "End") {
            event.preventDefault();
            setSidebarWidth(clampSidebarWidth(Number.POSITIVE_INFINITY));
          }
        }}
      />
      <div className="workspace">
        <nav className="workspace-nav" role="tablist" aria-label="Main views">
          <button title="Inspect local repositories" id="repositories-tab" role="tab" aria-controls="repositories-view" aria-selected={view === "repositories"} className={view === "repositories" ? "active" : ""} onClick={() => setView("repositories")}>Repositories</button>
          <button title="Monitor GitHub Actions for watched branches" id="ci-watch-tab" role="tab" aria-controls="ci-watch-view" aria-selected={view === "ci"} className={view === "ci" ? "active" : ""} onClick={() => setView("ci")}>CI Watch</button>
          <button title="Review database structure and ordered migrations" id="databases-tab" role="tab" aria-controls="databases-view" aria-selected={view === "databases"} className={view === "databases" ? "active" : ""} onClick={() => setView("databases")}>Databases</button>
        </nav>
        <div id="repositories-view" className="workspace-pane" role="tabpanel" aria-labelledby="repositories-tab" hidden={view !== "repositories"}>
          <RepoDetail
            repo={selected}
            onRepoUpdated={updateRepo}
            onMessage={setMessage}
            onWatchMain={() => { if (selected) void watchMain(selected); }}
            mainWatched={Boolean(selected && settings.ciWatches?.some((watch) => ciPathKey(watch.repoPath) === ciPathKey(selected.absolutePath) && watch.branch === "main"))}
            watchMainBusy={watchMainBusy}
          />
        </div>
        <div id="ci-watch-view" className="workspace-pane" role="tabpanel" aria-labelledby="ci-watch-tab" hidden={view !== "ci"}>
          <CiWatch
            repos={repoRoot === settings.rootFolder ? repos : []}
            watches={settings.ciWatches ?? []}
            root={settings.rootFolder}
            intervalMinutes={settings.refreshIntervalMinutes}
            active={view === "ci"}
            onWatchesChanged={(ciWatches) => setSettings((current) => ({ ...current, ciWatches }))}
            onOpenRepository={(repo) => { setSelectedId(repo.id); setView("repositories"); }}
          />
        </div>
        <div id="databases-view" className="workspace-pane" role="tabpanel" aria-labelledby="databases-tab" hidden={view !== "databases"}>
          <Databases active={view === "databases"} root={settings.rootFolder} repos={repoRoot === settings.rootFolder ? repos : []} onOpenRepository={(repo) => { setSelectedId(repo.id); setView("repositories"); }} onOpenCi={() => setView("ci")} onMessage={setMessage} configurationVersion={databaseConfigurationVersion} onOpenSettings={profileId => { setSettingsTab("databases"); setSettingsProfileId(profileId); setSettingsOpen(true); }} />
        </div>
      </div>
      <footer className="toast" aria-live="polite">{message}</footer>
      <SettingsDialog
        open={settingsOpen}
        initialTab={settingsTab}
        initialDatabaseProfileId={settingsProfileId}
        onDatabaseConfigurationChange={() => setDatabaseConfigurationVersion(current => current + 1)}
        onClose={() => setSettingsOpen(false)}
        onSaved={(next) => {
          setSettings(next);
          setMessage("Settings saved.");
        }}
      />
    </div>
  );
}
