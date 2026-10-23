/**
 * Optional REAL ENGINE smoke. Requires an already unpacked, operator-selected
 * MariaDB 11.4 or MySQL 8.4 Windows distribution and a compiled Electron build.
 * REPO_RADAR_DB_ENGINE_HOME is a binary directory, never an existing data dir.
 * This file never downloads, installs a service, accepts connection settings,
 * reads user DB configuration, or uses existing database credentials.
 *
 * MariaDB's Windows mysql_install_db.exe does not accept --no-defaults. It
 * generates my.ini in our fresh datadir and explicitly bootstraps using that
 * file; no --config or --service is passed. MySQL uses --initialize-insecure
 * with --no-defaults. BOTH running servers use --no-defaults and bind loopback.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import mysql from "mysql2/promise";

const repository = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const binaryHomeInput = process.env.REPO_RADAR_DB_ENGINE_HOME ?? process.argv[2];
assert.ok(binaryHomeInput, "Set REPO_RADAR_DB_ENGINE_HOME to unpacked MariaDB11.4 or MySQL8.4 binaries. No existing database can be supplied.");
assert.equal(process.platform, "win32", "This optional harness initializes Windows portable engine binaries only.");
const binaryHome = await realpath(binaryHomeInput);
const serverBinary = ["mariadbd.exe", "mysqld.exe"].map(name => path.join(binaryHome, "bin", name)).find(existsSync);
assert.ok(serverBinary, "Selected engine home must contain bin/mariadbd.exe or bin/mysqld.exe.");
const openssl = "C:/Program Files/Git/usr/bin/openssl.exe";
assert.ok(existsSync(openssl), "Git OpenSSL is required to create a fresh fixture CA and localhost server certificate.");
const childEnvironment = Object.fromEntries(Object.entries(process.env).filter(([key, value]) => value !== undefined && !/^(MYSQL|MARIADB|NODE_OPTIONS|ELECTRON_RUN_AS_NODE)/i.test(key)));
const tracked = new Set();
const servers = [];
const sessions = new Set();
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
function launch(binary, args, cwd) {
  const child = spawn(binary, args, { cwd, env: childEnvironment, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
  tracked.add(child);
  child.fixtureClosed = false;
  child.fixtureClosePromise = new Promise(resolve => child.once("close", () => { child.fixtureClosed = true; tracked.delete(child); resolve(); }));
  child.once("error", () => { /* close follows spawn failure; retain ownership until then. */ });
  return child;
}
async function waitForOwnClose(child, milliseconds) {
  if (child.fixtureClosed) return true;
  let timer;
  try { return await Promise.race([child.fixtureClosePromise.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), milliseconds); })]); }
  finally { clearTimeout(timer); }
}
async function stopOwnProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) { await waitForOwnClose(child, 5000); return; }
  // Kill only this harness's tracked process, never a process selected by name/port.
  assert.ok(tracked.has(child), "Refusing to terminate an untracked process");
  // Windows MariaDB initialization spawns its own bootstrap server. A timeout
  // must terminate that owned process tree too, rather than orphaning bootstrap.
  if (child.fixtureInitializer) {
    const killer = launch(path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], repository);
    killer.stdout.resume(); killer.stderr.resume();
    if (!await waitForOwnClose(killer, 5000)) { killer.kill(); await waitForOwnClose(killer, 5000); }
  }
  child.kill();
  if (!await waitForOwnClose(child, 5000)) { child.kill("SIGKILL"); assert.ok(await waitForOwnClose(child, 5000), "Owned fixture process did not close; temporary directory must be preserved"); }
}
async function tool(binary, args, cwd, timeout = 30_000) {
  const child = launch(binary, args, cwd);
  child.fixtureInitializer = /(?:mariadb-install-db|mysql_install_db)\.exe$/i.test(binary);
  let output = "";
  const capture = chunk => { output = (output + chunk.toString()).slice(-64_000); };
  child.stdout.on("data", capture); child.stderr.on("data", capture);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { void stopOwnProcess(child).finally(() => reject(new Error(`Fixture tool ${path.basename(binary)} timed out; no existing instance was used.`))); }, timeout);
    child.once("error", () => { clearTimeout(timer); reject(new Error(`Could not launch fixture tool ${path.basename(binary)}.`)); });
    child.once("close", code => { clearTimeout(timer); if (code === 0) resolve(output); else reject(new Error(`Fixture tool ${path.basename(binary)} exited ${code}; captured output withheld because initialization can contain fresh passwords.`)); });
  });
}
const versionOutput = await tool(serverBinary, ["--no-defaults", "--version"], binaryHome);
const engine = /11\.4\.\d+[^\r\n]*MariaDB/i.test(versionOutput) ? "mariadb" : /\bVer\s+8\.4\.\d+[^\r\n]*MySQL/i.test(versionOutput) ? "mysql" : null;
assert.ok(engine, "Only MariaDB11.4.x and MySQL8.4.x portable binaries are supported by this harness.");
const compiled = name => pathToFileURL(path.join(repository, "dist-electron", "electron", "databases", `${name}.js`)).href;
assert.ok(existsSync(fileURLToPath(compiled("service"))), "Build Repo Radar before running engine smoke.");
const [{ connectDatabase, connectDatabaseServer, readIdentity, databaseDigest }, { captureSchema }, { MigrationRunner, setupHistory, readHistory, appliedPrefix }, { DatabaseService }, { DatabaseDiagnosticBroker }, { saveDiagnosticConfig }] = await Promise.all(["connections", "schema", "runner", "service", "mcp", "devConfig"].map(name => import(compiled(name))));
const tempParent = await realpath(os.tmpdir());
const directory = await mkdtemp(path.join(tempParent, "repo-radar-engine-smoke-"));
const realDirectory = await realpath(directory);
const marker = randomUUID();
await writeFile(path.join(directory, ".fixture-owner"), marker, { flag: "wx" });
const rootPassword = randomBytes(24).toString("hex");
const readerPassword = randomBytes(24).toString("hex");
function sanitizedFailure(error) {
  const detail = error instanceof Error ? `${error.code ?? error.name}: ${error.message}` : "Unknown fixture error";
  return detail.replaceAll(rootPassword, "[fixture-password]").replaceAll(readerPassword, "[fixture-password]").replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[fixture-key]").replace(/\b[a-f0-9]{32,}\b/gi, "[fixture-secret-or-digest]").slice(0, 3000);
}
let stage = "creating fixture TLS";
const key = randomBytes(32);
const protector = {
  isEncryptionAvailable: () => true,
  encryptString(value) { const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv); const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]); return Buffer.concat([iv, cipher.getAuthTag(), data]); },
  decryptString(value) { const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(12, 28)); return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8"); }
};
async function localPort() {
  const listener = net.createServer();
  await new Promise((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
  const address = listener.address(); assert.ok(address && typeof address !== "string");
  await new Promise((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function verifyFixtureListener(server) {
  assert.ok(servers.includes(server) && tracked.has(server.child) && server.child.pid, "Only this harness's running child processes may own fixture listeners");
  const netstat = path.join(process.env.SystemRoot ?? "C:/Windows", "System32", "netstat.exe");
  const output = await tool(netstat, ["-ano", "-p", "tcp"], directory);
  const listeners = output.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(fields => fields[0] === "TCP" && fields[1] === `127.0.0.1:${server.port}` && fields[3] === "LISTENING");
  assert.equal(listeners.length, 1, "Fresh fixture loopback listener ownership could not be verified; refusing to connect");
  assert.equal(Number(listeners[0][4]), server.child.pid, "Selected local port belongs to a different process; refusing to connect");
  assert.ok(tracked.has(server.child) && server.child.exitCode === null && server.child.signalCode === null, "Fixture child exited during listener verification; refusing to connect");
}
async function guardedConnect(config) {
  assert.equal(config.host, "localhost", "Protected fixture connections must use the generated localhost certificate");
  const server = servers.find(candidate => candidate.port === config.port);
  assert.ok(server && databases.has(`${server.port}:${config.database}`), "Connection is outside this harness's freshly created databases");
  await verifyFixtureListener(server);
  return connectDatabase(config);
}
async function guardedServerConnect(config) {
  assert.equal(config.host, "localhost");
  const server = servers.find(candidate => candidate.port === config.port);
  assert.ok(server, "Server discovery must stay inside this harness's fresh processes");
  await verifyFixtureListener(server);
  return connectDatabaseServer(config);
}
async function raw(server, database) {
  await verifyFixtureListener(server);
  const connection = await mysql.createConnection({ host: "127.0.0.1", port: server.port, user: "root", password: server.password, ...(database ? { database } : {}), connectTimeout: 1000, multipleStatements: false });
  const originalQuery = connection.query.bind(connection);
  connection.query = (sql, params) => originalQuery(typeof sql === "string" ? { sql, timeout: 10_000 } : sql, params);
  try {
    const [rows] = await connection.query("SELECT @@datadir AS datadir");
    const actual = await realpath(String(rows[0].datadir));
    if (actual.toLowerCase() !== server.datadir.toLowerCase()) throw new Error("Fixture data-directory ownership could not be verified; no SQL writes dispatched.");
  } catch (error) { connection.destroy(); throw error; }
  sessions.add(connection);
  return connection;
}
async function close(connection) { sessions.delete(connection); try { if (typeof connection.close === "function") await connection.close(); else await connection.end(); } catch { connection.destroy?.(); } }
let ca;
async function protectedSession(server, database, username = "root", password = rootPassword) {
  const session = await guardedConnect({ profileId: "fresh-fixture", databaseKey: "fixture", environment: "dev", host: "localhost", port: server.port, database, tlsCa: ca, credentials: { username, password } });
  const originalClose = session.close;
  session.close = async () => { sessions.delete(session); await originalClose(); };
  sessions.add(session); return session;
}
const databases = new Set();
async function createDatabase(server, name) {
  assert.match(name, /^fixture_[a-z_]+$/);
  assert.ok(!databases.has(`${server.port}:${name}`)); databases.add(`${server.port}:${name}`);
  const connection = await raw(server);
  try { await connection.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`); } finally { await close(connection); }
}
async function startFixture(index, certificatePaths) {
  stage = `initializing disposable ${engine} server ${index + 1}`;
  const datadir = await mkdtemp(path.join(directory, `data-${index}-`));
  assert.equal(path.dirname(datadir), directory);
  const port = await localPort();
  assert.ok(!servers.some(server => server.port === port));
  if (engine === "mariadb") {
    const initialize = ["mariadb-install-db.exe", "mysql_install_db.exe"].map(name => path.join(binaryHome, "bin", name)).find(existsSync);
    assert.ok(initialize, "MariaDB portable Windows initializer was not found.");
    // This utility does not load defaults. Its child reads only my.ini generated
    // in the explicitly supplied fresh directory; --config/--service are absent.
    await tool(initialize, [`--datadir=${datadir}`, `--password=${rootPassword}`, `--port=${port}`], directory);
  } else await tool(serverBinary, ["--no-defaults", "--no-monitor", "--initialize-insecure", `--basedir=${binaryHome}`, `--datadir=${datadir}`], directory);
  const initializePassword = path.join(datadir, "fixture-root-init.sql");
  if (engine === "mysql") await writeFile(initializePassword, `ALTER USER 'root'@'localhost' IDENTIFIED BY '${rootPassword}';\n`, { mode: 0o600, flag: "wx" });
  const pidFile = path.join(datadir, "fixture.pid");
  stage = `starting disposable ${engine} server ${index + 1}`;
  // MySQL Windows otherwise forks a monitor/server pair; --no-monitor keeps
  // the tracked child identical to the PID-file/listener owner (8.4 docs).
  const args = ["--no-defaults", `--basedir=${binaryHome}`, `--datadir=${datadir}`, "--bind-address=127.0.0.1", `--port=${port}`, `--pid-file=${pidFile}`, `--server-id=${index + 101}`, "--innodb-buffer-pool-size=64M", "--max-connections=30", "--event-scheduler=OFF", "--skip-log-bin", `--ssl-ca=${certificatePaths.ca}`, `--ssl-cert=${certificatePaths.cert}`, `--ssl-key=${certificatePaths.key}`, ...(engine === "mysql" ? ["--no-monitor", "--mysqlx=OFF", `--init-file=${initializePassword}`] : []), "--console"];
  const child = launch(serverBinary, args, directory);
  child.stdout.resume(); child.stderr.resume(); // Never echo fresh server logs/passwords.
  const server = { child, datadir: await realpath(datadir), port, password: rootPassword };
  servers.push(server);
  const deadline = Date.now() + 30_000;
  let ready = false;
  let lastReadinessError;
  while (Date.now() < deadline) {
    assert.equal(child.exitCode, null, "Fresh fixture server exited during startup");
    try {
      assert.equal(Number((await readFile(pidFile, "utf8")).trim()), child.pid, "Fresh server PID file does not match its tracked child process");
      const connection = await raw(server);
      await close(connection);
      ready = true; break;
    } catch (error) { lastReadinessError = error; await delay(150); }
  }
  assert.ok(ready, `Fresh fixture server did not become ready within30seconds; existing instances are never tried. ${lastReadinessError ? sanitizedFailure(lastReadinessError) : ""}`);
  return server;
}

async function metadataAndDiagnostics(server) {
  await createDatabase(server, "fixture_metadata");
  const connection = await raw(server, "fixture_metadata");
  try {
    for (const sql of ["CREATE TABLE owner (id INT PRIMARY KEY) ENGINE=InnoDB", "CREATE TABLE stock (id INT PRIMARY KEY, owner_id INT, amount INT NOT NULL, doubled INT AS (amount * 2) STORED, INDEX ix_amount (amount), CONSTRAINT fk_owner FOREIGN KEY (owner_id) REFERENCES owner(id)) ENGINE=InnoDB", "CREATE VIEW stock_view AS SELECT id, amount FROM stock", "CREATE FUNCTION fixture_count() RETURNS INT DETERMINISTIC RETURN 1", "CREATE TRIGGER stock_positive BEFORE INSERT ON stock FOR EACH ROW SET NEW.amount = ABS(NEW.amount)", "INSERT INTO owner (id) VALUES (1)", "INSERT INTO stock (id, owner_id, amount) VALUES (1, 1, 3)"]) await connection.query(sql);
    await connection.query("CREATE USER 'fixture_reader'@'localhost' IDENTIFIED BY ?", [readerPassword]);
    await connection.query("GRANT SELECT, SHOW VIEW ON fixture_metadata.* TO 'fixture_reader'@'localhost'");
  } finally { await close(connection); }
  const session = await protectedSession(server, "fixture_metadata");
  let identity;
  try {
    identity = await readIdentity(session, "fixture_metadata");
    assert.equal(identity.engine, engine);
    const snapshot = await captureSchema(session, identity);
    assert.deepEqual(snapshot.coverage.limitations, []);
    assert.equal(snapshot.coverage.complete, true);
    for (const type of ["table", "column", "index", "foreign-key", "view", "routine", "trigger"]) assert.ok(snapshot.objects.some(object => object.objectType === type), `Missing real ${type} metadata`);
    assert.ok(snapshot.objects.some(object => object.objectType === "column" && object.definition.includes("GENERATION_EXPRESSION") && object.definition.includes("amount")));
    assert.ok(snapshot.objects.find(object => object.objectType === "trigger").definition.includes("DEFINER"));
    await session.execute("CREATE EVENT fixture_future ON SCHEDULE EVERY 1 DAY DISABLE DO SELECT 1");
    assert.equal((await captureSchema(session, identity)).coverage.complete, false, "Scheduled events must prevent a false complete assessment");
    await session.execute("DROP EVENT fixture_future");
  } finally { await close(session); }
  const diagnosticDirectory = path.join(directory, "diagnostic-config");
  await saveDiagnosticConfig(diagnosticDirectory, protector, { profile: { profileId: "fixture-dev", databaseKey: "fixture", environment: "dev", host: "localhost", port: server.port, database: "fixture_metadata", tlsCa: ca, credentials: { username: "fixture_reader", password: readerPassword }, identity }, policy: { tables: { stock: ["id", "amount", "doubled"], stock_view: ["id"] } }, deniedIdentities: [], workspaceRoot: directory, repositories: [] });
  const broker = new DatabaseDiagnosticBroker(diagnosticDirectory, protector, { connect: guardedConnect });
  const result = await broker.call("query_dev_data", { databaseKey: "fixture", table: "stock", columns: ["id", "amount"] });
  assert.deepEqual(result.rows, [{ id: "1", amount: "3" }]);
  await assert.rejects(broker.call("query_dev_data", { databaseKey: "production", table: "stock", columns: ["id"] }));
  await assert.rejects(broker.call("query_dev_data", { databaseKey: "fixture", table: "stock_view", columns: ["id"] }), /InnoDB/);
  await assert.rejects(broker.call("query_dev_data", { databaseKey: "fixture", table: "stock", columns: ["doubled"] }), /Generated/);
  console.log("Real engine: complete structural metadata, generated columns, trigger definer, scheduled-event blocker and restricted development diagnostics passed.");
}

async function serviceFlow(primary, sandbox) {
  for (const [server, name] of [[primary, "fixture_dev"], [primary, "fixture_production"], [sandbox, "fixture_sandbox"]]) {
    await createDatabase(server, name);
    if (server === primary) { const connection = await raw(server, name); try { await connection.query("CREATE TABLE stock (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB"); } finally { await close(connection); } }
  }
  const source = path.join(directory, "service-fixture"), migrationDirectory = path.join(source, "db", "migrations", "add-index");
  await mkdir(migrationDirectory, { recursive: true });
  await tool("git", ["init", source], directory);
  const manifest = { formatVersion: 1, id: "fixture/add-index", title: "Add fixture value index", databaseKey: "fixture", service: "fixture", dependsOn: [], engine: { product: engine, minVersion: engine === "mysql" ? "8.4.0" : "11.4.0", requiredSettings: {}, storageEngines: ["InnoDB"] }, up: ["up.sql"], preconditions: [], postconditions: [], recovery: { mode: "down", down: ["down.sql"], eligibilityChecks: [], runbook: "recovery.md", applicationCompatibility: "Fixture app accepts both index states", rollbackRoute: "tested-down" }, dataImpact: { description: "Index on empty disposable fixture only", destructive: false, requiresWritePause: false, locking: "Fixture index metadata lock" }, applicationCompatibility: "Fixture app accepts both index states", expectedSchemaChanges: [{ objectType: "index", objectPath: "stock.ix_value.1", description: "Fixture index" }] };
  await Promise.all([writeFile(path.join(migrationDirectory, "migration.json"), JSON.stringify(manifest)), writeFile(path.join(migrationDirectory, "up.sql"), "CREATE INDEX ix_value ON stock (value);"), writeFile(path.join(migrationDirectory, "down.sql"), "DROP INDEX ix_value ON stock;"), writeFile(path.join(migrationDirectory, "recovery.md"), "Run the verified index down migration; fixture application remains compatible.")]);
  const service = new DatabaseService({ directory: path.join(directory, "app-data"), protector, root: () => directory, repositories: async () => [source], confirm: async () => true, connect: guardedConnect, connectServer: guardedServerConnect });
  const profiles = {};
  const servers = new Map();
  for (const [environment, database, server] of [["dev", "fixture_dev", primary], ["production", "fixture_production", primary], ["sandbox", "fixture_sandbox", sandbox]]) {
    let savedServer = servers.get(server);
    if (!savedServer) {
      savedServer = await service.saveServerConnection({ label: "Disposable engine server", host: "localhost", port: server.port, tlsMode: "verify", tlsCa: ca });
      for (const role of ["inspection", "migration"]) await service.saveServerCredentials(savedServer.id, role, { username: "root", password: rootPassword });
      servers.set(server, savedServer);
    }
    const profile = await service.saveProfile({ databaseKey: "fixture", label: `Disposable ${environment}`, environment, serverConnectionId: savedServer.id, database });
    const observed = await service.inspect(profile.id); assert.equal(observed.coverage.complete, true);
    await service.acceptIdentity(profile.id, observed.identity.fingerprint); profiles[environment] = profile;
    if (environment !== "sandbox") {
      assert.equal((await service.history(profile.id)).enrolled, false);
      const plan = await service.createPlan({ profileId: profile.id, kind: "enroll", direction: "up", migrationIds: [] });
      assert.equal((await service.runPlan(plan.planId)).state, "succeeded");
    }
  }
  const discovery = await service.discoverDatabases(servers.get(primary).id);
  for (const database of ["fixture_dev", "fixture_production"]) assert.equal(discovery.databases.find(item => item.database === database)?.assigned, true);
  await service.importProposal(source, "db/migrations/add-index/migration.json");
  await service.sealRelease("fixture");
  await service.rehearse("fixture", profiles.sandbox.id);
  const devPlan = await service.createPlan({ profileId: profiles.dev.id, kind: "execute", direction: "up", migrationIds: [manifest.id] });
  assert.equal((await service.runPlan(devPlan.planId)).state, "succeeded");
  const replay = await service.rehearse("fixture", profiles.sandbox.id);
  assert.equal(replay.assessment, "explained");
  assert.equal((await service.compare("fixture")).assessment, "explained");
  const prodPlan = await service.createPlan({ profileId: profiles.production.id, kind: "execute", direction: "up", migrationIds: [manifest.id] });
  assert.equal((await service.runPlan(prodPlan.planId)).state, "succeeded");
  const downPlan = await service.createPlan({ profileId: profiles.production.id, kind: "execute", direction: "down", migrationIds: [manifest.id] });
  assert.equal((await service.runPlan(downPlan.planId)).state, "succeeded");
  const history = await service.history(profiles.production.id);
  assert.deepEqual(history.events.filter(event => event.kind === "attempt-start").map(event => event.direction), ["up", "down"]);
  console.log("Real engine: protected TLS profiles, explicit history enrollment, immutable service import, separate-server up/down/up rehearsal, development admission, explained production up and reviewed down passed.");
}

async function transactionalRunner(primary, sandbox, failing = false) {
  const database = failing ? "fixture_transaction_failure" : "fixture_transaction_success";
  for (const server of [primary, sandbox]) {
    await createDatabase(server, database);
    const connection = await raw(server, database);
    try { await connection.query("CREATE TABLE stock (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB"); } finally { await close(connection); }
  }
  const sourceSql = "INSERT INTO stock (id, value) VALUES (1, 7)";
  // This fixture independently verifies ACTUAL DATA up/down/up on the second
  // server. It does not pretend product schema-only replay proves data recovery.
  const fixture = await protectedSession(sandbox, database);
  let verifiedDataSchemaDigest;
  try {
    const identity = await readIdentity(fixture, database), snapshot = await captureSchema(fixture, identity);
    assert.equal(snapshot.coverage.complete, true); verifiedDataSchemaDigest = snapshot.digest;
    await fixture.execute(sourceSql); assert.equal(Number((await fixture.query("SELECT COUNT(*) AS n FROM stock"))[0].n), 1);
    await fixture.execute("DELETE FROM stock WHERE id = 1"); assert.equal(Number((await fixture.query("SELECT COUNT(*) AS n FROM stock"))[0].n), 0);
    await fixture.execute(sourceSql); assert.equal(Number((await fixture.query("SELECT value FROM stock WHERE id = 1"))[0].value), 7);
    const after = await captureSchema(fixture, identity);
    assert.equal(after.coverage.complete, true); assert.equal(after.digest, verifiedDataSchemaDigest);
  } finally { await close(fixture); }
  const session = await protectedSession(primary, database), identity = await readIdentity(session, database), baseline = await captureSchema(session, identity);
  assert.equal(baseline.coverage.complete, true);
  assert.equal(baseline.digest, verifiedDataSchemaDigest, "Real data recovery fixture must match the exact target structure");
  await setupHistory(session, identity, baseline.digest); await close(session);
  const migration = { id: "fixture/transaction", sequence: 1, contentDigest: databaseDigest([sourceSql, "DELETE FROM stock WHERE id = 1"]), upSql: [sourceSql], downSql: ["DELETE FROM stock WHERE id = 1"], preconditions: [], postconditions: [], eligibilityChecks: [], transactional: true, recoveryRoute: "tested-down" };
  const target = { targetId: database, databaseKey: "fixture", environment: "dev", identity };
  let failureInjected = false;
  const recoveryExpiresAt = new Date(Date.now() + 60000).toISOString();
  const runner = new MigrationRunner({ open: async () => {
    const connection = await protectedSession(primary, database);
    if (failing) {
      const originalExecute = connection.execute;
      connection.execute = async (sql, params) => {
        await originalExecute(sql, params);
        if (sql === sourceSql && !failureInjected) { failureInjected = true; throw new Error("Fixture-injected failure after a real transactional write; rollback must be acknowledged."); }
      };
    }
    return connection;
  }, inspect: async connection => { const actual = await readIdentity(connection, database), snapshot = await captureSchema(connection, actual); return { identity: actual, identityFingerprint: actual.fingerprint, schemaDigest: snapshot.digest, coverageComplete: snapshot.coverage.complete }; }, trustedEvidence: async (_target, _migrations, _direction, releaseDigest, beforeSchemaDigest) => ({ expectedSchemaDigests: { [migration.id]: baseline.digest }, recovery: [{ evidenceId: "actual-disposable-data-up-down-up", targetId: target.targetId, releaseDigest, beforeSchemaDigest, migrationId: migration.id, contentDigest: migration.contentDigest, expiresAt: recoveryExpiresAt, route: "tested-down", rehearsal: "up-down-up-passed" }] }) });
  const request = { target, releaseDigest: databaseDigest(migration), migrations: [migration], direction: "up", migrationIds: [migration.id], kind: "execute" };
  const plan = await runner.createPlan(request);
  const result = await runner.execute(plan.planId, runner.issueApproval(plan.planId));
  assert.equal(result.state, failing ? "failed" : "succeeded");
  const actual = await protectedSession(primary, database);
  try {
    assert.equal(Number((await actual.query("SELECT COUNT(*) AS n FROM stock"))[0].n), failing ? 0 : 1);
    const history = await readHistory(actual);
    assert.equal(history.events.filter(event => event.kind === "attempt-end").at(-1).state, result.state);
    if (failing) await assert.rejects(runner.createPlan(request), /reconciliation/);
    else {
      assert.deepEqual(appliedPrefix(history, [migration]), [migration.id]);
      const down = await runner.createPlan({ ...request, direction: "down" });
      assert.equal((await runner.execute(down.planId, runner.issueApproval(down.planId))).state, "succeeded");
      assert.equal(Number((await actual.query("SELECT COUNT(*) AS n FROM stock"))[0].n), 0);
      const blocked = await runner.createPlan(request);
      const exactLock = `db-radar:${createHash("sha256").update(`${identity.serverId}:${identity.database.toLowerCase()}`).digest("hex").slice(0, 50)}`;
      await actual.query("SELECT GET_LOCK(?, 0) AS acquired", [exactLock]);
      try { await assert.rejects(runner.execute(blocked.planId, runner.issueApproval(blocked.planId)), /Another runner/); }
      finally { await actual.query("SELECT RELEASE_LOCK(?) AS released", [exactLock]); }
    }
  } finally { await close(actual); }
  console.log(`Real engine: ${failing ? "failed transaction rolls back data, durable failure blocks retries" : "transactional success/down, durable ordered history and competing-session lock refusal"} passed.`);
}

async function partialDdlConnectionLoss(primary, sandbox) {
  const database = "fixture_partial_ddl";
  for (const server of [primary, sandbox]) {
    await createDatabase(server, database);
    const connection = await raw(server, database);
    try { await connection.query("CREATE TABLE stock (id INT PRIMARY KEY, value INT NOT NULL) ENGINE=InnoDB"); } finally { await close(connection); }
  }
  const workloads = [
    { id: "fixture/partial-ddl", up: "ALTER TABLE stock ADD COLUMN partial_marker INT NULL", down: "ALTER TABLE stock DROP COLUMN partial_marker" },
    { id: "fixture/unreached-ddl", up: "CREATE INDEX ix_unreached ON stock (value)", down: "DROP INDEX ix_unreached ON stock" }
  ];
  const migrations = workloads.map((item, index) => ({ id: item.id, sequence: index + 1, contentDigest: databaseDigest([item.up, item.down]), upSql: [item.up], downSql: [item.down], preconditions: [], postconditions: [], eligibilityChecks: [], transactional: false, recoveryRoute: "tested-down" }));
  const proof = await protectedSession(sandbox, database);
  const expectedSchemaDigests = {};
  let baselineDigest;
  try {
    const identity = await readIdentity(proof, database), initial = await captureSchema(proof, identity);
    assert.equal(initial.coverage.complete, true); baselineDigest = initial.digest;
    // Exact DDL is really rehearsed up/down/up on the second, empty-data server.
    for (const item of workloads) {
      await proof.execute(item.up); const captured = await captureSchema(proof, identity);
      assert.equal(captured.coverage.complete, true); expectedSchemaDigests[item.id] = captured.digest;
    }
    for (const item of [...workloads].reverse()) await proof.execute(item.down);
    assert.equal((await captureSchema(proof, identity)).digest, baselineDigest);
    for (const item of workloads) { await proof.execute(item.up); assert.equal((await captureSchema(proof, identity)).digest, expectedSchemaDigests[item.id]); }
  } finally { await close(proof); }
  const before = await protectedSession(primary, database), identity = await readIdentity(before, database), initial = await captureSchema(before, identity);
  assert.equal(initial.coverage.complete, true); assert.equal(initial.digest, baselineDigest);
  await setupHistory(before, identity, initial.digest); await close(before);
  const target = { targetId: database, databaseKey: "fixture", environment: "dev", identity };
  const releaseDigest = databaseDigest(migrations), expiresAt = new Date(Date.now() + 60000).toISOString();
  let injected = false;
  const runner = new MigrationRunner({
    open: async () => {
      const session = await protectedSession(primary, database), execute = session.execute;
      session.execute = async (sql, params) => {
        await execute(sql, params);
        if (sql === workloads[0].up && !injected) {
          // Server DDL has committed. Destroy the real connection before the
          // adapter passes acknowledgment to the runner. This is an injected
          // post-acceptance connection loss, not a full network/COMMIT-ack test.
          injected = true; session.destroy(); throw new Error("Injected real-session loss after committed fixture DDL");
        }
      };
      return session;
    },
    inspect: async session => { const actual = await readIdentity(session, database), snapshot = await captureSchema(session, actual); return { identity: actual, identityFingerprint: actual.fingerprint, schemaDigest: snapshot.digest, coverageComplete: snapshot.coverage.complete }; },
    trustedEvidence: async (_target, _migrations, _direction, selectedRelease, beforeSchemaDigest) => ({ expectedSchemaDigests, recovery: migrations.map(item => ({ evidenceId: `actual-fixture-ddl-up-down-up:${item.id}`, targetId: database, releaseDigest: selectedRelease, beforeSchemaDigest, migrationId: item.id, contentDigest: item.contentDigest, expiresAt, route: "tested-down", rehearsal: "up-down-up-passed" })) })
  });
  const request = { target, releaseDigest, migrations, direction: "up", migrationIds: migrations.map(item => item.id), kind: "execute" };
  const plan = await runner.createPlan(request);
  const result = await runner.execute(plan.planId, runner.issueApproval(plan.planId));
  assert.equal(injected, true); assert.equal(result.state, "uncertain");
  const observed = await protectedSession(primary, database);
  try {
    assert.equal((await observed.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock' AND COLUMN_NAME = 'partial_marker'")).length, 1, "The first real DDL must remain committed");
    assert.equal((await observed.query("SELECT INDEX_NAME FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'stock' AND INDEX_NAME = 'ix_unreached'")).length, 0, "Later migration must not run after uncertainty");
    const history = await readHistory(observed);
    assert.equal(history.events.filter(event => event.kind === "attempt-start").length, 1);
    assert.ok(history.events.some(event => event.kind === "statement-intent"));
    assert.equal(history.events.some(event => event.kind === "attempt-end" && event.state === "succeeded"), false);
    assert.throws(() => appliedPrefix(history, migrations), /Unfinished|uncertain|reconciliation/);
    await assert.rejects(runner.createPlan(request), /Unfinished|uncertain|reconciliation/);
  } finally { await close(observed); }
  console.log("Real engine: committed partial DDL plus injected post-acceptance connection loss returns uncertain, preserves durable intent, stops later migrations and blocks retry.");
}

const watchdog = setTimeout(() => {
  console.error("Disposable engine smoke exceeded five minutes; terminating only tracked fixture processes.");
  for (const session of sessions) session.destroy?.();
  for (const child of [...tracked]) void stopOwnProcess(child);
}, 300_000);
let smokeError;
try {
  const certificateDirectory = path.join(directory, "tls"); await mkdir(certificateDirectory);
  const caConfig = path.join(certificateDirectory, "ca.cnf"), certConfig = path.join(certificateDirectory, "server.cnf");
  await writeFile(caConfig, "[req]\ndistinguished_name=dn\nprompt=no\nx509_extensions=v3\n[dn]\nCN=RepoRadarDisposableFixtureCA\n[v3]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n");
  await writeFile(certConfig, "[req]\ndistinguished_name=dn\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost\nextendedKeyUsage=serverAuth\nbasicConstraints=CA:FALSE\n");
  const paths = { ca: path.join(certificateDirectory, "ca.pem"), cert: path.join(certificateDirectory, "server.pem"), key: path.join(certificateDirectory, "server-key.pem") };
  await tool(openssl, ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", caConfig, "-keyout", path.join(certificateDirectory, "ca-key.pem"), "-out", paths.ca], directory);
  await tool(openssl, ["req", "-new", "-newkey", "rsa:2048", "-nodes", "-config", certConfig, "-keyout", paths.key, "-out", path.join(certificateDirectory, "server.csr")], directory);
  await tool(openssl, ["x509", "-req", "-days", "1", "-in", path.join(certificateDirectory, "server.csr"), "-CA", paths.ca, "-CAkey", path.join(certificateDirectory, "ca-key.pem"), "-CAcreateserial", "-extfile", certConfig, "-extensions", "v3", "-out", paths.cert], directory);
  ca = await readFile(paths.ca, "utf8");
  const primary = await startFixture(0, paths), sandbox = await startFixture(1, paths);
  stage = "metadata and development diagnostics";
  await metadataAndDiagnostics(primary);
  stage = "reviewed service migration flow";
  await serviceFlow(primary, sandbox);
  stage = "transactional success and lock contention";
  await transactionalRunner(primary, sandbox);
  stage = "transactional failure and acknowledged rollback";
  await transactionalRunner(primary, sandbox, true);
  stage = "partial DDL and injected post-acceptance connection loss";
  await partialDdlConnectionLoss(primary, sandbox);
  console.log(`Disposable ${engine} engine smoke passed using two newly initialized local instances. No existing database or credentials were used.`);
} catch (error) {
  // Print the original stage/code/message before cleanup can fail. Do not print
  // raw server output, original stacks or any generated password/key content.
  smokeError = new Error(`Disposable ${engine} engine smoke failed during ${stage}: ${sanitizedFailure(error)}`);
  console.error(smokeError.message);
  throw smokeError;
} finally {
  clearTimeout(watchdog);
  const cleanupErrors = [];
  for (const session of [...sessions]) try { await close(session); } catch (error) { cleanupErrors.push(sanitizedFailure(error)); }
  for (const server of servers) {
    try {
      if (tracked.has(server.child)) {
        try { const connection = await raw(server); try { await connection.query("SHUTDOWN"); } finally { await close(connection); } } catch { /* Only the tracked fixture process is terminated below. */ }
        // A successful shutdown may return before Windows releases database
        // handles. Await child close before removing its data directory.
        if (!await waitForOwnClose(server.child, 5000)) await stopOwnProcess(server.child);
      } else await waitForOwnClose(server.child, 5000);
    } catch (error) { cleanupErrors.push(sanitizedFailure(error)); }
  }
  for (const child of [...tracked]) try { await stopOwnProcess(child); } catch (error) { cleanupErrors.push(sanitizedFailure(error)); }
  try {
    assert.equal(tracked.size, 0, "Owned processes have not all closed; preserving fixture directory");
    assert.equal(await realpath(directory), realDirectory, "Refusing cleanup: fixture root changed");
    assert.equal(path.dirname(realDirectory), tempParent, "Refusing cleanup outside the original temporary parent");
    assert.ok(path.basename(realDirectory).startsWith("repo-radar-engine-smoke-"));
    assert.equal(await readFile(path.join(directory, ".fixture-owner"), "utf8"), marker, "Refusing cleanup without matching fixture ownership marker");
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  } catch (error) { cleanupErrors.push(sanitizedFailure(error)); }
  if (cleanupErrors.length) {
    const detail = `Disposable fixture cleanup incomplete at ${directory}: ${cleanupErrors.join("; ")}`;
    console.error(detail);
    if (!smokeError) process.exitCode = 1;
    // The pending original smoke failure remains the failure returned to Node.
  }
}
