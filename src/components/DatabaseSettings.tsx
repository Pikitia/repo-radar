import { useCallback, useEffect, useRef, useState } from "react";
import type { DatabaseProfile, SchemaSnapshot } from "../types/database.js";
import type { DatabaseOverview, DatabaseTargetVerification } from "../types/databaseApi.js";
import type { DatabaseMcpStatus } from "../types/settings.js";
import { DatabaseConnectionSetup } from "./DatabaseConnectionSetup.js";
import { DatabaseEditorDialog } from "./DatabaseEditorDialog.js";
import "../databases.css";

const empty: DatabaseOverview = { servers: [], profiles: [], proposals: [], releases: [], rehearsals: [], activeRun: null, lastRun: null };
function errorText(error: unknown): string { return error instanceof Error ? error.message : "Database operation failed"; }
interface Props {
  initialProfileId?: string;
  mcpEnabled: boolean;
  onMcpEnabledChange(enabled: boolean): void;
  onConfigurationChange?(): void;
}

export function DatabaseSettings({ initialProfileId, mcpEnabled, onMcpEnabledChange, onConfigurationChange }: Props) {
  const api = window.repoRadar.databases;
  const [overview, setOverview] = useState<DatabaseOverview>(empty);
  const [profileId, setProfileId] = useState(initialProfileId ?? "");
  const [selectedServerId, setSelectedServerId] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [verification, setVerification] = useState<DatabaseTargetVerification[]>([]);
  const [checkingIds, setCheckingIds] = useState<string[]>([]);
  const [identityReview, setIdentityReview] = useState<{ profileId: string; snapshot: SchemaSnapshot } | null>(null);
  const [mcpStatus, setMcpStatus] = useState<DatabaseMcpStatus | null>(null);
  const [mcpError, setMcpError] = useState("");
  const busyRef = useRef(false);
  const selectedProfile = overview.profiles.find(item => item.id === profileId);
  const serverId = selectedServerId ?? selectedProfile?.serverConnectionId ?? overview.servers[0]?.id ?? "";
  const snapshot = identityReview?.profileId === profileId && selectedProfile?.serverConnectionId === serverId ? identityReview.snapshot : null;
  const load = useCallback(async () => {
    const next = await api.overview();
    setOverview(next); setLoaded(true);
    setProfileId(current => next.profiles.some(item => item.id === current) ? current : next.profiles[0]?.id ?? "");
  }, [api]);
  useEffect(() => { void load().catch(cause => setError(errorText(cause))); }, [load]);
  useEffect(() => { if (initialProfileId) { setProfileId(initialProfileId); setSelectedServerId(null); } }, [initialProfileId]);
  useEffect(() => { setIdentityReview(null); }, [profileId, serverId]);
  useEffect(() => {
    let cancelled = false;
    const refresh = () => { void window.repoRadar.getDatabaseMcpStatus().then(value => { if (!cancelled) { setMcpStatus(value); setMcpError(""); } }).catch(cause => { if (!cancelled) setMcpError(errorText(cause)); }); };
    refresh(); const timer = window.setInterval(refresh, 5000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, []);
  async function perform(label: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(""); setNotice("");
    try { await action(); await load(); }
    catch (cause) { setError(errorText(cause)); }
    finally { busyRef.current = false; setBusy(""); }
  }
  async function verify(ids: string[]) {
    if (!ids.length) return;
    setBusy("Checking database connections");
    setCheckingIds(ids);
    setVerification(current => current.filter(item => !ids.includes(item.profileId)));
    const results: DatabaseTargetVerification[] = [];
    try {
      for (let offset = 0; offset < ids.length; offset += 100) results.push(...await api.verifyTargets(ids.slice(offset, offset + 100)));
      setVerification(current => [...current.filter(item => !ids.includes(item.profileId)), ...results]);
    } finally { setCheckingIds([]); }
    onConfigurationChange?.();
  }
  function configurationChanged() {
    setIdentityReview(null); setVerification([]); onConfigurationChange?.();
  }
  function selectTarget(profile: DatabaseProfile) { setProfileId(profile.id); setSelectedServerId(profile.serverConnectionId); }
  return <section className="database-workspace database-settings" aria-label="Database settings">
    {error && <p role="alert" className="issue-box">{error}</p>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">{busy}…</p>}
    {!loaded ? <p>Loading database setup…</p> : <>
      {overview.mcpAccessError && <p role="alert" className="issue-box">{overview.mcpAccessError}</p>}
      <DatabaseConnectionSetup api={api} overview={overview} serverId={serverId} selectedProfile={selectedProfile} verification={verification} checkingIds={checkingIds} busy={!!busy} error={error} notice={notice} progress={busy} perform={perform} notify={setNotice}
        onConfigurationChange={configurationChanged} onSelectServer={id => { setSelectedServerId(id); setProfileId(overview.profiles.find(item => item.serverConnectionId === id)?.id ?? ""); }} onSelectTarget={selectTarget} verify={verify}
        onReviewIdentity={profile => { selectTarget(profile); void perform("Inspecting identity for review", async () => { setIdentityReview({ profileId: profile.id, snapshot: await api.inspect(profile.id) }); }); }} />
      {snapshot && selectedProfile && <DatabaseEditorDialog title={`Review identity · ${selectedProfile.label}`} closeLabel="Cancel identity review" busy={!!busy} error={error} notice={notice} progress={busy} onClose={() => setIdentityReview(null)}><article aria-label="Target identity review"><p>Only accept this identity if it is the intended database. Accepting replaces the saved binding for this target.</p><p>{snapshot.identity.engine} {snapshot.identity.version} · {snapshot.identity.database}</p><code className="database-digest">{snapshot.identity.fingerprint}</code><pre>{JSON.stringify(snapshot.identity.settings, null, 2)}</pre><button disabled={!!busy} onClick={() => void perform("Accepting reviewed target identity", async () => { await api.acceptIdentity(identityReview!.profileId, snapshot.identity.fingerprint); setIdentityReview(null); await verify([selectedProfile.id]); })}>Accept reviewed identity</button></article></DatabaseEditorDialog>}
    </>}
    <details className="database-mcp-settings"><summary>MCP server</summary>
      <h3>Local MCP server</h3>
      <label className="inline-check"><input type="checkbox" checked={mcpEnabled} onChange={event => onMcpEnabledChange(event.target.checked)} />Start the database MCP server automatically</label>
      <p className="muted">Save Settings to apply this switch.</p>
      <p role="status">{mcpStatus ? mcpStatus.running ? `MCP server running · ${mcpStatus.url ?? "localhost"}` : mcpStatus.enabled ? "MCP server is not running" : "MCP server disabled" : "Checking MCP server…"}</p>
      {(mcpError || mcpStatus?.error) && <p role="alert" className="issue-box">{mcpError || mcpStatus?.error}</p>}
      <button disabled={!mcpStatus?.running} onClick={() => void perform("Copying MCP configuration", async () => { await window.repoRadar.copyDatabaseMcpConfig(); setNotice("MCP configuration copied. It includes the private connection token; paste it only into your agent configuration."); })}>Copy MCP configuration</button>
      <p className="muted">Enable read access with each database's checkbox. One MCP connection can read enabled databases on multiple servers, including production databases you explicitly enable.</p>
    </details>
  </section>;
}
