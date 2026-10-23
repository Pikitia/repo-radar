# Databases in Repo Radar

The Databases workspace sits beside Repositories and CI Watch. It collects service-owned migration proposals into one ordered release per logical database, shows dev/production structure, and keeps execution separate from Git and deployment actions.

## Connections and first use

Open **Settings → Databases** to manage connections. Select a server from the tabs on the left, or use **＋ Add connection**. **Edit connection** opens its name, host, port, TLS and credentials. Several databases can share a connection, including development and production schemas. The credentials grid shows all three purposes, a setup tick, and individual **Edit** and **Check** actions. Check tests sign-in with the saved account; it does not prove migration permissions or diagnostic access. Saved passwords stay masked: leave the password field blank to keep one, or enter a replacement. Changing a username requires a replacement password. Changing host or port clears saved credentials and accepted identities so they cannot be silently sent to another server.

The selected server's database grid shows saved targets, their environments, identification and current availability checks. **Rescan databases** adds schemas visible to the inspection account; system schemas are excluded. Select unassigned databases, review their keys, labels and environments, then assign them together. Discovery and assignment do not create schemas or migration-history tables. **Add database manually** registers a target directly. A row's **Edit** opens its database, server, key, label and environment settings. Saved identification alone does not show current availability: use the row's **Check**, or **Check databases** for this server.

Create development and production targets under the same **database key**, a stable logical name such as `catalog` that also appears in migration manifests. Their actual database names can differ. The **target label** is the friendly display name, such as `Catalog production`. Several service repositories can share a key. Use a separate sandbox target for a disposable database on a different server instance. Rehearsal requires an empty database and matching engine, version and relevant settings; it never creates a scratch schema on production.

Enter inspection, migration and development diagnostic credentials separately for each server connection. Saved details and credentials use Electron's protected Windows storage in Repo Radar's application-data directory. Password entry is write-only. Ordinary app settings and exports do not contain database credentials. Existing protected target settings upgrade locally, retaining target IDs, identities and history associations; equivalent endpoints with identical credential sets share a server entry. An encrypted version-1 backup is retained on the first settings write. Connections with different accounts stay separate.

The development MCP has a separate configuration and cannot load the desktop's production profiles or evidence. Sharing a physical server does not grant diagnostic access to production: the chosen target must be development and the diagnostic account must have restricted read grants for that single development database.

The protected database store lives in `%APPDATA%\repo-radar\repo-radar-databases`. Desktop startup preserves any surviving store from the older `databases` folder before opening its window. If both folders contain application stores, startup stops for review rather than overwriting either. Earlier builds used a folder Chromium removes during startup; settings already deleted by that behavior cannot be reconstructed by this migration and must be re-entered. This local-storage defect did not change the managed databases or migration scripts in service repositories.

TLS is optional and defaults to **Off** for new connections. Enable **Verified TLS** when the server supports certificates; provide a custom certificate authority PEM if needed, or leave it blank to use system trust. Verification checks the certificate and hostname, so use a certificate hostname rather than an IP address. Existing saved CA settings retain verified TLS. Arrange private-subnet, VPN or bastion/tunnel access separately and use its reachable endpoint. Server and credential edits revoke reviewed migration plans, rehearsal/restore evidence and the saved diagnostic projection.

Saving or assigning targets and saving inspection credentials automatically verifies their initial identities. First comparison, history inspection, plan preparation and diagnostic setup also verify targets as needed. Results and failures appear in the database grid. Verification uses read-only observations and saves the binding locally; it does not create history tables or infer that scripts have run. Unexpected changes to an established server/database/engine/version/settings binding stop the operation. Failed rows provide an explicit identity review; accepting a replacement remains deliberate. Database writes retain their reviewed plan, current identity checks and native confirmation.

History setup is a separate reviewed operation: it creates `db_radar_enrollment` and `db_radar_events` in the selected managed database. Review the environment, identity, schema digest and native confirmation. Existing business structure is the initial baseline. Missing history never means an empty database. Baseline adoption records a reviewed existing prefix as adoption events, preserving the distinction from scripts executed by the tool.

## Schema differences

Use **Compare development and production** for the selected logical database, or **Compare all databases** to compare each registered logical database. Comparisons run only when requested. Each database has a compact summary showing displayed and hidden difference counts. Expand a database to see its table groups. Expanding a table immediately shows a compact list with each column/object name and a short description, such as `Type: "int" → "bigint"` or `Only in development`. One-sided tables, one-sided columns and actual type differences appear first. Changes read **production → development** and describe observed states. Expand a row's **Details** for original definitions and any migration IDs. Table summaries show change counts. Views, routines and objects whose table cannot be established remain clearly identified separately. Groups and row details start collapsed; refreshed results start collapsed again. Changing the selected logical database retains other results.

Comparison normalizes known integer metadata representations, such as column position `1` versus `"1"`, and absent generation expressions represented as an empty string versus null on nongenerated columns. Actual default values, generated expressions, column types, collations and structural changes remain significant. Limited visibility and different engines, versions or settings still produce coverage warnings even when equivalent metadata no longer appears as a difference. The normalized schema bytes also determine its digest; older rehearsal evidence whose digests no longer match needs fresh rehearsal rather than being silently reused.

Coverage limitations sit behind the red **Coverage warnings** button with a total count and database names. Hiding a warning does not change the result: incomplete metadata stays unverified. A failed comparison is shown separately with unavailable counts, and does not prevent the other databases from being compared. Configuration/root changes and migration execution clear earlier comparison results.

One **Show all differences** control sits above all database groups and counts hidden rows across every result. Default Review hides recognized metadata representation differences and two-sided raw table SQL rows. Tables with no remaining rows disappear completely; **Show all differences** restores every original row and table group, and **Hide noise** applies Review across all databases again. Refreshed comparisons return to Review. Repeated version, capture-time, history-exclusion and verification-status text is omitted from the comparison list. Engine versions and verification evidence are still captured internally; version detection uses `VERSION()` and requires no additional inspection grants.

The presentation filter recognizes complete column metadata on supported MySQL 8 and MariaDB 10.6+/11 versions: integer display-width changes with the same base type and signedness (excluding `ZEROFILL` and `tinyint(1)`), equivalent unquoted `CURRENT_TIMESTAMP` default and `ON UPDATE` spellings with matching precision and MySQL's `DEFAULT_GENERATED` annotation, and MariaDB's unquoted text `NULL` versus MySQL SQL null on the same nullable storage type. Recognized width and NULL differences can be combined. Matching `ON UPDATE` spelling is checked independently of the default, so a nullable NULL default can also be combined with it. Every changed metadata field must be accounted for. Unknown or mixed substantive metadata changes, missing metadata, quoted literals, actual defaults, nullability, character sets, collations and generated expressions stay visible. `LONGTEXT` versus native `JSON` stays visible because storage and validation can differ.

Foreign-key `RESTRICT` and `NO ACTION` metadata differences are hidden only when captured table metadata confirms InnoDB on both sides and all other foreign-key fields match. Other storage engines or missing engine information keep the difference visible. Two-sided raw `CREATE TABLE` rows are excluded from Review as an operator-selected display preference, even when the full SQL differs materially; this is not an equivalence claim. Their complete bytes, including constraints and table options, remain available in Show all. One-sided table definitions remain in Review so a missing table is not suppressed. Separately captured table, column, index and foreign-key metadata differences are still filtered by their own rules.

This is a presentation filter only. Original definitions, schema digests, migration assessments and execution safeguards are unchanged. Zero review differences does not prove complete visibility, equivalent cross-engine behavior or that a data-only migration ran. Target history and verified replay evidence remain separate from the displayed list.

With incomplete visibility, one-sided rows say **Present in development; not reported in production** (or the reverse), and missing full definitions say **Not reported (limited coverage)**. This avoids treating an object hidden by permissions as definitely absent. **Only in…** and **Absent** require complete coverage. Production read permissions can limit object visibility; different engines, versions and database settings are separate limitations. Neither requires hiding detected differences in visible objects.

## Authoring and reviewing a migration

Keep `db/migrations/<name>/migration.json` and its SQL/runbook files in the service repository. References are relative to the manifest directory and must resolve inside that repository. Existing SQL elsewhere can be referenced by an explicit manifest without moving it. Import through Databases or submit through the dev MCP. Repo Radar copies the complete artifact bytes, records source revision/dirty state and computes an immutable digest.

This minimal manifest illustrates the format; adjust the service, logical key, engine and compatibility to the real change:

```json
{
  "formatVersion": 1,
  "id": "example-service/add-reference-v1",
  "title": "Store an optional order reference",
  "databaseKey": "modern",
  "service": "example-service",
  "dependsOn": [],
  "engine": {
    "product": "mysql",
    "minVersion": "8.0.16",
    "requiredSettings": {},
    "storageEngines": ["InnoDB"]
  },
  "up": ["up.sql"],
  "preconditions": [],
  "postconditions": [],
  "recovery": {
    "mode": "down",
    "down": ["down.sql"],
    "eligibilityChecks": [{ "path": "down-eligible.sql", "expect": "empty" }],
    "runbook": "recovery.md",
    "applicationCompatibility": "Only the release identified in the review",
    "rollbackRoute": "tested-down"
  },
  "dataImpact": {
    "description": "Describe possible data loss in both directions, including values written after application",
    "destructive": false,
    "requiresWritePause": true,
    "locking": "ALTER TABLE may block writers; review actual table size and server support"
  },
  "applicationCompatibility": "Apply before enabling the corresponding application writer",
  "expectedSchemaChanges": [
    { "objectType": "column", "objectPath": "orders.reference", "description": "Optional reference" }
  ]
}
```

Checks use `{ "path": "check.sql", "expect": "empty" }`, `nonempty`, or `scalar-equals` with a typed `value`. They contain one supported read-only query. They are assertions, not documentation: a failing or unsupported check blocks execution.

Cross-service dependencies use exact migration IDs. Sealing orders a complete dependency graph with deterministic tie breaking and consecutive sequence numbers. A new release appends to the previous release. Sealed IDs/content cannot be edited; corrections use a new ID. Switching branches cannot change an imported snapshot. Export/import the immutable library to recover its scripts on another installation; import requires an empty destination and validates digests/order. Database history remains in each target.

## Rehearsal, differences and execution

Choose an enrolled isolated sandbox and run rehearsal. Repo Radar recreates the observed structure without copying production rows, applies the exact pending prefix and compares the result with development. It records each migration's structural changes and checks eligible up/down/up paths. Temporary fixture tables created in that initially empty sandbox are removed afterward. Do not use the sandbox concurrently from other tools.

Differences are `explained`, `unexplained`, or `unverified`. A manifest's claimed changes never prove an explanation. Incomplete metadata permissions, changing schema, engine/settings differences, unsupported SQL and data-dependent checks prevent a clean claim. Routine visibility may require MySQL `SHOW_ROUTINE` or equivalent privileges; table-level SELECT alone cannot prove that no hidden objects exist. Tool history objects are explicitly excluded from the business-schema comparison.

The first SQL execution adapter supports a constrained set of table/index changes and direct data statements. It lexes SQL literals/comments and `DELIMITER` directives, then rejects unsupported statements before writing. Stored procedures, triggers, views, dynamic SQL, privileged/server operations, cross-schema access and SQL requiring unsupported quoting are blocked. This includes some existing historical scripts. The UI must not imply those scripts are safe to run through this adapter.

Review a plan for the next exact prefix, then use Run and its native confirmation. The plan binds the target, release, script digests, current schema/history and evidence expiry. A database-wide lock serializes cooperating runners. Production additionally requires successful execution of identical bytes on dev and fresh explained structural evidence. CI success does not satisfy these checks, and Git/CI actions never run migrations automatically.

MySQL/MariaDB schema statements can commit independently. The app records statement intent/outcomes and stops on failure or lost acknowledgment. An uncertain outcome is not retried automatically. Keep the app open until an operation completes; a forced process termination leaves journal evidence for reconciliation. Never delete history or manufacture a success record to unlock a failed run.

## Recovery limits

Run requires a current tested rollback route. An eligible down path is rehearsed, applied in reverse dependency order, and checked against its expected preceding structure. Down does not delete up history. A structural rehearsal does not prove that destructive rollback preserves rows or newly written business values. Conditional downs and restore-only migrations remain blocked without applicable tested restore evidence; a runbook or an unchecked “backup exists” flag cannot unlock them.

Data-changing migrations cannot receive execution evidence from the current schema-only rehearsal adapter: they require a sanitized data-fixture verifier. This prevents an empty fixture's no-op UPDATE/DELETE from being misrepresented as proof that real rows can be restored. The runner's transaction behavior is independently covered by stateful mock tests.

Backups, actual restore operations, write pauses, deployment compatibility and operational reconciliation need the operator's real environment and evidence. Existing receipt/provenance tables that cannot safely be dropped must stay protected. Forward repairs or retaining additive schema may be safer incident responses, but do not replace the required rollback route. Any restore procedure must account for all affected services in a shared database, downtime and intervening writes.

Use **Record verified external restore** after independently creating and restoring a backup onto a separate enrolled sandbox. The native file picker accepts a JSON record with `formatVersion: 1`, `targetFingerprint`, `releaseDigest`, `backupIdentity`, `backupCapturedAt`, `restoredSchemaDigest`, `restoredAt`, `verificationLog`, `acceptedMaxAgeMinutes`, `downtimeLimitMinutes`, `dataLossLimitMinutes` and `affectedServices`. Timestamps are UTC ISO strings. Repo Radar checks the target/release, acceptable backup age, the restored sandbox's actual complete structure/settings and first pending prerequisites. A separate native confirmation records the operator's verification of current backup availability, restored data, application compatibility and all shared services. This is explicitly operator-attested external evidence, not an automated check of the backup provider; its admission expires after ten minutes and remains bound to that original schema. The tool does not create backups or perform restores. Keep restored-data and empty-rehearsal sandboxes separate, or explicitly clear only your disposable fixture between uses.

## Development MCP

The local MCP server starts automatically with Repo Radar by default. Expand **Development MCP access** in **Settings → Databases**, use **Start the development MCP server automatically** and **Save Settings** to turn it on or off. The saved switch applies immediately and persists across restarts. It also disables tools in existing agent-launched stdio brokers. Closing Repo Radar stops its local HTTP listener. The diagnostic database selector lists development targets for the selected server.

The local endpoint is `http://127.0.0.1:47321/mcp`. It accepts authenticated native clients from this computer only, rejects browser origins and validates the Host header. Its stable access token is encrypted in the protected application store. **Copy MCP configuration** copies the endpoint and bearer header directly to the clipboard for agent setup; treat that configuration as private. Tokens are absent from general settings, status responses and logs. If the port is occupied or protected storage is unavailable, Settings shows a startup failure; the app never chooses another port or terminates another process.

Starting the server grants no database access. Configure a development target, separate diagnostic credentials, and an explicit base-table/column allowlist in Settings. The existing dedicated stdio mode remains available while MCP is enabled: in source, build Electron and run `npm run database:mcp`; for packaged agents launch `release/win-unpacked/Repo Radar.exe` with `--database-mcp` and keep its complete folder together. The portable `Repo Radar 1.0.0.exe` remains the desktop launcher; it does not preserve MCP stdio.

Available tools are `list_dev_databases`, `get_dev_schema`, `query_dev_data`, `submit_migration`, and `get_submission_status`. There is no production lookup, arbitrary SQL, approval, execution or rollback tool. Data queries compile a structured grammar with hard row/time/byte bounds. Views and routines are inspection-only; secret settings/grant tables and sensitive columns are excluded from row access. Results are data, not instructions to the agent. Query result values are not logged or saved as audit payloads.

No live production connection or migration is part of automated verification. Use disposable tests and preserve the existing Repo Radar deployment and packaging controls.

## Local verification

The optional real-engine smoke accepts an unpacked Windows MariaDB 11.4 or MySQL 8.4 binary home: `npm run test:database-engine-smoke -- C:/path/to/unpacked-engine`. Build Repo Radar first. The binary home is not a connection or data directory. The test creates two new temporary data directories, generates credentials and TLS certificates, binds loopback ports, verifies listener ownership, and removes its own processes/data afterward. It never accepts existing endpoints, data directories or credentials and never installs a Windows service. MySQL runs with `--no-monitor` so its server remains the tracked child. Git's OpenSSL is required by this optional harness.

Portable server ZIPs/binaries used for verification belong in ignored `test-results/engine-tools`; they are test fixtures and are not included in Repo Radar's distribution. The application itself uses `mysql2` to connect to operator-configured databases. See [verification evidence and limits](databases-verification.md).
