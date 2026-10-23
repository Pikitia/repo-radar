import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DatabaseOverview, DatabasePlanInput } from "../types/databaseApi.js";
import type { DatabaseHistory, MigrationPlan } from "../types/databaseExecution.js";
import type { RepoStatus } from "../types/repo.js";
import { SchemaDifferences, type SchemaComparisonGroup } from "./SchemaDifferences.js";
import "../databases.css";

interface Props { active: boolean; root: string | null; repos: RepoStatus[]; onOpenRepository(repo: RepoStatus): void; onOpenCi?(): void; onMessage?(message: string): void; onOpenSettings?(profileId?: string): void; configurationVersion?: number }
const empty: DatabaseOverview = { servers: [], profiles: [], proposals: [], releases: [], rehearsals: [], activeRun: null, lastRun: null };
const sections = ["Overview", "Migrations", "Schema differences", "History"] as const;
type Section = typeof sections[number];
function errorText(error: unknown): string { return error instanceof Error ? error.message : "Database operation failed"; }

export function Databases({ active, root, repos, onOpenRepository, onOpenCi, onMessage, onOpenSettings, configurationVersion }: Props) {
  const [overview, setOverview] = useState<DatabaseOverview>(empty);
  const [section, setSection] = useState<Section>("Overview");
  const [databaseKey, setDatabaseKey] = useState("");
  const [profileId, setProfileId] = useState("");
  const [sandboxId, setSandboxId] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [comparisons, setComparisons] = useState<Record<string, Pick<SchemaComparisonGroup, "comparison" | "error" | "loading">>>({});
  const [history, setHistory] = useState<DatabaseHistory | null>(null);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [repositoryPath, setRepositoryPath] = useState("");
  const [manifestPath, setManifestPath] = useState("db/migrations/example/migration.json");
  const [kind, setKind] = useState<DatabasePlanInput["kind"]>("execute");
  const [direction, setDirection] = useState<"up" | "down">("up");
  const [migrationIds, setMigrationIds] = useState<string[]>([]);
  const [library, setLibrary] = useState("");
  const busyRef = useRef(false);
  const generation = useRef(0);
  const comparisonGeneration = useRef(0);
  const knownIdentities = useRef(new Map<string, string | undefined>());
  const api = window.repoRadar.databases;
  const keys = useMemo(() => [...new Set(overview.profiles.map(item => item.databaseKey))].sort(), [overview.profiles]);
  const comparisonKeys = keys.filter(key => overview.profiles.some(profile => profile.databaseKey === key && profile.environment !== "sandbox"));
  const comparisonConfiguration = JSON.stringify([
    overview.profiles.map(({ id, databaseKey, environment, serverConnectionId, database }) => ({ id, databaseKey, environment, serverConnectionId, database })).sort((a, b) => a.id.localeCompare(b.id)),
    overview.servers.map(({ id, host, port, tlsMode }) => ({ id, host, port, tlsMode })).sort((a, b) => a.id.localeCompare(b.id))
  ]);
  const comparisonGroups: SchemaComparisonGroup[] = comparisonKeys.map(key => ({
    databaseKey: key,
    devDatabase: overview.profiles.find(profile => profile.databaseKey === key && profile.environment === "dev")?.database,
    productionDatabase: overview.profiles.find(profile => profile.databaseKey === key && profile.environment === "production")?.database,
    ...comparisons[key]
  }));
  const selectedProfile = overview.profiles.find(item => item.id === profileId);
  const profiles = overview.profiles.filter(item => item.databaseKey === databaseKey);
  const release = overview.releases.filter(item => item.databaseKey === databaseKey).at(-1);
  const proposals = overview.proposals.filter(item => item.manifest.databaseKey === databaseKey);
  const orderedIds = (release?.migrations ?? []).filter(item => migrationIds.includes(item.id)).map(item => item.id);
  if (direction === "down") orderedIds.reverse();
  const statuses = useMemo(() => {
    const result = new Map<string, string>();
    const attempts = new Map<string, { migrationId: string; direction?: "up" | "down" }>();
    for (const event of history?.events ?? []) {
      if (event.kind === "adoption" && event.migrationId) result.set(event.migrationId, "adopted");
      if (event.kind === "attempt-start" && event.attemptId && event.migrationId) { attempts.set(event.attemptId, { migrationId: event.migrationId, direction: event.direction }); result.set(event.migrationId, "blocked / running"); }
      if (event.kind === "attempt-end" && event.attemptId) { const attempt = attempts.get(event.attemptId); if (attempt) result.set(attempt.migrationId, event.state === "succeeded" ? attempt.direction === "down" ? "reverted" : "applied" : `blocked / ${event.state ?? "uncertain"}`); }
    }
    return result;
  }, [history]);
  const migrationStatus = (id: string) => statuses.get(id) ?? (history?.enrolled ? "pending" : "unknown — load enrolled target history");
  const load = useCallback(async () => {
    if (!api) throw new Error("Database features are unavailable in this app build");
    const next = await api.overview();
    setOverview(next);
    setDatabaseKey(current => current && next.profiles.some(item => item.databaseKey === current) ? current : next.profiles[0]?.databaseKey ?? "");
  }, [api]);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const refresh = () => { if (!busyRef.current) void load().catch(cause => { if (!cancelled) setError(errorText(cause)); }); };
    refresh();
    const timer = window.setInterval(refresh, 15_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [active, load, configurationVersion]);
  useEffect(() => {
    generation.current++;
    setPlan(null); setHistory(null); setMigrationIds([]);
  }, [databaseKey, root, configurationVersion]);
  useEffect(() => {
    comparisonGeneration.current++;
    setComparisons({});
    return () => { comparisonGeneration.current++; };
  }, [root, comparisonConfiguration, configurationVersion]);
  useEffect(() => {
    const changed = overview.profiles.some(profile => { const old = knownIdentities.current.get(profile.id); return old && old !== profile.identity?.fingerprint; });
    knownIdentities.current = new Map(overview.profiles.map(profile => [profile.id, profile.identity?.fingerprint]));
    if (changed) { comparisonGeneration.current++; setComparisons({}); }
  }, [overview.profiles]);
  useEffect(() => {
    setProfileId(current => overview.profiles.some(item => item.id === current && item.databaseKey === databaseKey) ? current : overview.profiles.find(item => item.databaseKey === databaseKey && item.environment !== "sandbox")?.id ?? "");
  }, [overview.profiles, databaseKey]);
  useEffect(() => { generation.current++; setHistory(null); setPlan(null); }, [profileId]);
  useEffect(() => { setPlan(null); }, [kind, direction, migrationIds]);
  useEffect(() => { if (!repos.some(repo => repo.absolutePath === repositoryPath)) setRepositoryPath(repos[0]?.absolutePath ?? ""); }, [repos, repositoryPath]);

  async function perform(label: string, action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(label); setError(""); setNotice("");
    try { await action(); await load(); }
    catch (cause) { setError(errorText(cause)); if (label === "Running reviewed database plan") onMessage?.(`Database operation stopped: ${errorText(cause)}`); }
    finally { busyRef.current = false; setBusy(""); }
  }
  function notify(message: string) { setNotice(message); onMessage?.(message); }
  function invalidateComparisons() { comparisonGeneration.current++; setComparisons({}); }
  async function compareDatabases(requestedKeys: string[]) {
    const token = comparisonGeneration.current;
    const failures: string[] = [];
    setComparisons(current => ({ ...current, ...Object.fromEntries(requestedKeys.map(key => [key, { loading: true }])) }));
    for (const key of requestedKeys) {
      if (token !== comparisonGeneration.current) return;
      try {
        const comparison = await api.compare(key);
        if (token !== comparisonGeneration.current) return;
        setComparisons(current => ({ ...current, [key]: { comparison } }));
      } catch (cause) {
        if (token !== comparisonGeneration.current) return;
        failures.push(key);
        setComparisons(current => ({ ...current, [key]: { error: errorText(cause) } }));
      }
    }
    if (failures.length) throw new Error(`Comparison failed for ${failures.join(", ")}. Expand the database groups for details.`);
  }
  const targetLabel = selectedProfile ? `${selectedProfile.environment.toUpperCase()} · ${selectedProfile.label}` : "Select a target";
  const noTarget = !selectedProfile || !!busy;

  return <main className="database-workspace" aria-label="Database management">
    {overview.submissionErrors?.map(item => <p className="issue-box" role="status" key={item.proposalId}>Agent submission needs attention: {item.message}</p>)}
    <header className="database-heading"><div><h1>Databases</h1><p className="muted">Review structure, prepare ordered releases and run migrations with recovery evidence.</p></div><div className="database-actions"><button onClick={() => onOpenSettings?.()}>Configure databases</button><button disabled={!!busy} onClick={() => void perform("Refreshing", async () => { await load(); })}>Refresh databases</button></div></header>
    <div className="database-controls"><label>Logical database<select aria-label="Logical database" value={databaseKey} onChange={event => setDatabaseKey(event.target.value)}><option value="">Select database</option>{keys.map(key => <option key={key}>{key}</option>)}</select></label><label>Target<select aria-label="Database target" value={profileId} onChange={event => setProfileId(event.target.value)}><option value="">Select target</option>{profiles.map(item => <option key={item.id} value={item.id}>{item.environment.toUpperCase()} · {item.label}</option>)}</select></label><span className={`database-environment database-${selectedProfile?.environment ?? "none"}`}>{targetLabel}</span></div>
    {error && <div role="alert" className="issue-box">{error}</div>}{notice && <p role="status">{notice}</p>}{busy && <p role="status">{busy}…</p>}
    {overview.activeRun && <p className="database-run" role="status">Migration in progress: {overview.activeRun.message} · {overview.activeRun.targetId}. Switching tabs keeps the run active.</p>}
    <nav aria-label="Database sections" className="database-sections">{sections.map(value => <button key={value} aria-pressed={section === value} className={section === value ? "active" : ""} onClick={() => setSection(value)}>{value}</button>)}</nav>
    {section === "Overview" && <section aria-label="Database overview"><h2>Registered targets</h2>{overview.profiles.length === 0 ? <p>No databases registered. Add development and production targets in Settings → Databases.</p> : <div className="database-cards">{overview.profiles.map(item => <article className="database-card" key={item.id}><h3>{item.label} <span className={`database-environment database-${item.environment}`}>{item.environment}</span></h3><p>{item.databaseKey}</p><p>{item.identity ? `${item.identity.engine} ${item.identity.version} · ${item.identity.database}` : "Connection not verified"}</p>{item.identity && <code className="database-digest">{item.identity.fingerprint}</code>}<button onClick={() => { onOpenSettings?.(item.id); }}>Configure {item.label}</button></article>)}</div>}<h2>Release readiness</h2><p>{release ? `${release.migrations.length} migrations in the sealed release. Execution status comes from each target's database history.` : "No sealed release for this database."}</p>{overview.rehearsals.filter(item => item.databaseKey === databaseKey).map(item => <p key={item.evidenceId}>{item.assessment} rehearsal · expires {new Date(item.expiresAt).toLocaleString()} · {item.notes.join("; ")}</p>)}{overview.lastRun && <p>Last run: {overview.lastRun.state}{overview.lastRun.errorCode ? ` · ${overview.lastRun.errorCode}` : ""}</p>}<button onClick={() => setSection("History")}>Review target history and plan</button></section>}
    {section === "Migrations" && <section aria-label="Migration library"><h2>Import service migrations</h2><p>Sources must belong to a discovered repository. Import freezes all SQL, checks and recovery files; deployment links are advisory.</p><div className="database-form"><label>Source repository<select aria-label="Source repository" value={repositoryPath} onChange={event => setRepositoryPath(event.target.value)}><option value="">Select repository</option>{repos.map(repo => <option value={repo.absolutePath} key={repo.id}>{repo.name}</option>)}</select></label><label>Manifest relative path<input value={manifestPath} onChange={event => setManifestPath(event.target.value)} /></label><button disabled={!root || !repositoryPath || !!busy} onClick={() => void perform("Importing migration", async () => { const result = await api.importProposal(repositoryPath, manifestPath); notify(`Imported ${result.manifest.id} (${result.status}).`); })}>Import migration</button></div><button disabled={!databaseKey || !!busy} onClick={() => void perform("Sealing ordered release", async () => { const result = await api.sealRelease(databaseKey); setPlan(null); notify(`Sealed ${result.migrations.length} ordered migrations.`); })}>Seal ordered release</button>{release && <ol>{release.migrations.map(item => <li key={item.id}>#{item.sequence} {item.id} · {migrationStatus(item.id)} <code>{item.contentDigest}</code></li>)}</ol>}{proposals.map(proposal => { const repo = repos.find(item => item.absolutePath === proposal.source.repositoryPath); return <details className="database-card" key={proposal.proposalId}><summary>{proposal.manifest.title} · {proposal.status} · {proposal.manifest.id}</summary><p>Source: {proposal.manifest.service} · {proposal.source.commit ?? "Uncommitted"}{proposal.source.dirty ? " · local changes" : ""}</p><code className="database-digest">{proposal.contentDigest}</code>{repo && <button onClick={() => onOpenRepository(repo)}>Open source repository</button>}{onOpenCi && <button onClick={onOpenCi}>Open CI Watch</button>}<p>Application compatibility: {proposal.manifest.applicationCompatibility}</p><p>Data impact: {proposal.manifest.dataImpact.description} · Locking: {proposal.manifest.dataImpact.locking}{proposal.manifest.dataImpact.destructive ? " · DESTRUCTIVE" : ""}{proposal.manifest.dataImpact.requiresWritePause ? " · Requires write pause" : ""}</p><p>Recovery: {proposal.manifest.recovery.mode} · {proposal.manifest.recovery.rollbackRoute} · {proposal.manifest.recovery.applicationCompatibility}</p>{proposal.validationWarnings.map(warning => <p key={warning} className="issue-box">{warning}</p>)}{Object.entries(proposal.files).map(([name, sql]) => <details key={name}><summary>{name}</summary><pre>{sql}</pre></details>)}</details>; })}<h3>Portable migration library</h3><p>Exports contain scripts and source references; database credentials and snapshots are excluded.</p><textarea aria-label="Migration library JSON" rows={4} value={library} onChange={event => setLibrary(event.target.value)} /><div className="database-actions"><button disabled={!!busy} onClick={() => void perform("Exporting library", async () => { setLibrary(await api.exportLibrary()); })}>Export library</button><button disabled={!library || !!busy} onClick={() => void perform("Importing library", async () => { await api.importLibrary(library); setPlan(null); notify("Library imported and validated."); })}>Import library JSON</button></div></section>}
    {section === "Schema differences" && <section aria-label="Schema comparison">
      <h2>Development and production structure</h2>
      <div className="database-actions">
        <button disabled={!comparisonKeys.includes(databaseKey) || !!busy} onClick={() => void perform("Comparing selected database", () => compareDatabases([databaseKey]))}>Compare development and production</button>
        <button disabled={comparisonKeys.length === 0 || !!busy} onClick={() => void perform("Comparing all databases", () => compareDatabases(comparisonKeys))}>Compare all databases</button>
      </div>
      <SchemaDifferences groups={comparisonGroups} />
    </section>}
    {section === "History" && <section aria-label="Database execution history"><h2>History and reviewed execution</h2><p>Target: <strong>{targetLabel}</strong>. Setup writes reserved history tables only after a reviewed plan and native confirmation. Adoption records a baseline; it does not claim old scripts ran.</p><button disabled={noTarget} onClick={() => void perform("Reading history", async () => { const token = generation.current; const result = await api.history(profileId); if (token === generation.current) setHistory(result); })}>Load target history</button>{history && <><p>{history.enrolled ? "History enrolled" : "History not enrolled — existing schema is not an empty baseline"} · {history.events.length} events</p><code className="database-digest">History digest: {history.digest}</code><div className="database-history">{history.events.map(event => <details key={event.eventId}><summary>{event.at} · {event.kind} · {event.migrationId ?? "baseline"} · {event.state ?? ""}</summary><pre>{JSON.stringify(event, null, 2)}</pre></details>)}</div></>}
      <h3>Build a plan</h3><div className="database-controls"><label>Operation<select value={kind} onChange={event => setKind(event.target.value as DatabasePlanInput["kind"])}><option value="execute">Execute migrations</option><option value="enroll">Set up history tables</option><option value="adopt">Adopt reviewed baseline</option></select></label><label>Direction<select value={direction} onChange={event => setDirection(event.target.value as "up" | "down")}><option value="up">Apply in release order</option><option value="down">Recover in reverse order</option></select></label></div><p>Select the migrations for this plan. The runner enforces a valid ordered prefix or reverse suffix.</p><button disabled={!release || !!busy || kind === "enroll"} onClick={() => setMigrationIds(release?.migrations.filter(item => direction === "up" ? migrationStatus(item.id) === "pending" || migrationStatus(item.id) === "reverted" : ["applied", "adopted"].includes(migrationStatus(item.id))).map(item => item.id) ?? [])}>Select all pending / applied migrations</button>{release?.migrations.map(item => <label className="database-check" key={item.id}><input type="checkbox" checked={migrationIds.includes(item.id)} onChange={event => setMigrationIds(current => event.target.checked ? [...current, item.id] : current.filter(id => id !== item.id))} />#{item.sequence} {item.id} · {migrationStatus(item.id)}</label>)}<button disabled={noTarget || selectedProfile?.environment === "sandbox"} onClick={() => void perform("Preparing reviewed plan", async () => { const token = generation.current; const result = await api.createPlan({ profileId, kind, direction, migrationIds: kind === "enroll" ? [] : orderedIds }); if (token === generation.current) setPlan(result); })}>Review execution plan</button>
      {plan && <article className="database-plan" aria-label="Reviewed migration plan"><h3>Review before running</h3>{plan.reviewSummary && <pre aria-label="Execution plan safety review">{plan.reviewSummary}</pre>}<dl><dt>Target</dt><dd>{targetLabel} · {plan.targetId}</dd><dt>Operation</dt><dd>{plan.kind} · {plan.direction} · {plan.statementCount} statements</dd><dt>Migration order</dt><dd>{plan.migrationIds.join(" → ") || "History setup / baseline"}</dd><dt>Release digest</dt><dd><code>{plan.releaseDigest}</code></dd><dt>Current schema digest</dt><dd><code>{plan.beforeSchemaDigest}</code></dd><dt>History digest</dt><dd><code>{plan.historyDigest}</code></dd><dt>Recovery evidence</dt><dd>{plan.recoveryEvidenceIds.join(", ") || "No migration statements"}</dd><dt>Expires</dt><dd>{new Date(plan.expiresAt).toLocaleString()}</dd></dl><p>Run opens a separate native confirmation. Admission rechecks the target, history, schema and recovery evidence under a database lock.</p><button disabled={!!busy || Date.parse(plan.expiresAt) <= Date.now()} onClick={() => void perform("Running reviewed database plan", async () => { const id = plan.planId; setPlan(null); onMessage?.(`Database operation started: ${targetLabel}. Keep Repo Radar open.`); const result = await api.runPlan(id); setHistory(null); invalidateComparisons(); notify(`Database run ${result.state}${result.errorCode ? `: ${result.errorCode}` : ""}. Review target history before further work.`); })}>Run reviewed plan</button><button disabled={!!busy} onClick={() => setPlan(null)}>Discard plan</button></article>}
      <h3>Isolated rehearsal and restore evidence</h3><label>Sandbox target<select aria-label="Sandbox target" value={sandboxId} onChange={event => setSandboxId(event.target.value)}><option value="">Select isolated sandbox</option>{overview.profiles.filter(item => item.environment === "sandbox").map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select></label><p>Rehearse uses a separate empty database on an isolated instance and applies SQL there. A restored sandbox is for external restore verification and must already be restored by the operator.</p><div className="database-actions"><button disabled={!databaseKey || !sandboxId || !!busy} onClick={() => void perform("Rehearsing isolated database", async () => { const result = await api.rehearse(databaseKey, sandboxId); setPlan(null); notify(`Rehearsal ${result.assessment}: ${result.notes.join("; ")}`); })}>Rehearse on empty sandbox</button><button disabled={noTarget || !sandboxId} onClick={() => void perform("Recording verified restore", async () => { const result = await api.recordRestoreVerification(profileId, sandboxId); setPlan(null); notify(`Recorded ${result.evidenceIds.length} target-bound restore evidence records.`); })}>Record verified external restore</button></div></section>}
  </main>;
}
