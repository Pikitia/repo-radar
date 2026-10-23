import { createHash } from 'node:crypto';
import type { FrozenSqlStatement } from '../../src/types/databaseExecution.js';

interface Token { value: string; identifier: boolean; quoted?: boolean }

export const sqlDigest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

/** A bounded lexical reader, not a semicolon split. Unsupported SQL fails closed. */
export function splitSql(source: string): string[] {
  if (source.length > 2_000_000 || source.includes('\0')) throw new Error('SQL input is invalid or too large.');
  const statements: string[] = [];
  let buffer = '';
  let delimiter = ';';
  let quote = '';
  let comment: 'line' | 'block' | '' = '';
  let lineStart = true;
  for (let index = 0; index < source.length;) {
    const char = source[index];
    const next = source[index + 1];
    if (comment === 'line') {
      if (char === '\n') { comment = ''; buffer += '\n'; lineStart = true; }
      index++; continue;
    }
    if (comment === 'block') {
      if (char === '*' && next === '/') { comment = ''; buffer += ' '; index += 2; }
      else index++;
      continue;
    }
    if (quote) {
      if (char === '\\' && quote !== '`') throw new Error('Backslash string escapes require SQL-mode-aware parsing and are unsupported.');
      buffer += char;
      if (char === quote) {
        if (next === quote) { buffer += next; index += 2; continue; }
        quote = '';
      }
      index++; continue;
    }
    if (lineStart && /[ \t\r]/.test(char)) { buffer += char; index++; continue; }
    if (lineStart && /^DELIMITER\b/i.test(source.slice(index))) {
      if (buffer.trim()) throw new Error('DELIMITER must occur between statements.');
      const end = source.indexOf('\n', index);
      const directive = source.slice(index, end < 0 ? source.length : end).trim();
      const match = /^DELIMITER[ \t]+([^\s]{1,8})$/i.exec(directive);
      if (!match || /['"`\\]|\/\*|--|#/.test(match[1])) throw new Error('Unsupported DELIMITER directive.');
      delimiter = match[1]; buffer = ''; index = end < 0 ? source.length : end + 1; lineStart = true; continue;
    }
    if (source.startsWith(delimiter, index)) {
      if (buffer.trim()) statements.push(buffer.trim());
      if (statements.length > 10_000) throw new Error('Too many SQL statements.');
      buffer = ''; index += delimiter.length; lineStart = false; continue;
    }
    if (char === '/' && next === '*') {
      if (source[index + 2] === '!' || source[index + 2] === '+' || source[index + 2]?.toUpperCase() === 'M') throw new Error('Executable or optimizer comments are unsupported.');
      comment = 'block'; index += 2; continue;
    }
    if (char === '#' || (char === '-' && next === '-' && /\s/.test(source[index + 2] ?? ' '))) {
      comment = 'line'; index += char === '#' ? 1 : 2; continue;
    }
    if (char === '"') throw new Error('Double-quoted SQL is unsupported; use single-quoted values and backtick identifiers.');
    if (char === "'" || char === '`') quote = char;
    buffer += char; lineStart = char === '\n'; index++;
  }
  if (quote || comment === 'block') throw new Error('Unterminated SQL literal or comment.');
  if (buffer.trim()) statements.push(buffer.trim());
  return statements;
}

function tokens(sql: string): Token[] {
  const result: Token[] = [];
  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    if (/\s/.test(char)) { index++; continue; }
    if (char === "'" || char === '`') {
      const quote = char;
      let value = ''; index++;
      while (index < sql.length) {
        if (sql[index] === quote) {
          if (sql[index + 1] === quote) { value += quote; index += 2; continue; }
          index++; break;
        }
        value += sql[index++];
      }
      result.push({ value: quote === '`' ? value.toUpperCase() : '<literal>', identifier: quote === '`', quoted: quote === '`' });
    } else if (/[A-Za-z_$]/.test(char)) {
      const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(sql.slice(index))![0];
      result.push({ value: match.toUpperCase(), identifier: true }); index += match.length;
    } else if (/[0-9]/.test(char)) {
      const match = /^\d+(?:\.\d+)?/.exec(sql.slice(index))![0];
      result.push({ value: match, identifier: false }); index += match.length;
    } else {
      if (char.charCodeAt(0) > 127) throw new Error('Unquoted non-ASCII SQL identifiers are unsupported; use backticks.');
      result.push({ value: char, identifier: false }); index++;
    }
  }
  return result;
}

const forbidden = new Set(['PREPARE', 'EXECUTE', 'DEALLOCATE', 'CALL', 'PROCEDURE', 'FUNCTION', 'TRIGGER', 'EVENT', 'DEFINER', 'GRANT', 'REVOKE', 'USER', 'ROLE', 'PASSWORD', 'OUTFILE', 'DUMPFILE', 'INFILE', 'LOAD', 'INSTALL', 'UNINSTALL', 'PLUGIN', 'SONAME', 'HANDLER', 'FLUSH', 'RESET', 'KILL', 'SHUTDOWN', 'RENAME', 'USE', 'DATABASE', 'SCHEMA', 'TABLESPACE', 'SERVER', 'FEDERATED', 'CONNECTION', 'LOCK', 'UNLOCK', 'GET_LOCK', 'RELEASE_LOCK', 'RELEASE_ALL_LOCKS', 'IS_USED_LOCK', 'IS_FREE_LOCK', 'SLEEP', 'BENCHMARK', 'LOAD_FILE', 'INFORMATION_SCHEMA', 'PERFORMANCE_SCHEMA', 'MYSQL', 'SYS', 'SQL_LOG_BIN', 'AUTOCOMMIT', 'TRANSACTION', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'XA']);
const safeCalls = new Set(['COUNT', 'SUM', 'MIN', 'MAX', 'AVG', 'COALESCE', 'IFNULL', 'NULLIF', 'ABS', 'ROUND', 'LOWER', 'UPPER', 'LENGTH', 'CHAR_LENGTH', 'CONCAT', 'CONCAT_WS', 'TRIM', 'CAST', 'CONVERT', 'NOW', 'CURRENT_TIMESTAMP', 'CURRENT_DATE', 'DATE', 'DATE_ADD', 'DATE_SUB', 'DATEDIFF', 'JSON_EXTRACT', 'JSON_UNQUOTE', 'JSON_VALID', 'JSON_OBJECT', 'JSON_ARRAY', 'VALUES', 'IN', 'EXISTS', 'CHECK', 'KEY', 'INDEX', 'UNIQUE', 'PRIMARY', 'FOREIGN', 'REFERENCES', 'DECIMAL', 'NUMERIC', 'VARCHAR', 'CHAR', 'BINARY', 'VARBINARY', 'BIT', 'INT', 'INTEGER', 'BIGINT', 'TINYINT', 'SMALLINT', 'MEDIUMINT', 'FLOAT', 'DOUBLE', 'DATETIME', 'TIMESTAMP', 'TIME', 'ENUM', 'SET']);

/** Validate every statement before constructing a plan, including unused down files. */
export function freezeSql(sources: readonly string[], purpose: 'migration' | 'check' = 'migration'): FrozenSqlStatement[] {
  const statements = sources.flatMap(splitSql);
  return statements.map((sql, index) => {
    const words = tokens(sql);
    if (!words.length || words.some(token => forbidden.has(token.value) || ['DIRECTORY', 'DATAFILE', 'FILE_NAME', 'CONNECT', 'SQL_SECURITY'].includes(token.value) || (token.identifier && /^DB_RADAR_/i.test(token.value)) || ['.', '@', ':', ';', '\\'].includes(token.value))) throw new Error('SQL contains unsupported privileged, cross-schema, dynamic, or history operations.');
    const first = words[0].value;
    let kind: FrozenSqlStatement['kind'];
    if (purpose === 'check') {
      if (first !== 'SELECT' || words.some(token => ['INTO', 'FOR', 'OUTFILE'].includes(token.value))) throw new Error('Checks must be read-only SELECT statements.');
      kind = 'check';
    } else if (['INSERT', 'UPDATE', 'DELETE'].includes(first)) kind = 'dml';
    else if ((['CREATE', 'ALTER', 'DROP'].includes(first)) && ['TABLE', 'INDEX', 'UNIQUE'].includes(words[1]?.value)) kind = 'ddl';
    else throw new Error('Unsupported SQL statement; routines, triggers, views, events and dynamic SQL must be rewritten as supported table migrations.');
    if (words.some(token => ['SELECT', 'WITH'].includes(token.value)) && purpose !== 'check') throw new Error('Subqueries and INSERT SELECT are unsupported in migration statements.');
    // Reject calls to stored functions/UDFs. Object declarations and table column lists are allowed.
    for (let cursor = 0; cursor < words.length - 1; cursor++) {
      if (!words[cursor].identifier || words[cursor + 1].value !== '(' || (!words[cursor].quoted && safeCalls.has(words[cursor].value))) continue;
      const previous = words[cursor - 1]?.value;
      if (kind === 'ddl' && first === 'CREATE' && words[1]?.value === 'TABLE' && cursor === 5 && words[2]?.value === 'IF' && words[3]?.value === 'NOT' && previous === 'EXISTS') continue;
      if (kind === 'ddl' && ['CREATE', 'ALTER'].includes(first) && words[1]?.value === 'TABLE' && previous === 'KEY') continue;
      if (kind !== 'check' && ['TABLE', 'INTO', 'INDEX', 'REFERENCES'].includes(previous)) continue;
      if (kind === 'ddl' && first === 'CREATE' && ['INDEX', 'UNIQUE'].includes(words[1]?.value) && previous === 'ON') continue;
      throw new Error('Unknown SQL function calls are unsupported.');
    }
    return Object.freeze({ ordinal: index + 1, sql, digest: sqlDigest(sql), kind });
  });
}
