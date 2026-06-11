import { Code2, Copy, FolderOpen, GitCommit, GitPullRequest, Globe, RefreshCw, Terminal, Upload, RotateCw } from "lucide-react";
import type { RepoStatus } from "../types/repo";
import { actionAvailability } from "../state/repoLogic";

type Props = {
  repo: RepoStatus;
  busy: boolean;
  onCommit(): void;
  onPull(): void;
  onPush(): void;
  onSync(): void;
  onRefresh(): void;
  onVSCode(): void;
  onExplorer(): void;
  onTerminal(): void;
  onCopy(): void;
  onRemote(): void;
};

export function Toolbar(props: Props) {
  const availability = actionAvailability(props.repo);
  return (
    <div className="toolbar">
      <button title={availability.reasons.commit ?? "Commit"} disabled={!availability.commit || props.busy} onClick={props.onCommit}><GitCommit size={15} /> Commit</button>
      <button title={availability.reasons.pull ?? "Pull"} disabled={!availability.pull || props.busy} onClick={props.onPull}><GitPullRequest size={15} /> Pull</button>
      <button title={availability.reasons.push ?? "Push"} disabled={!availability.push || props.busy} onClick={props.onPush}><Upload size={15} /> Push</button>
      <button title={availability.reasons.sync ?? "Sync"} disabled={!availability.sync || props.busy} onClick={props.onSync}><RotateCw size={15} /> Sync</button>
      <button title="Refresh repository" disabled={props.busy} onClick={props.onRefresh}><RefreshCw size={15} /> Refresh</button>
      <span className="toolbar-separator" />
      <button title="Open in VS Code" onClick={props.onVSCode}><Code2 size={15} /></button>
      <button title="Open in Explorer" onClick={props.onExplorer}><FolderOpen size={15} /></button>
      <button title="Open terminal here" onClick={props.onTerminal}><Terminal size={15} /></button>
      <button title="Copy path" onClick={props.onCopy}><Copy size={15} /></button>
      <button title="Open remote" onClick={props.onRemote}><Globe size={15} /></button>
    </div>
  );
}
