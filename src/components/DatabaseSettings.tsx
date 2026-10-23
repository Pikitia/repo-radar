import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import type { DatabaseCredentialRole, DatabaseEnvironment, DatabaseProfile, DatabaseProfileInput, DatabaseServerDetails, DatabaseServerInput, SchemaSnapshot } from "../types/database.js";
import type { DatabaseDesktopApi, DatabaseOverview, DatabaseTargetVerification } from "../types/databaseApi.js";
import type { DatabaseMcpStatus } from "../types/settings.js";
import "../databases.css";

const empty: DatabaseOverview = { servers: [], profiles: [], proposals: [], releases: [], rehearsals: [], activeRun: null, lastRun: null };
const initialProfile: DatabaseProfileInput = { databaseKey: "", label: "", environment: "dev", serverConnectionId: "", database: "" };
const initialServer: DatabaseServerInput = { label: "", host: "", port: 3306, tlsMode: "disabled", tlsCa: "" };
function errorText(error: unknown): string { return error instanceof Error ? error.message : "Database operation failed"; }

interface ConnectionSetupProps {
  api: DatabaseDesktopApi;
  overview: DatabaseOverview;
  selectedProfile?: DatabaseProfile;
  busy: boolean;
  perform(label: string, action: () => Promise<void>): Promise<void>;
  notify(message: string): void;
  onConfigurationChange(): void;
  onSelectTarget(profile: DatabaseProfile): void;
  verify(ids: string[]): Promise<void>;
}
interface DiscoveryRow {
  database: string;
  assigned: boolean;
  selected: boolean;
  databaseKey: string;
  label: string;
  environment: DatabaseEnvironment | "";
}
function profileInput(profile: DatabaseProfile): DatabaseProfileInput {
  return { id: profile.id, databaseKey: profile.databaseKey, label: profile.label, environment: profile.environment, serverConnectionId: profile.serverConnectionId, database: profile.database };
}
function ConnectionSetup({ api, overview, selectedProfile, busy, perform, notify, onConfigurationChange, onSelectTarget, verify }: ConnectionSetupProps) {
  const [serverId, setServerId] = useState(selectedProfile?.serverConnectionId ?? overview.servers[0]?.id ?? "");
  const [server, setServer] = useState<DatabaseServerInput>(initialServer);
  const [details, setDetails] = useState<DatabaseServerDetails | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [profile, setProfile] = useState<DatabaseProfileInput>(selectedProfile ? profileInput(selectedProfile) : { ...initialProfile, serverConnectionId: serverId });
  const [role, setRole] = useState<DatabaseCredentialRole>("inspection");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [rows, setRows] = useState<DiscoveryRow[] | null>(null);
  const [assignmentEnvironment, setAssignmentEnvironment] = useState<DatabaseEnvironment | "">("");
  const targetId = selectedProfile?.id;
  const targetKey = selectedProfile?.databaseKey;
  const targetLabel = selectedProfile?.label;
  const targetEnvironment = selectedProfile?.environment;
  const targetServer = selectedProfile?.serverConnectionId;
  const targetDatabase = selectedProfile?.database;
  useEffect(() => {
    if (targetId && targetKey && targetLabel && targetEnvironment && targetServer && targetDatabase) {
      setProfile({ id: targetId, databaseKey: targetKey, label: targetLabel, environment: targetEnvironment, serverConnectionId: targetServer, database: targetDatabase });
      setServerId(targetServer);
    }
  }, [targetId, targetKey, targetLabel, targetEnvironment, targetServer, targetDatabase]);
  useEffect(() => {
    let cancelled = false;
    setDetails(null); setRows(null); setAssignmentEnvironment(""); setPassword(""); setUsername(""); setLoadError("");
    if (!serverId) { setServer(initialServer); setLoading(false); return; }
    setLoading(true);
    void api.getServerConnection(serverId).then(value => {
      if (!cancelled) {
        setDetails(value);
        setServer({ id: value.id, label: value.label, host: value.host, port: value.port, tlsMode: value.tlsMode, tlsCa: value.tlsCa ?? "" });
      }
    }).catch(cause => { if (!cancelled) setLoadError(errorText(cause)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [api, serverId]);
  useEffect(() => { setUsername(details?.credentialUsernames[role] ?? ""); setPassword(""); }, [details, role]);
  const savedUsername = details?.credentialUsernames[role];
  const selectedRows = rows?.filter(row => row.selected && !row.assigned) ?? [];
  const unavailable = busy || loading;
  const serverUnavailable = unavailable || !!serverId && !details;
  function selectRow(database: string, selected: boolean) {
    setRows(current => current?.map(row => row.database === database ? { ...row, selected, environment: row.environment || assignmentEnvironment } : row) ?? null);
  }
  function updateRow(database: string, update: Partial<DiscoveryRow>) {
    setRows(current => current?.map(row => row.database === database ? { ...row, ...update } : row) ?? null);
  }
  return <>
    <h2>Server connections</h2>
    <p>Save a server and its credentials once, then assign its databases to development, production or sandbox targets. Saved passwords stay protected and are never shown.</p>
    <div className="database-actions"><label>Saved server connection<select value={serverId} disabled={busy} onChange={event => setServerId(event.target.value)}><option value="">New server connection</option>{overview.servers.map(item => <option key={item.id} value={item.id}>{item.label} · {item.host}:{item.port}</option>)}</select></label><button disabled={unavailable} onClick={() => { setServerId(""); setServer(initialServer); }}>New server connection</button></div>
    {loading && <p role="status">Loading saved server details…</p>}{loadError && <p role="alert" className="issue-box">{loadError}</p>}
    <form aria-label="Server connection settings" className="database-form" onSubmit={event => { event.preventDefault(); void perform("Saving protected server connection", async () => {
      const saved = await api.saveServerConnection({ ...server, tlsCa: server.tlsMode === "verify" ? server.tlsCa?.trim() || undefined : undefined });
      onConfigurationChange();
      setServerId(saved.id); setServer({ ...server, id: saved.id }); setRows(null);
      const nextDetails = await api.getServerConnection(saved.id); setDetails(nextDetails);
      if (!profile.serverConnectionId) setProfile(current => ({ ...current, serverConnectionId: saved.id }));
      notify("Server connection saved. Its credentials are shared by every assigned database target.");
      if (saved.hasInspectionCredentials) await verify(overview.profiles.filter(item => item.serverConnectionId === saved.id).map(item => item.id));
    }); }}>
      <label>Server label<input required disabled={serverUnavailable} value={server.label} onChange={event => setServer({ ...server, label: event.target.value })} /></label>
      <label>Host<input required disabled={serverUnavailable} autoComplete="off" value={server.host} onChange={event => setServer({ ...server, host: event.target.value })} /></label>
      <label>Port<input required disabled={serverUnavailable} type="number" min={1} max={65535} value={server.port} onChange={event => setServer({ ...server, port: Number(event.target.value) })} /></label>
      <label>TLS<select disabled={serverUnavailable} value={server.tlsMode} onChange={event => setServer({ ...server, tlsMode: event.target.value as DatabaseServerInput["tlsMode"] })}><option value="disabled">Off</option><option value="verify">Verified TLS</option></select></label>
      {server.tlsMode === "verify" && <label className="database-wide">TLS certificate authority (PEM, optional)<textarea disabled={serverUnavailable} value={server.tlsCa ?? ""} onChange={event => setServer({ ...server, tlsCa: event.target.value })} /></label>}
      <p className="database-wide muted">{server.tlsMode === "verify" ? "The certificate must match the server hostname. Leave the authority blank to use system trust." : "TLS is off. The connection is unencrypted; you can enable verified TLS here when the server supports it."} Changing the host or port clears saved credentials. Saving inspection credentials automatically verifies every assigned target.</p>
      <button disabled={serverUnavailable}>Save server connection</button>
    </form>
    <h3>Server credentials</h3>
    <form aria-label="Server credentials" className="database-form" onSubmit={event => { event.preventDefault(); const secret = password; setPassword(""); void perform("Saving protected server credentials", async () => {
      await api.saveServerCredentials(serverId, role, { username, ...(secret || !savedUsername ? { password: secret } : {}) });
      onConfigurationChange();
      setDetails(await api.getServerConnection(serverId)); setRows(null); notify(`${role} credentials saved for this server.`);
      if (role === "inspection") await verify(overview.profiles.filter(item => item.serverConnectionId === serverId).map(item => item.id));
    }); }}>
      <label>Credential purpose<select disabled={unavailable || !serverId} value={role} onChange={event => setRole(event.target.value as DatabaseCredentialRole)}><option value="inspection">Read-only inspection</option><option value="migration">Migration execution</option><option value="diagnostic">Development diagnostics</option></select></label>
      <label>Username<input required disabled={serverUnavailable || !serverId} autoComplete="off" value={username} onChange={event => setUsername(event.target.value)} /></label>
      <label>Password<input type="password" required={!!savedUsername && username !== savedUsername} disabled={serverUnavailable || !serverId} autoComplete="new-password" placeholder={savedUsername ? "Leave blank to keep saved password" : "Password"} value={password} onChange={event => setPassword(event.target.value)} /></label>
      <button disabled={serverUnavailable || !serverId}>Save credentials</button>
    </form>
    <p>Saved roles: inspection {details?.hasInspectionCredentials ? "yes" : "no"}, migration {details?.hasMigrationCredentials ? "yes" : "no"}, diagnostics {details?.hasDiagnosticCredentials ? "yes" : "no"}. Diagnostic credentials must have read-only access to one development database; production targets cannot use them.</p>
    <h2>Discover databases</h2><p>Read the databases visible to this server’s inspection account. Assignment saves local target settings; it does not create databases or history tables.</p>
    <button disabled={serverUnavailable || !serverId || !details?.hasInspectionCredentials} onClick={() => void perform("Discovering available databases", async () => {
      const result = await api.discoverDatabases(serverId);
      setRows(result.databases.map(item => ({ database: item.database, assigned: item.assigned, selected: false, databaseKey: item.database, label: item.database, environment: "" })));
    })}>Discover available databases</button>
    {rows && <div className="database-discovery">
      {rows.length === 0 ? <p>No accessible application databases found.</p> : <>
        <div className="database-actions"><button disabled={unavailable || rows.every(row => row.assigned)} onClick={() => setRows(current => current?.map(row => row.assigned ? row : { ...row, selected: true, environment: row.environment || assignmentEnvironment }) ?? null)}>Select all unassigned</button><button disabled={unavailable || selectedRows.length === 0} onClick={() => setRows(current => current?.map(row => ({ ...row, selected: false })) ?? null)}>Clear selection</button>
          <label>Environment for selected databases<select value={assignmentEnvironment} disabled={unavailable} onChange={event => { const value = event.target.value as DatabaseEnvironment | ""; setAssignmentEnvironment(value); setRows(current => current?.map(row => row.selected && !row.assigned ? { ...row, environment: value } : row) ?? null); }}><option value="">Choose environment</option><option value="dev">Development</option><option value="production">Production</option><option value="sandbox">Isolated sandbox</option></select></label></div>
        <div className="database-table-scroll"><table className="database-discovery-table"><thead><tr><th>Assign</th><th>Database</th><th>Database key</th><th>Target label</th><th>Environment</th></tr></thead><tbody>{rows.map(row => <tr key={row.database}>
          <td>{row.assigned ? <span>Assigned</span> : <input aria-label={`Assign ${row.database}`} type="checkbox" disabled={unavailable} checked={row.selected} onChange={event => selectRow(row.database, event.target.checked)} />}</td><td>{row.database}</td>
          {row.assigned ? <td colSpan={3}>Already assigned to a target</td> : <><td><input aria-label={`Database key for ${row.database}`} disabled={unavailable} value={row.databaseKey} onChange={event => updateRow(row.database, { databaseKey: event.target.value })} /></td><td><input aria-label={`Target label for ${row.database}`} disabled={unavailable} value={row.label} onChange={event => updateRow(row.database, { label: event.target.value })} /></td><td><select aria-label={`Environment for ${row.database}`} disabled={unavailable} value={row.environment} onChange={event => updateRow(row.database, { environment: event.target.value as DatabaseEnvironment | "" })}><option value="">Choose environment</option><option value="dev">Development</option><option value="production">Production</option><option value="sandbox">Isolated sandbox</option></select></td></>}
        </tr>)}</tbody></table></div>
        <button disabled={unavailable || selectedRows.length === 0 || selectedRows.some(row => !row.environment || !row.databaseKey.trim() || !row.label.trim())} onClick={() => void perform("Assigning discovered databases", async () => {
          const saved = await api.assignDatabases(serverId, selectedRows.map(row => ({ serverConnectionId: serverId, database: row.database, databaseKey: row.databaseKey, label: row.label, environment: row.environment as DatabaseEnvironment })));
          onConfigurationChange();
          const names = new Set(saved.map(item => item.database)); setRows(current => current?.map(row => names.has(row.database) ? { ...row, assigned: true, selected: false } : row) ?? null);
          if (saved[0]) onSelectTarget(saved[0]); notify(`Assigned ${saved.length} database targets.`);
          await verify(saved.map(item => item.id));
        })}>Assign selected databases</button>
      </>}
    </div>}
    <h2>Database targets</h2><p>A database key links the development and production versions of one database. The target label is the display name for this particular database and environment.</p>
    <div className="database-actions"><label>Database target<select aria-label="Database target" disabled={busy} value={selectedProfile?.id ?? ""} onChange={event => { const next = overview.profiles.find(item => item.id === event.target.value); if (next) onSelectTarget(next); }}><option value="">Select target</option>{overview.profiles.map(item => <option key={item.id} value={item.id}>{item.databaseKey} · {item.environment.toUpperCase()} · {item.label}</option>)}</select></label><button disabled={unavailable || !selectedProfile} onClick={() => { if (selectedProfile) { setProfile(profileInput(selectedProfile)); setServerId(selectedProfile.serverConnectionId); } }}>Edit selected target</button><button disabled={unavailable} onClick={() => setProfile({ ...initialProfile, serverConnectionId: serverId })}>New database target</button>{profile.id && <span>Editing {profile.label}</span>}</div>
    <form aria-label="Database target settings" className="database-form" onSubmit={(event: FormEvent) => { event.preventDefault(); void perform("Saving protected target", async () => {
      const saved = await api.saveProfile(profile); onConfigurationChange(); setProfile(profileInput(saved)); onSelectTarget(saved); notify("Database target saved."); await verify([saved.id]);
    }); }}>
      <label>Target server connection<select required disabled={busy} value={profile.serverConnectionId} onChange={event => setProfile({ ...profile, serverConnectionId: event.target.value })}><option value="">Select server</option>{overview.servers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
      <label>Database name<input required disabled={busy} value={profile.database} onChange={event => setProfile({ ...profile, database: event.target.value })} /></label>
      <label>Database key<input required disabled={busy} value={profile.databaseKey} onChange={event => setProfile({ ...profile, databaseKey: event.target.value })} /></label>
      <label>Target label<input required disabled={busy} value={profile.label} onChange={event => setProfile({ ...profile, label: event.target.value })} /></label>
      <label>Environment<select disabled={busy} value={profile.environment} onChange={event => setProfile({ ...profile, environment: event.target.value as DatabaseEnvironment })}><option value="dev">Development</option><option value="production">Production</option><option value="sandbox">Isolated sandbox</option></select></label>
      <button disabled={busy || !profile.serverConnectionId}>Save protected target</button>
    </form>
  </>;
}

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
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [verification, setVerification] = useState<DatabaseTargetVerification[]>([]);
  const [identityReview, setIdentityReview] = useState<{ profileId: string; snapshot: SchemaSnapshot } | null>(null);
  const snapshot = identityReview?.profileId === profileId ? identityReview.snapshot : null;
  const [diagnosticPolicy, setDiagnosticPolicy] = useState('{"tables":{}}');
  const [instructions, setInstructions] = useState("");
  const [mcpStatus, setMcpStatus] = useState<DatabaseMcpStatus | null>(null);
  const [mcpError, setMcpError] = useState("");
  const busyRef = useRef(false);
  const selectedProfile = overview.profiles.find(item => item.id === profileId);
  const load = useCallback(async () => {
    const next = await api.overview();
    setOverview(next); setLoaded(true);
    setProfileId(current => next.profiles.some(item => item.id === current) ? current : next.profiles[0]?.id ?? "");
  }, [api]);
  useEffect(() => { void load().catch(cause => setError(errorText(cause))); }, [load]);
  useEffect(() => { if (initialProfileId) setProfileId(initialProfileId); }, [initialProfileId]);
  useEffect(() => { setIdentityReview(null); setInstructions(""); setDiagnosticPolicy('{"tables":{}}'); }, [profileId]);
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
    setBusy("Verifying database connections");
    const results: DatabaseTargetVerification[] = [];
    for (let offset = 0; offset < ids.length; offset += 100) results.push(...await api.verifyTargets(ids.slice(offset, offset + 100)));
    setVerification(current => [...current.filter(item => !ids.includes(item.profileId)), ...results]);
    onConfigurationChange?.();
  }
  function configurationChanged() {
    setIdentityReview(null); setInstructions(""); setVerification([]); onConfigurationChange?.();
  }
  return <section className="database-workspace database-settings" aria-label="Database settings">
    <h2>Local MCP server</h2>
    <label className="inline-check"><input type="checkbox" checked={mcpEnabled} onChange={event => onMcpEnabledChange(event.target.checked)} />Start the development MCP server automatically</label>
    <p className="muted">Save Settings to apply this switch. Agents connect through a token-protected server on this computer. Only explicitly enrolled development databases and approved read access are available.</p>
    <p role="status">{mcpStatus ? mcpStatus.running ? `MCP server running · ${mcpStatus.url ?? "localhost"}` : mcpStatus.enabled ? "MCP server is not running" : "MCP server disabled" : "Checking MCP server…"}</p>
    {(mcpError || mcpStatus?.error) && <p role="alert" className="issue-box">{mcpError || mcpStatus?.error}</p>}
    <button disabled={!mcpStatus?.running} onClick={() => void perform("Copying MCP configuration", async () => { await window.repoRadar.copyDatabaseMcpConfig(); setNotice("MCP configuration copied. It includes the private connection token; paste it only into your agent configuration."); })}>Copy MCP configuration</button>
    {error && <p role="alert" className="issue-box">{error}</p>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">{busy}…</p>}
    {!loaded ? <p>Loading database setup…</p> : <>
      <ConnectionSetup api={api} overview={overview} selectedProfile={selectedProfile} busy={!!busy} perform={perform} notify={setNotice} onConfigurationChange={configurationChanged} onSelectTarget={profile => setProfileId(profile.id)} verify={verify} />
      <h2>Connection verification</h2><p>Connections are verified automatically after saving targets or inspection credentials. An unexpected change to an established identity needs your review.</p>
      <button disabled={!!busy || !overview.profiles.length} onClick={() => void perform("Verifying all connections", () => verify(overview.profiles.map(item => item.id)))}>Verify all connections</button>
      <ul aria-label="Connection verification results">{overview.profiles.map(profile => {
        const result = verification.find(item => item.profileId === profile.id);
        return <li key={profile.id}>{profile.label} · {profile.environment} · {result ? result.status === "verified" ? "Verified" : "Verification failed" : profile.identity ? "Verified" : "Not yet verified"}{result?.message && <span className={result.status === "failed" ? "issue-box" : ""}> · {result.message}</span>}{profile.identity && <details><summary>Saved identity for {profile.label}</summary><p>{profile.identity.engine} {profile.identity.version} · {profile.identity.database}</p><code className="database-digest">{profile.identity.fingerprint}</code></details>}{result?.status === "failed" && <button disabled={!!busy} onClick={() => { setProfileId(profile.id); void perform("Inspecting identity for review", async () => { setIdentityReview({ profileId: profile.id, snapshot: await api.inspect(profile.id) }); }); }}>Review identity for {profile.label}</button>}</li>;
      })}</ul>
      {snapshot && selectedProfile && <article className="database-card" aria-label="Target identity review"><h3>Review identity · {selectedProfile.label}</h3><p>Only accept this identity if it is the intended database. Accepting replaces the saved binding for this target.</p><p>{snapshot.identity.engine} {snapshot.identity.version} · {snapshot.identity.database}</p><code className="database-digest">{snapshot.identity.fingerprint}</code><pre>{JSON.stringify(snapshot.identity.settings, null, 2)}</pre><button disabled={!!busy} onClick={() => void perform("Accepting reviewed target identity", async () => { await api.acceptIdentity(identityReview!.profileId, snapshot.identity.fingerprint); setIdentityReview(null); await verify([selectedProfile.id]); })}>Accept reviewed identity</button><button disabled={!!busy} onClick={() => setIdentityReview(null)}>Cancel identity review</button></article>}
      <h2>Development diagnostic access</h2><p>Configure the target selected above. Allow specific base tables and columns; views, routines, writes and production access are unavailable.</p><label>Allowed tables and columns (JSON)<textarea aria-label="Diagnostic read policy" rows={4} value={diagnosticPolicy} onChange={event => setDiagnosticPolicy(event.target.value)} /></label><button disabled={!!busy || selectedProfile?.environment !== "dev"} onClick={() => void perform("Configuring development diagnostics", async () => { const result = await api.configureDiagnostics({ profileId, policy: JSON.parse(diagnosticPolicy) }); setInstructions(result.instructions); })}>Configure dev-only MCP</button>{instructions && <pre>{instructions}</pre>}
    </>}
  </section>;
}
