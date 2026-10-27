import { useEffect, useState } from "react";
import type { DatabaseCredentialRole, DatabaseEnvironment, DatabaseProfile, DatabaseProfileInput, DatabaseServerDetails, DatabaseServerInput } from "../types/database.js";
import type { DatabaseDesktopApi, DatabaseOverview, DatabaseTargetVerification, McpDataPolicy } from "../types/databaseApi.js";
import { DatabaseEditorDialog } from "./DatabaseEditorDialog.js";

const initialServer: DatabaseServerInput = { label: "", host: "", port: 3306, tlsMode: "disabled", tlsCa: "" };
const roles: { role: DatabaseCredentialRole; label: string; flag: "hasInspectionCredentials" | "hasMigrationCredentials" | "hasDiagnosticCredentials" }[] = [
  { role: "inspection", label: "Read-only inspection", flag: "hasInspectionCredentials" },
  { role: "migration", label: "Migration execution", flag: "hasMigrationCredentials" },
  { role: "diagnostic", label: "MCP read access", flag: "hasDiagnosticCredentials" }
];
interface DiscoveryRow {
  database: string; assigned: boolean; selected: boolean; databaseKey: string; label: string; environment: DatabaseEnvironment | "";
}
interface Props {
  api: DatabaseDesktopApi;
  overview: DatabaseOverview;
  serverId: string;
  selectedProfile?: DatabaseProfile;
  verification: DatabaseTargetVerification[];
  busy: boolean;
  error?: string;
  notice?: string;
  progress?: string;
  checkingIds?: string[];
  perform(label: string, action: () => Promise<void>): Promise<void>;
  notify(message: string): void;
  onConfigurationChange(): void;
  onSelectServer(id: string): void;
  onSelectTarget(profile: DatabaseProfile): void;
  onReviewIdentity(profile: DatabaseProfile): void;
  verify(ids: string[]): Promise<void>;
}
function profileInput(profile: DatabaseProfile): DatabaseProfileInput {
  return { id: profile.id, databaseKey: profile.databaseKey, label: profile.label, environment: profile.environment, serverConnectionId: profile.serverConnectionId, database: profile.database };
}
function Tick({ yes, label }: { yes: boolean; label: string }) {
  return <span className={yes ? "database-status-ok" : "muted"}>{yes ? "✓" : "—"} {label}</span>;
}

// A separate instance per server keeps drafts, secrets and check results with their owner.
export function DatabaseConnectionSetup(props: Props) {
  const { overview, serverId, busy, onSelectServer } = props;
  const [newServerId, setNewServerId] = useState<string | null>(null);
  const [addRequest, setAddRequest] = useState(0);
  return <>
    <h2>Server connections</h2>
    <div className="database-connection-layout">
      <aside className="database-server-sidebar" aria-label="Server connections">
        <button disabled={busy} onClick={() => { setAddRequest(current => current + 1); onSelectServer(""); }} aria-label="Add server connection">＋ Add connection</button>
        <div role="tablist" aria-label="Server connections" aria-orientation="vertical" onKeyDown={event => {
          const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
          if (busy || !keys.includes(event.key) || !overview.servers.length) return;
          event.preventDefault();
          const index = overview.servers.findIndex(server => server.id === serverId);
          const next = event.key === "Home" ? 0 : event.key === "End" ? overview.servers.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + overview.servers.length) % overview.servers.length;
          const id = overview.servers[next].id;
          onSelectServer(id); document.getElementById(`server-tab-${id}`)?.focus();
        }}>
          {overview.servers.map(server => <div className="database-server-tab" key={server.id}>
            <button role="tab" tabIndex={serverId === server.id || !serverId && server.id === overview.servers[0]?.id ? 0 : -1} id={`server-tab-${server.id}`} aria-controls="database-server-panel" aria-selected={serverId === server.id} disabled={busy} onClick={() => { setNewServerId(null); onSelectServer(server.id); }}>
              <strong>{server.label}</strong><span>{server.host}:{server.port}</span>
            </button>
          </div>)}
        </div>
      </aside>
      <div role="tabpanel" id="database-server-panel" aria-label={overview.servers.find(server => server.id === serverId)?.label ?? "New server connection"} className="database-server-panel">
        <ServerPanel key={serverId || `new-${addRequest}`} {...props} startEditing={newServerId === serverId} onSelectServer={id => { setNewServerId(serverId ? null : id); onSelectServer(id); }} />
      </div>
    </div>
  </>;
}

function ServerPanel({ api, overview, serverId, selectedProfile, verification, busy, perform, notify, onConfigurationChange, onSelectServer, onSelectTarget, onReviewIdentity, verify, startEditing, error, notice, progress, checkingIds = [] }: Props & { startEditing: boolean }) {
  const savedServer = overview.servers.find(item => item.id === serverId);
  const profiles = overview.profiles.filter(item => item.serverConnectionId === serverId);
  const [server, setServer] = useState<DatabaseServerInput>(initialServer);
  const [details, setDetails] = useState<DatabaseServerDetails | null>(null);
  const [editing, setEditing] = useState(!serverId || startEditing);
  const [loading, setLoading] = useState(!!serverId);
  const [loadError, setLoadError] = useState("");
  const [role, setRole] = useState<DatabaseCredentialRole | null>(null);
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [checkingRole, setCheckingRole] = useState<DatabaseCredentialRole | null>(null);
  const [checks, setChecks] = useState<Partial<Record<DatabaseCredentialRole, { status: "verified" | "failed"; message?: string }>>>({});
  const [rows, setRows] = useState<DiscoveryRow[] | null>(null);
  const [assignmentEnvironment, setAssignmentEnvironment] = useState<DatabaseEnvironment | "">("");
  const [profile, setProfile] = useState<DatabaseProfileInput | null>(null);
  const [mcpProfile, setMcpProfile] = useState<DatabaseProfile | null>(null);
  const [mcpMode, setMcpMode] = useState<"" | "all" | "selected">("");
  const [mcpPolicy, setMcpPolicy] = useState('{"tables":{}}');
  function editMcpAccess(target: DatabaseProfile) {
    const current = overview.mcpAccess?.find(item => item.profileId === target.id)?.policy;
    setMcpMode(current ? "mode" in current ? "all" : "selected" : "");
    setMcpPolicy(current && !("mode" in current) ? JSON.stringify(current, null, 2) : '{"tables":{}}');
    setMcpProfile(target);
  }
  useEffect(() => {
    if (!serverId) return;
    let cancelled = false;
    void api.getServerConnection(serverId).then(value => {
      if (!cancelled) {
        setDetails(value);
        setServer({ id: value.id, label: value.label, host: value.host, port: value.port, tlsMode: value.tlsMode, tlsCa: value.tlsCa ?? "" });
      }
    }).catch(cause => { if (!cancelled) setLoadError(cause instanceof Error ? cause.message : "Cannot load server details."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, serverId]);
  const unavailable = busy || loading;
  const serverUnavailable = unavailable || !!serverId && !details;
  const connectionChanged = !!details && (server.host !== details.host || server.port !== details.port || server.tlsMode !== details.tlsMode || (server.tlsCa ?? "") !== (details.tlsCa ?? ""));
  const selectedRows = rows?.filter(row => row.selected && !row.assigned) ?? [];
  const unassigned = rows?.filter(row => !profiles.some(item => item.database === row.database)) ?? [];
  function editRole(next: DatabaseCredentialRole) { setRole(next); setUsername(details?.credentialUsernames[next] ?? ""); setPassword(""); }
  function updateRow(database: string, update: Partial<DiscoveryRow>) {
    setRows(current => current?.map(row => row.database === database ? { ...row, ...update } : row) ?? null);
  }
  function invalidate() { setChecks({}); setRows(null); onConfigurationChange(); }
  function closeEditor() {
    setEditing(false); setRole(null); setPassword("");
    if (details) setServer({ id: details.id, label: details.label, host: details.host, port: details.port, tlsMode: details.tlsMode, tlsCa: details.tlsCa ?? "" });
  }
  return <>
    <div className="database-connection-heading"><div><h3>{savedServer?.label ?? "New server connection"}</h3>{savedServer && <p className="muted">{savedServer.host}:{savedServer.port}</p>}</div>
      {serverId && !editing && <button disabled={unavailable || !details} onClick={() => setEditing(true)}>Edit connection</button>}
    </div>
    {loading && <p role="status">Loading saved server details…</p>}{loadError && <p role="alert" className="issue-box">{loadError}</p>}
    {editing && <DatabaseEditorDialog title={serverId ? "Edit server connection" : "New server connection"} closeLabel="Close connection setup" busy={busy} error={error} notice={notice} progress={progress} onClose={closeEditor}>
      <form aria-label="Server connection settings" className="database-form" onSubmit={event => { event.preventDefault(); void perform("Saving server connection", async () => {
        const saved = await api.saveServerConnection({ ...server, tlsCa: server.tlsMode === "verify" ? server.tlsCa?.trim() || undefined : undefined });
        invalidate();
        const next = await api.getServerConnection(saved.id); setDetails(next);
        setServer({ id: next.id, label: next.label, host: next.host, port: next.port, tlsMode: next.tlsMode, tlsCa: next.tlsCa ?? "" });
        setRole(null); setPassword(""); onSelectServer(saved.id);
        notify("Server connection saved.");
        if (saved.hasInspectionCredentials) await verify(profiles.map(item => item.id));
      }); }}>
        <label>Server label<input required disabled={serverUnavailable} value={server.label} onChange={event => setServer({ ...server, label: event.target.value })} /></label>
        <label>Host<input required disabled={serverUnavailable} autoComplete="off" value={server.host} onChange={event => setServer({ ...server, host: event.target.value })} /></label>
        <label>Port<input required disabled={serverUnavailable} type="number" min={1} max={65535} value={server.port} onChange={event => setServer({ ...server, port: Number(event.target.value) })} /></label>
        <label>TLS<select disabled={serverUnavailable} value={server.tlsMode} onChange={event => setServer({ ...server, tlsMode: event.target.value as DatabaseServerInput["tlsMode"] })}><option value="disabled">Off</option><option value="verify">Verified TLS</option></select></label>
        {server.tlsMode === "verify" && <label className="database-wide">TLS certificate authority (PEM, optional)<textarea disabled={serverUnavailable} value={server.tlsCa ?? ""} onChange={event => setServer({ ...server, tlsCa: event.target.value })} /></label>}
        <p className="database-wide muted">{server.tlsMode === "verify" ? "Use a certificate-matching hostname. Leave the authority blank for system trust." : "TLS is off; enable it when supported by this server."} Changing the host or port clears saved credentials.</p>
        <button disabled={serverUnavailable}>Save server connection</button>
      </form>
      {connectionChanged && <p className="muted">Save connection changes before editing credentials, checking or rescanning.</p>}
      <h3>Credentials</h3>
      {!serverId && <p className="muted">Save this connection to add credentials.</p>}
      <div className="database-table-scroll"><table className="database-discovery-table" aria-label="Server credentials"><thead><tr><th>Purpose</th><th>Set up</th><th>Connection check</th><th>Actions</th></tr></thead><tbody>
        {roles.map(item => <tr key={item.role}><th scope="row">{item.label}</th><td><Tick yes={!!details?.[item.flag]} label={details?.[item.flag] ? "Set up" : "Not set up"} /></td>
          <td aria-live="polite">{checkingRole === item.role ? "Checking…" : checks[item.role] ? <span className={checks[item.role]?.status === "verified" ? "database-status-ok" : "issue-box"}>{checks[item.role]?.status === "verified" ? "✓ Connected" : checks[item.role]?.message}</span> : "Not checked"}</td>
          <td><div className="database-row-actions"><button disabled={serverUnavailable || !serverId || connectionChanged} aria-label={`Edit ${item.label} credentials`} onClick={() => editRole(item.role)}>Edit</button>
            <button disabled={serverUnavailable || !details?.[item.flag] || connectionChanged} aria-label={`Check ${item.label} connection`} onClick={() => void perform(`Checking ${item.label} connection`, async () => {
              setChecks(current => ({ ...current, [item.role]: undefined }));
              setCheckingRole(item.role);
              try { const result = await api.checkServerConnection(serverId, item.role); setChecks(current => ({ ...current, [item.role]: result })); }
              finally { setCheckingRole(null); }
            })}>Check</button></div></td></tr>)}
      </tbody></table></div>
      {role && <DatabaseEditorDialog title={`Edit ${roles.find(item => item.role === role)?.label} credentials`} closeLabel="Close credential setup" busy={busy} error={error} notice={notice} progress={progress} onClose={() => { setRole(null); setPassword(""); }}><form aria-label="Edit credentials" className="database-form" onSubmit={event => { event.preventDefault(); const secret = password; setPassword(""); void perform("Saving protected credentials", async () => {
        const savedUsername = details?.credentialUsernames[role];
        await api.saveServerCredentials(serverId, role, { username, ...(secret || !savedUsername ? { password: secret } : {}) });
        invalidate(); const next = await api.getServerConnection(serverId); setDetails(next); setUsername(next.credentialUsernames[role] ?? ""); notify("Credentials saved.");
        if (role === "inspection") await verify(profiles.map(item => item.id));
      }); }}>
        <label>Username<input required disabled={unavailable} autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} /></label>
        <label>Password<input type="password" required={!!details?.credentialUsernames[role] && username !== details.credentialUsernames[role]} disabled={unavailable} autoComplete="new-password" placeholder={details?.credentialUsernames[role] ? "Leave blank to keep saved password" : "Password"} value={password} onChange={event => setPassword(event.target.value)} /></label>
        <button disabled={unavailable || connectionChanged}>Save credentials</button><button type="button" disabled={unavailable} onClick={() => { setRole(null); setPassword(""); }}>Cancel credential edit</button>
      </form></DatabaseEditorDialog>}
      <p className="muted">Passwords are never shown. Check tests sign-in only. MCP uses its own read-only account and can read only databases you enable in the grid.</p>
    </DatabaseEditorDialog>}
    {serverId && <>
      <div className="database-connection-heading"><h3>Databases</h3><div className="database-row-actions">
        <button disabled={serverUnavailable || !details?.hasInspectionCredentials || connectionChanged} onClick={() => void perform("Scanning available databases", async () => {
          setRows(null); onConfigurationChange();
          const result = await api.discoverDatabases(serverId);
          setRows(result.databases.map(item => ({ database: item.database, assigned: item.assigned, selected: false, databaseKey: item.database, label: item.database, environment: "" })));
        })}>Rescan databases</button>
        <button disabled={unavailable || !profiles.length || connectionChanged} onClick={() => void perform("Checking databases", () => verify(profiles.map(item => item.id)))}>Check databases</button>
        <button disabled={unavailable} onClick={() => setProfile({ databaseKey: "", label: "", environment: "dev", serverConnectionId: serverId, database: "" })}>Add database manually</button>
      </div></div>
      <div className="database-table-scroll"><table className="database-discovery-table" aria-label="Server databases"><thead><tr><th>Database</th><th>Target</th><th>Environment</th><th>Identified</th><th>Available</th><th>MCP read access</th><th>Actions</th></tr></thead><tbody>
        {profiles.map(item => {
          const result = verification.find(value => value.profileId === item.id);
          const mcpEnabled = overview.mcpAccess?.some(value => value.profileId === item.id) ?? false;
          return <tr key={item.id} className={selectedProfile?.id === item.id ? "database-selected-row" : undefined}>
            <th scope="row">{item.database}</th><td>{item.label}<small className="database-cell-secondary">{item.databaseKey}</small></td><td>{item.environment}</td>
            <td><Tick yes={result?.status !== "failed" && (!!item.identity || result?.status === "verified")} label={result?.status === "failed" ? "Needs check" : item.identity || result?.status === "verified" ? "Identified" : "Not identified"} /></td>
            <td aria-live="polite">{checkingIds.includes(item.id) ? "Checking…" : <Tick yes={result?.status === "verified"} label={result ? result.status === "verified" ? "Available" : "Check failed" : "Not checked"} />}{result?.message && <small className="database-cell-secondary issue-box">{result.message}</small>}</td>
            <td><div className="database-row-actions"><label className="database-check"><input type="checkbox" aria-label={`MCP read access for ${item.label}`} checked={mcpEnabled} disabled={unavailable || connectionChanged || !mcpEnabled && (!savedServer?.hasDiagnosticCredentials || !savedServer.hasInspectionCredentials)} onChange={event => {
              if (event.target.checked) editMcpAccess(item);
              else void perform("Disabling MCP read access", async () => { await api.setMcpReadAccess({ profileId: item.id, enabled: false }); onConfigurationChange(); notify(`MCP read access disabled for ${item.label}.`); });
            }} /></label>{mcpEnabled && <button disabled={unavailable} aria-label={`Edit MCP access for ${item.label}`} onClick={() => editMcpAccess(item)}>Scope</button>}</div></td>
            <td><div className="database-row-actions"><button disabled={unavailable} aria-label={`Edit ${item.label}`} onClick={() => { setProfile(profileInput(item)); onSelectTarget(item); }}>Edit</button><button disabled={unavailable || connectionChanged} aria-label={`Check ${item.label}`} onClick={() => void perform("Checking database", () => verify([item.id]))}>Check</button>
              {result?.status === "failed" && <button disabled={unavailable} onClick={() => onReviewIdentity(item)}>Review identity for {item.label}</button>}
            </div></td>
          </tr>;
        })}
        {unassigned.map(row => <tr key={row.database}><th scope="row">{row.database}</th><td>{row.assigned ? "Assigned through another connection" : "Not assigned"}</td><td>—</td><td><Tick yes={false} label="Not identified" /></td><td>✓ Visible</td><td>Assign first</td><td>{!row.assigned && <label className="database-check"><input aria-label={`Assign ${row.database}`} type="checkbox" disabled={unavailable} checked={row.selected} onChange={event => updateRow(row.database, { selected: event.target.checked, environment: row.environment || assignmentEnvironment })} />Assign</label>}</td></tr>)}
      </tbody></table></div>
      {!profiles.length && !unassigned.length && <p className="muted">{rows ? "No accessible application databases found." : "Rescan to find databases, or add one manually."}</p>}
      {profiles.length > 0 && !savedServer?.hasDiagnosticCredentials && <p className="muted">Add the MCP read-only account in Edit connection to enable database access.</p>}
      {rows && rows.some(row => !row.assigned) && <section aria-label="Assign discovered databases">
        <div className="database-actions"><button disabled={unavailable} onClick={() => setRows(current => current?.map(row => row.assigned ? row : { ...row, selected: true, environment: row.environment || assignmentEnvironment }) ?? null)}>Select all unassigned</button><button disabled={unavailable || !selectedRows.length} onClick={() => setRows(current => current?.map(row => ({ ...row, selected: false })) ?? null)}>Clear selection</button>
          <label>Environment for selected databases<select value={assignmentEnvironment} disabled={unavailable} onChange={event => { const value = event.target.value as DatabaseEnvironment | ""; setAssignmentEnvironment(value); setRows(current => current?.map(row => row.selected && !row.assigned ? { ...row, environment: value } : row) ?? null); }}><option value="">Choose environment</option><option value="dev">Development</option><option value="production">Production</option><option value="sandbox">Isolated sandbox</option></select></label>
        </div>
        {selectedRows.map(row => <div className="database-form" key={row.database}><strong>{row.database}</strong><label>Database key<input aria-label={`Database key for ${row.database}`} disabled={unavailable} value={row.databaseKey} onChange={event => updateRow(row.database, { databaseKey: event.target.value })} /></label><label>Target label<input aria-label={`Target label for ${row.database}`} disabled={unavailable} value={row.label} onChange={event => updateRow(row.database, { label: event.target.value })} /></label><label>Environment<select aria-label={`Environment for ${row.database}`} disabled={unavailable} value={row.environment} onChange={event => updateRow(row.database, { environment: event.target.value as DatabaseEnvironment | "" })}><option value="">Choose environment</option><option value="dev">Development</option><option value="production">Production</option><option value="sandbox">Isolated sandbox</option></select></label></div>)}
        <button disabled={unavailable || !selectedRows.length || selectedRows.some(row => !row.environment || !row.databaseKey.trim() || !row.label.trim())} onClick={() => void perform("Assigning discovered databases", async () => {
          const saved = await api.assignDatabases(serverId, selectedRows.map(row => ({ serverConnectionId: serverId, database: row.database, databaseKey: row.databaseKey, label: row.label, environment: row.environment as DatabaseEnvironment })));
          onConfigurationChange(); const names = new Set(saved.map(item => item.database));
          setRows(current => current?.map(row => names.has(row.database) ? { ...row, assigned: true, selected: false } : row) ?? null);
          if (saved[0]) onSelectTarget(saved[0]); notify(`Assigned ${saved.length} database targets.`); await verify(saved.map(item => item.id));
        })}>Assign selected databases</button>
      </section>}
      {profile && <DatabaseEditorDialog title={profile.id ? "Edit database" : "Add database"} closeLabel="Close database setup" busy={busy} error={error} notice={notice} progress={progress} onClose={() => setProfile(null)}><p className="muted">Use the same database key for development and production versions of one database.</p>
        <form aria-label="Database target settings" className="database-form" onSubmit={event => { event.preventDefault(); void perform("Saving database target", async () => {
          const saved = await api.saveProfile(profile); onConfigurationChange(); setProfile(null); onSelectTarget(saved); notify("Database target saved."); await verify([saved.id]);
        }); }}>
          <label>Target server connection<select required disabled={unavailable} value={profile.serverConnectionId} onChange={event => setProfile({ ...profile, serverConnectionId: event.target.value })}>{overview.servers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
          <label>Database name<input required disabled={unavailable} value={profile.database} onChange={event => setProfile({ ...profile, database: event.target.value })} /></label>
          <label>Database key<input required disabled={unavailable} value={profile.databaseKey} onChange={event => setProfile({ ...profile, databaseKey: event.target.value })} /></label>
          <label>Target label<input required disabled={unavailable} value={profile.label} onChange={event => setProfile({ ...profile, label: event.target.value })} /></label>
          <label>Environment<select disabled={unavailable} value={profile.environment} onChange={event => setProfile({ ...profile, environment: event.target.value as DatabaseEnvironment })}><option value="dev">Development</option><option value="production">Production</option><option value="sandbox">Isolated sandbox</option></select></label>
          <button disabled={unavailable}>Save database target</button><button type="button" disabled={unavailable} onClick={() => setProfile(null)}>Cancel database edit</button>
        </form>
      </DatabaseEditorDialog>}
      {mcpProfile && <DatabaseEditorDialog title={`MCP read access · ${mcpProfile.label}`} closeLabel="Cancel MCP access setup" busy={busy} error={error} notice={notice} progress={progress} onClose={() => setMcpProfile(null)}>
        <p>Read access to {mcpProfile.database} on {savedServer?.label} ({mcpProfile.environment}).</p>
        <form onSubmit={event => { event.preventDefault(); if (!mcpMode) return; void perform("Saving MCP read access", async () => {
          const policy: McpDataPolicy = mcpMode === "all" ? { mode: "all" } : JSON.parse(mcpPolicy);
          await api.setMcpReadAccess({ profileId: mcpProfile.id, enabled: true, policy });
          onConfigurationChange(); setMcpProfile(null); notify(`MCP read access enabled for ${mcpProfile.label}.`);
        }); }}>
          <label className="database-check"><input type="radio" name="mcp-scope" checked={mcpMode === "all"} disabled={busy} onChange={() => setMcpMode("all")} />All ordinary tables and columns</label>
          <label className="database-check"><input type="radio" name="mcp-scope" checked={mcpMode === "selected"} disabled={busy} onChange={() => setMcpMode("selected")} />Choose tables and columns</label>
          {mcpMode === "selected" && <label>Allowed tables and columns (JSON)<textarea aria-label="MCP table and column policy" value={mcpPolicy} disabled={busy} onChange={event => setMcpPolicy(event.target.value)} /></label>}
          <p className="muted">Reads use the server's separate MCP account. Sensitive fields, writes, views and routines are excluded from data queries.</p>
          <button disabled={busy || !mcpMode}>Enable MCP read access</button>
        </form>
      </DatabaseEditorDialog>}
    </>}
  </>;
}
