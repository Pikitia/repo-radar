import { RefreshCw, Settings } from "lucide-react";
import type { RepoFilter, RepoStatus } from "../types/repo";
import { repoMatchesFilter, sidebarIndicators } from "../state/repoLogic";

const filters: RepoFilter[] = ["all", "changed", "clean", "ahead", "behind", "diverged", "errors"];

function statusClass(indicator: string): string {
  if (indicator === "Clean") return "status-clean";
  if (indicator === "Changed") return "status-changed";
  if (indicator === "Diverged") return "status-diverged";
  if (indicator === "Error") return "status-error";
  if (indicator === "Warn") return "status-warn";
  if (indicator.startsWith("+")) return "status-ahead";
  if (indicator.startsWith("-")) return "status-behind";
  return "";
}

type Props = {
  rootFolder: string | null;
  repos: RepoStatus[];
  selectedId: string | null;
  filter: RepoFilter;
  loading: boolean;
  onFilterChange(filter: RepoFilter): void;
  onSelect(repo: RepoStatus): void;
  onRefresh(): void;
  onSettings(): void;
};

export function RepoSidebar(props: Props) {
  const filtered = props.repos.filter((repo) => repoMatchesFilter(repo, props.filter));
  const groups = new Map<string, RepoStatus[]>();
  for (const repo of filtered) {
    groups.set(repo.parentGroup, [...(groups.get(repo.parentGroup) ?? []), repo]);
  }

  return (
    <aside className="sidebar">
      <div className="root-row">
        <div className="root-text" title={props.rootFolder ?? "No root folder configured"}>
          <span className="label">Root</span>
          <strong>{props.rootFolder ?? "Choose a folder"}</strong>
        </div>
        <button className="icon-button" title="Settings" onClick={props.onSettings}>
          <Settings size={16} />
        </button>
      </div>
      <button className="full-button" onClick={props.onRefresh} disabled={!props.rootFolder || props.loading}>
        <RefreshCw size={15} /> {props.loading ? "Refreshing" : "Refresh All"}
      </button>
      <div className="filters">
        {filters.map((filter) => (
          <button key={filter} className={props.filter === filter ? "active" : ""} onClick={() => props.onFilterChange(filter)}>
            {filter}
          </button>
        ))}
      </div>
      <div className="repo-list">
        {[...groups.entries()].map(([group, repos]) => (
          <section key={group} className="repo-group">
            {group !== "/" && <h3>{group}</h3>}
            {repos.map((repo) => (
              <button key={repo.id} className={`repo-row ${props.selectedId === repo.id ? "selected" : ""}`} onClick={() => props.onSelect(repo)}>
                <span className="repo-title" title={repo.relativePath}>{repo.name}</span>
                <span className="repo-meta">
                  <span className="branch-pill">{repo.branch ?? "detached"}</span>
                  {sidebarIndicators(repo).map((item) => (
                    <b key={item} className={statusClass(item)}>{item}</b>
                  ))}
                </span>
              </button>
            ))}
          </section>
        ))}
      </div>
    </aside>
  );
}
