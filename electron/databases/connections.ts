import { createHash } from "node:crypto";
import { isIP } from "node:net";
import type { DatabaseConnectionConfig, DatabaseIdentity, DatabaseServerConnectionConfig } from "../../src/types/database.js";

export interface SqlSession {
  query(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  close(): Promise<void>;
  destroy?(): void;
}
export function databaseDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
type ConnectionSettings = Pick<DatabaseServerConnectionConfig, "host" | "port" | "tlsMode" | "tlsCa" | "credentials">;

async function createSession(config: ConnectionSettings, database?: string): Promise<SqlSession> {
  // Old protected profiles with a CA keep their verified transport until explicitly edited.
  const tlsMode = config.tlsMode ?? (config.tlsCa ? "verify" : "disabled");
  if (tlsMode !== "disabled" && tlsMode !== "verify") throw new Error("Unsupported database TLS mode");
  // mysql2 omits servername and identity verification for IP literals. Require a DNS
  // name whenever TLS is enabled so a valid CA certificate cannot impersonate it.
  const hostForIpCheck = config.host.startsWith("[") && config.host.endsWith("]") ? config.host.slice(1, -1) : config.host;
  if (tlsMode === "verify" && isIP(hostForIpCheck)) throw new Error("A certificate-matching DNS hostname is required for verified database TLS");
  try {
    const { default: mysql } = await import("mysql2/promise");
    const connection = await mysql.createConnection({ host: config.host, port: config.port, ...(database !== undefined ? { database } : {}), user: config.credentials.username, password: config.credentials.password, ...(tlsMode === "verify" ? { ssl: { ...(config.tlsCa ? { ca: config.tlsCa } : {}), rejectUnauthorized: true, verifyIdentity: true } } : {}), multipleStatements: false, connectTimeout: 10_000, supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, enableKeepAlive: true });
    const destroy = () => { try { connection.destroy(); } catch { /* already closed */ } };
    const discardBrokenSession = (error: unknown) => {
      const failure = error as { code?: unknown; fatal?: unknown } | null;
      // mysql2 inactivity timeouts reject without removing the active command.
      // Destroy before any journal/lock/QUIT command can queue behind it.
      if (failure && (failure.fatal === true || /^(?:PROTOCOL_|ECONN|ETIMEDOUT|EPIPE|ENET|EHOST)/.test(String(failure.code ?? "")))) destroy();
    };
    return {
      async query(sql, params = []) {
        try {
          const [rows] = await connection.query({ sql, timeout: 15_000 }, params);
          if (!Array.isArray(rows)) throw new Error("Expected database rows");
          return rows as Record<string, unknown>[];
        } catch (error) { discardBrokenSession(error); throw new Error("Database query failed. Verify target permissions and supported SQL; driver details are withheld because they may contain data or secrets."); }
      },
      async execute(sql, params = []) {
        try { await connection.query({ sql, timeout: 30_000 }, params); }
        catch (error) { discardBrokenSession(error); throw new Error("Database statement failed or its acknowledgment was lost. Review durable history before any further action; driver details are withheld."); }
      },
      // Cleanup must not overwrite a durable failed/uncertain runner result.
      async close() {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.resolve().then(() => connection.end()),
            new Promise<void>(resolve => { timer = setTimeout(() => { destroy(); resolve(); }, 2000); })
          ]);
        } catch { destroy(); } finally { if (timer) clearTimeout(timer); }
      },
      destroy
    };
  } catch { throw new Error("Database connection failed; verify the protected profile, credentials and TLS configuration"); }
}

/** Inspection connection without selecting a schema; credentials remain main-process only. */
export async function connectDatabaseServer(config: DatabaseServerConnectionConfig): Promise<SqlSession> { return createSession(config); }

/** Target connections always select the registered schema, never an agent-supplied USE command. */
export async function connectDatabase(config: DatabaseConnectionConfig): Promise<SqlSession> { return createSession(config, config.database); }

export interface DatabaseServerIdentity {
  serverId: string;
  engine: DatabaseIdentity["engine"];
  version: string;
  lowerCaseTableNames: number;
}

async function serverIdentity(session: SqlSession, row: Record<string, unknown>): Promise<DatabaseServerIdentity> {
  const version = String(row.version ?? "");
  const description = `${version} ${String(row.version_comment ?? "")}`;
  const engine = /mariadb/i.test(description) ? "mariadb" : /mysql|ubuntu|debian|source distribution/i.test(description) ? "mysql" : undefined;
  if (!engine) throw new Error("Only identifiable MySQL and MariaDB servers are supported");
  const parts = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
  const major = Number(parts?.[1]), minor = Number(parts?.[2]);
  if (!parts || !(engine === "mysql" ? major === 8 : (major === 10 && minor >= 6) || major === 11)) throw new Error("Unsupported database engine version; use MySQL 8 or MariaDB 10.6/11");
  const lowerCaseTableNames = Number(row.lower_case_table_names);
  if (!Number.isInteger(lowerCaseTableNames) || ![0, 1, 2].includes(lowerCaseTableNames)) throw new Error("Database server settings could not be verified");
  let serverId: string;
  if (engine === "mysql") {
    const [uuid] = await session.query("SELECT @@server_uuid AS server_uuid");
    if (!uuid?.server_uuid) throw new Error("The database server identity is unavailable");
    serverId = `mysql:${String(uuid.server_uuid)}`;
  } else {
    if (!row.hostname || row.port === undefined || row.server_id === undefined) throw new Error("The database server identity is unavailable");
    // MariaDB has no MySQL server_uuid: bind its server identity to all stable server attributes.
    serverId = `mariadb:${databaseDigest([row.hostname, String(row.port), String(row.server_id)])}`;
  }
  return { serverId, engine, version, lowerCaseTableNames };
}

export async function readServerIdentity(session: SqlSession): Promise<DatabaseServerIdentity> {
  const [row] = await session.query("SELECT VERSION() AS version, @@version_comment AS version_comment, @@hostname AS hostname, @@port AS port, @@server_id AS server_id, @@lower_case_table_names AS lower_case_table_names");
  if (!row) throw new Error("The database server identity is unavailable");
  return serverIdentity(session, row);
}

export async function readIdentity(session: SqlSession, database: string): Promise<DatabaseIdentity> {
  const [row] = await session.query("SELECT DATABASE() AS database_name, VERSION() AS version, @@version_comment AS version_comment, @@hostname AS hostname, @@port AS port, @@server_id AS server_id, @@sql_mode AS sql_mode, @@lower_case_table_names AS lower_case_table_names, @@character_set_database AS character_set_database, @@collation_database AS collation_database");
  if (!row || row.database_name !== database) throw new Error("Connected database does not match the registered target");
  const { serverId, engine, version, lowerCaseTableNames } = await serverIdentity(session, row);
  const settings = { sqlMode: String(row.sql_mode ?? ""), lowerCaseTableNames, characterSet: String(row.character_set_database ?? ""), collation: String(row.collation_database ?? "") };
  if (!settings.characterSet || !settings.collation) throw new Error("Database settings could not be verified");
  return { serverId, database, engine, version, settings, fingerprint: databaseDigest([serverId, database]) };
}
