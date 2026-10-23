import { describe, expect, it } from 'vitest';
import { freezeSql, splitSql } from '../../electron/databases/sql.js';

describe('migration SQL lexical validation', () => {
  it('keeps semicolons in literals and comments out of statement boundaries', () => {
    const statements = freezeSql(["-- explanation;\nINSERT INTO `stock` (`label`) VALUES ('a; b''s'); /* comment; */ UPDATE stock SET label = 'c'; # end;\n"]);
    expect(statements).toHaveLength(2);
    expect(statements[0].sql).toContain("'a; b''s'");
    expect(statements[0].digest).toHaveLength(64);
    expect(statements.map(item => item.ordinal)).toEqual([1, 2]);
  });

  it('lexes DELIMITER procedure bodies together, then refuses the whole unsupported script', () => {
    const sql = "DELIMITER $$\nCREATE PROCEDURE guarded() BEGIN SELECT 1; SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='stop; now'; END$$\nDELIMITER ;\nCALL guarded();";
    expect(splitSql(sql)).toHaveLength(2);
    expect(() => freezeSql([sql])).toThrow(/unsupported/i);
  });

  it.each([
    'PREPARE s FROM @query; EXECUTE s;',
    'UPDATE another.stock SET x=1;',
    'UPDATE `another`.`stock` SET x=1;',
    'DROP TABLE `db_radar_events`;',
    "SELECT 1 INTO OUTFILE 'C:/export';",
    'GRANT ALL ON stock TO other;',
    'SET FOREIGN_KEY_CHECKS=0;',
    'CREATE TRIGGER unsafe BEFORE INSERT ON stock FOR EACH ROW SET @x=1;',
    "INSERT INTO stock VALUES (evil_function());",
    '/*!50000 DROP TABLE stock */;',
    '/*M! DROP TABLE stock */;',
    'INSERT INTO stock VALUES (@secret);',
    'START TRANSACTION; UPDATE stock SET x=1; COMMIT;',
    "INSERT INTO stock VALUES ('back\\slash');",
    'INSERT INTO "stock" VALUES (1);',
    "UPDATE stock SET x = SLEEP(20);",
    "CREATE TABLE stock (x INT) ENGINE=CONNECT TABLE_TYPE=CSV FILE_NAME='/etc/passwd';",
    "CREATE TABLE stock (x INT) DATA DIRECTORY='/tmp';",
    'INSERT INTO stock VALUES (函数());',
    'INSERT INTO stock VALUES (`COUNT`());',
    'UPDATE stock JOIN other_table ON evil_function(stock_id) SET value = 1;',
    'UPDATE stock JOIN other_table ON `evil_function`(stock_id) SET value = 1;',
  ])('rejects unsupported SQL before execution: %s', sql => {
    expect(() => freezeSql([sql])).toThrow();
  });

  it('accepts table/index DDL, data changes and guarded read checks', () => {
    expect(freezeSql(['CREATE TABLE stock (id BIGINT PRIMARY KEY, label VARCHAR(50)); ALTER TABLE stock ADD COLUMN x INT; CREATE INDEX ix ON stock (x); DROP INDEX ix ON stock;'])).toHaveLength(4);
    expect(freezeSql(['SELECT COUNT(*) AS count FROM stock WHERE id IN (1, 2)'], 'check')).toHaveLength(1);
    expect(freezeSql(['CREATE UNIQUE INDEX uq_stock ON `stock` (`x`)'])).toHaveLength(1);
    expect(() => freezeSql(['SELECT 1 FOR UPDATE'], 'check')).toThrow();
    expect(() => freezeSql(["SELECT evil_function()"], 'check')).toThrow();
  });

  it.each([
    'CREATE TABLE IF NOT EXISTS stock (id BIGINT PRIMARY KEY, label VARCHAR(255))',
    'create table if not exists `stock` (id INT)',
    'CREATE TABLE IF NOT EXISTS `stock``archive` (id INT)',
  ])('accepts an IF NOT EXISTS table declaration without treating its name as a function: %s', sql => {
    const statements = freezeSql([`${sql};`]);
    expect(statements).toHaveLength(1);
    expect(statements[0]).toEqual({ ordinal: 1, sql, digest: expect.stringMatching(/^[a-f0-9]{64}$/), kind: 'ddl' });
    // Preserve the declared spelling/quoting for rehearsal's owned-table cleanup.
    expect(statements[0].sql).toBe(sql);
  });

  it.each([
    'CREATE TABLE IF NOT EXISTS other.stock (id INT)',
    'CREATE TABLE IF NOT EXISTS `db_radar_events` (id INT)',
    'CREATE TABLE IF NOT EXISTS stock (id INT DEFAULT (evil_function()))',
  ])('keeps IF NOT EXISTS declarations subject to normal safety checks: %s', sql => {
    expect(() => freezeSql([sql])).toThrow();
  });

  it('accepts MariaDB SHOW CREATE TABLE named KEY declarations for isolated baseline replay', () => {
    const sql = "CREATE TABLE `stock` (\n  `id` int(11) NOT NULL,\n  `value` int(11) NOT NULL,\n  PRIMARY KEY (`id`),\n  KEY `ix_value` (`value`),\n  UNIQUE KEY `uq_value` (`value`,`id`)\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci";
    const statements = freezeSql([sql]);
    expect(statements).toHaveLength(1);
    expect(statements[0].sql).toBe(sql);
    expect(statements[0].kind).toBe('ddl');
    expect(freezeSql(['ALTER TABLE `stock` ADD KEY `ix_value` (`value`)'])).toHaveLength(1);
  });

  it('does not confuse named index declarations with calls to unsupported SQL functions', () => {
    expect(() => freezeSql(['CREATE TABLE stock (value INT, KEY ix_value ((evil_function(value))))'])).toThrow('Unknown SQL function');
    expect(() => freezeSql(['ALTER TABLE stock ADD KEY ix_value ((evil_function(value)))'])).toThrow('Unknown SQL function');
    expect(() => freezeSql(['SELECT evil_function(value) FROM stock'], 'check')).toThrow('Unknown SQL function');
    expect(() => freezeSql(['INSERT INTO stock (value) VALUES (evil_function())'])).toThrow('Unknown SQL function');
  });

  it('rejects unfinished lexical states', () => {
    expect(() => splitSql("INSERT INTO stock VALUES ('unfinished")).toThrow();
    expect(() => splitSql('/* unfinished')).toThrow();
    expect(() => splitSql('SELECT 1;\nDELIMITER $$$$$$$$$\n')).toThrow();
  });
});
