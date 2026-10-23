import { describe, expect, it } from "vitest";
import { tableDefinitionsEquivalent } from "../../src/components/schemaTableDefinition.js";

const table = (body: string, suffix = "ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin") => `CREATE TABLE \`items\` (\n${body}\n) ${suffix}`;
const equal = (a: string, b: string) => tableDefinitionsEquivalent(a, b, "items");
const fk = (action = "") => `CONSTRAINT \`fk_parent\` FOREIGN KEY (\`parent_id\`) REFERENCES \`parents\` (\`id\`)${action ? ` ${action}` : ""}`;

describe("bounded table-definition representation comparison", () => {
  it("combines integer width and temporal default/on-update spelling", () => {
    expect(equal(table("`id` int(11) DEFAULT NULL, `updated` timestamp NOT NULL DEFAULT current_timestamp() ON UPDATE current_timestamp()"), table("`id` int DEFAULT NULL, `updated` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP"))).toBe(true);
  });

  it.each(["ON UPDATE RESTRICT", "ON UPDATE NO ACTION", "ON DELETE RESTRICT ON UPDATE RESTRICT", "ON DELETE NO ACTION ON UPDATE NO ACTION"])("recognizes InnoDB omitted actions versus %s", action => {
    expect(equal(table(fk(action)), table(fk()))).toBe(true);
    expect(equal(table(fk()), table(fk(action)))).toBe(true);
  });

  it("retains non-default actions while normalizing the other action", () => {
    expect(equal(table(fk("ON DELETE CASCADE ON UPDATE RESTRICT")), table(fk("ON DELETE CASCADE")))).toBe(true);
  });

  it("retains fractional precision", () => {
    expect(equal(table("`updated` timestamp(6) DEFAULT current_timestamp(6) ON UPDATE current_timestamp(6)"), table("`updated` timestamp(6) DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6)"))).toBe(true);
    expect(equal(table("`updated` timestamp(6) DEFAULT CURRENT_TIMESTAMP(6)"), table("`updated` timestamp(6) DEFAULT CURRENT_TIMESTAMP"))).toBe(false);
  });

  it("ignores whitespace outside quoted tokens without changing the inputs", () => {
    const a = table("`id` int(11) DEFAULT NULL");
    const b = "CREATE TABLE `items` (`id` int DEFAULT NULL) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin";
    const originals = [a, b];
    expect(equal(a, b)).toBe(true);
    expect([a, b]).toEqual(originals);
  });

  it.each([
    ["`id` int(11) unsigned", "`id` int"],
    ["`id` tinyint(1)", "`id` tinyint"],
    ["`id` int(11) ZEROFILL", "`id` int ZEROFILL"],
    ["`id` int(11) AS (1) STORED", "`id` int AS (1) STORED"],
    ["`id` int(11) GENERATED ALWAYS AS (1) VIRTUAL", "`id` int GENERATED ALWAYS AS (1) VIRTUAL"],
    ["`id` int DEFAULT 1", "`id` int DEFAULT 2"],
    ["`id` varchar(20) DEFAULT 'NULL'", "`id` varchar(20) DEFAULT NULL"],
    ["`id` varchar(20) DEFAULT 'current_timestamp()'", "`id` varchar(20) DEFAULT 'CURRENT_TIMESTAMP'"],
    ["`updated` timestamp DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP", "`updated` timestamp DEFAULT CURRENT_TIMESTAMP"],
    ["`updated` timestamp(3) DEFAULT CURRENT_TIMESTAMP(3)", "`updated` timestamp(6) DEFAULT CURRENT_TIMESTAMP(6)"],
    ["`updated` timestamp DEFAULT CURRENT_TIMESTAMP", "`updated` datetime DEFAULT CURRENT_TIMESTAMP"],
    ["`updated` timestamp DEFAULT current_timestamp() + INTERVAL 1 SECOND", "`updated` timestamp DEFAULT CURRENT_TIMESTAMP + INTERVAL 1 SECOND"],
    ["`updated` timestamp DEFAULT current_timestamp() UNKNOWN_OPTION", "`updated` timestamp DEFAULT CURRENT_TIMESTAMP UNKNOWN_OPTION"],
    ["`updated` timestamp DEFAULT (current_timestamp())", "`updated` timestamp DEFAULT (CURRENT_TIMESTAMP)"],
    ["`updated` timestamp(6) DEFAULT current_timestamp()", "`updated` timestamp(6) DEFAULT CURRENT_TIMESTAMP"],
    ["`id` int COMMENT 'first'", "`id` int COMMENT 'second'"],
    ["`id` int, CHECK (`id` > 0)", "`id` int, CHECK (`id` > 1)"],
    ["`id` int, CHECK (`id` > 0)", "`id` int"],
    ["`id` int, KEY `ix` (`id`) INVISIBLE", "`id` int, KEY `ix` (`id`) VISIBLE"],
    ["`id` varchar(20), KEY `ix` (`id`(2))", "`id` varchar(20), KEY `ix` (`id`(3))"],
    ["`id` longtext", "`id` json"],
    ["`id` int /* keep */", "`id` int /* changed */"],
    ["`id` int COMMENT 'int(11) current_timestamp()'", "`id` int COMMENT 'int CURRENT_TIMESTAMP'"],
    ["`id` int, CHECK (current_timestamp() > '2000-01-01')", "`id` int, CHECK (CURRENT_TIMESTAMP > '2000-01-01')"],
    ["`id` int, KEY `Case` (`id`)", "`id` int, KEY `case` (`id`)"],
    [fk("ON UPDATE CASCADE"), fk("ON UPDATE RESTRICT")],
    [fk("MATCH FULL ON UPDATE RESTRICT"), fk("MATCH FULL")]
  ])("retains significant or unsupported body changes %s → %s", (a, b) => {
    expect(equal(table(a), table(b))).toBe(false);
  });

  it.each([
    ["ENGINE=InnoDB", "ENGINE=NDB"],
    ["ENGINE=InnoDB DEFAULT CHARSET=utf8mb4", "ENGINE=InnoDB DEFAULT CHARSET=latin1"],
    ["ENGINE=InnoDB COLLATE=utf8mb4_bin", "ENGINE=InnoDB COLLATE=utf8mb4_unicode_ci"],
    ["ENGINE=InnoDB ROW_FORMAT=DYNAMIC", "ENGINE=InnoDB ROW_FORMAT=COMPACT"],
    ["ENGINE=InnoDB UNKNOWN_OPTION=1", "ENGINE=InnoDB UNKNOWN_OPTION=2"],
    ["ENGINE=InnoDB PARTITION BY HASH (`id`) PARTITIONS 2", "ENGINE=InnoDB PARTITION BY HASH (`id`) PARTITIONS 3"],
    ["ENGINE=InnoDB /*!50100 PARTITION BY HASH (`id`) PARTITIONS 2 */", "ENGINE=InnoDB /*!50100 PARTITION BY HASH (`id`) PARTITIONS 3 */"]
  ])("compares the entire suffix %s → %s", (a, b) => {
    expect(equal(table("`id` int(11)", a), table("`id` int", b))).toBe(false);
  });

  it.each(["ENGINE=NDB", "ENGINE=MyISAM", "DEFAULT CHARSET=utf8mb4", "ENGINE=InnoDB ENGINE=NDB", "PARTITION BY HASH (`id`) (PARTITION `p0` ENGINE=InnoDB)", "COMMENT=ENGINE InnoDB"])("does not assume InnoDB for %s", suffix => {
    expect(equal(table(fk("ON UPDATE RESTRICT"), suffix), table(fk(), suffix))).toBe(false);
  });

  it.each([
    "CREATE TABLE `other` (`id` int)",
    "CREATE TABLE items (`id` int)",
    "CREATE TABLE `items` (`id` int); DROP TABLE `items`",
    "CREATE TABLE `items` (`id` varchar(20) DEFAULT 'a\\b')",
    'CREATE TABLE `items` (`id` varchar(20) DEFAULT "a")',
    "CREATE TABLE `items` (`id` varchar(20) DEFAULT 'unterminated)",
    "CREATE TABLE `items` (`id` int /* unterminated)",
    "CREATE TABLE `items` (`id` int",
    "CREATE TABLE `items` (`id` int,, `x` int)",
    "CREATE TABLE `items` ()",
    "CREATE TABLE `items` (`id` int) ENGINE=InnoDB PARTITION BY HASH (`id`",
    "CREATE TABLE `items` (`id` int) ENGINE=InnoDB )"
  ])("fails closed on unsupported SQL %s", sql => {
    expect(equal(sql, sql)).toBe(false);
  });

  it("retains exact escaped quoted identifiers and literal contents", () => {
    expect(tableDefinitionsEquivalent("CREATE TABLE `a``b` (`x` int(11) COMMENT 'it''s unchanged') ENGINE=InnoDB", "CREATE TABLE `a``b` (`x` int COMMENT 'it''s unchanged') ENGINE=InnoDB", "a`b")).toBe(true);
  });
});
