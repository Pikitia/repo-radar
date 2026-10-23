interface Token { kind: "word" | "number" | "identifier" | "literal" | "comment" | "symbol"; value: string }
interface Table { header: Token[]; clauses: Token[][]; suffix: Token[]; innodb: boolean }
const word = (token: Token | undefined, value: string) => token?.kind === "word" && token.value.toUpperCase() === value;
const symbol = (token: Token | undefined, value: string) => token?.kind === "symbol" && token.value === value;

// Preserve the exact bytes of identifiers, literals and comments. SQL modes that
// change backslash or double-quote interpretation are deliberately unsupported.
function tokenize(sql: string): Token[] | undefined {
  if (!sql || sql.length > 2_000_000 || /[\\"\0]/.test(sql)) return;
  const result: Token[] = [];
  for (let index = 0; index < sql.length;) {
    const char = sql[index];
    if (/\s/.test(char)) { index++; continue; }
    const start = index;
    if (char === "'" || char === "`") {
      index++;
      let closed = false;
      while (index < sql.length) {
        if (sql[index++] !== char) continue;
        if (sql[index] === char) { index++; continue; }
        closed = true; break;
      }
      if (!closed) return;
      result.push({ kind: char === "`" ? "identifier" : "literal", value: sql.slice(start, index) });
    } else if (sql.startsWith("/*", index)) {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) return;
      index = end + 2;
      result.push({ kind: "comment", value: sql.slice(start, index) });
    } else if (char === "#" || (sql.startsWith("--", index) && /\s/.test(sql[index + 2] ?? " "))) {
      const end = sql.indexOf("\n", index);
      index = end < 0 ? sql.length : end;
      result.push({ kind: "comment", value: sql.slice(start, index) });
    } else {
      const identifier = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(sql.slice(index));
      const number = /^\d+(?:\.\d+)?/.exec(sql.slice(index));
      const value = identifier?.[0] ?? number?.[0] ?? char;
      result.push({ kind: identifier ? "word" : number ? "number" : "symbol", value });
      index += value.length;
    }
  }
  return result;
}

function parse(sql: string, tableName: string): Table | undefined {
  const tokens = tokenize(sql);
  if (!tokens || !word(tokens[0], "CREATE") || !word(tokens[1], "TABLE") || tokens[2]?.kind !== "identifier" || tokens[2].value.slice(1, -1).replaceAll("``", "`") !== tableName || !symbol(tokens[3], "(")) return;
  if (tokens.some((token, index) => symbol(token, ";") && index !== tokens.length - 1)) return;
  let depth = 0, start = 4, close = -1;
  const clauses: Token[][] = [];
  for (let index = 4; index < tokens.length; index++) {
    if (symbol(tokens[index], "(")) depth++;
    else if (symbol(tokens[index], ")")) {
      if (depth > 0) depth--;
      else { close = index; break; }
    } else if (depth === 0 && symbol(tokens[index], ",")) {
      if (start === index) return;
      clauses.push(tokens.slice(start, index)); start = index + 1;
    }
  }
  if (close < 0 || start === close) return;
  clauses.push(tokens.slice(start, close));
  const suffix = tokens.slice(close + 1);
  depth = 0;
  for (const token of suffix) {
    if (symbol(token, "(")) depth++;
    if (symbol(token, ")") && --depth < 0) return;
  }
  if (depth !== 0) return;
  const engines = suffix.flatMap((token, index) => word(token, "ENGINE") ? [symbol(suffix[index + 1], "=") ? suffix[index + 2] : suffix[index + 1]] : []);
  return { header: tokens.slice(0, 4), clauses, suffix, innodb: word(suffix[0], "ENGINE") && engines.length === 1 && word(engines[0], "INNODB") };
}

function normalizedColumn(tokens: Token[]): Token[] {
  if (tokens[0]?.kind !== "identifier" || tokens[1]?.kind !== "word") return tokens;
  if (tokens.some(token => token.kind === "word" && ["GENERATED", "VIRTUAL", "STORED", "AS", "ZEROFILL"].includes(token.value.toUpperCase()))) return tokens;
  let result = [...tokens];
  const type = tokens[1].value.toLowerCase();
  if (["tinyint", "smallint", "mediumint", "int", "bigint"].includes(type) && symbol(tokens[2], "(") && tokens[3]?.kind === "number" && /^[1-9]\d{0,2}$/.test(tokens[3].value) && Number(tokens[3].value) <= 255 && symbol(tokens[4], ")") && !(type === "tinyint" && Number(tokens[3].value) === 1)) result = [tokens[0], tokens[1], ...tokens.slice(5)];
  if (!["timestamp", "datetime"].includes(type)) return result;
  let precision = 0;
  if (symbol(tokens[2], "(")) {
    if (tokens[3]?.kind !== "number" || !/^[0-6]$/.test(tokens[3].value) || !symbol(tokens[4], ")")) return result;
    precision = Number(tokens[3].value);
  }
  const boundaries = ["COMMENT", "ON", "NOT", "NULL", "AUTO_INCREMENT", "INVISIBLE", "VISIBLE", "UNIQUE", "PRIMARY", "CHECK", "REFERENCES", "COLLATE", "CHARACTER", "STORAGE", "COLUMN_FORMAT"];
  let depth = 0;
  for (let index = 2; index < result.length; index++) {
    if (symbol(result[index], "(")) depth++;
    else if (symbol(result[index], ")")) depth--;
    if (depth !== 0) continue;
    const valueIndex = word(result[index], "DEFAULT") ? index + 1 : word(result[index], "ON") && word(result[index + 1], "UPDATE") ? index + 2 : -1;
    if (valueIndex < 0 || !word(result[valueIndex], "CURRENT_TIMESTAMP")) continue;
    let end = valueIndex + 1, expressionPrecision = 0;
    if (symbol(result[end], "(")) {
      if (symbol(result[end + 1], ")")) end += 2;
      else if (result[end + 1]?.kind === "number" && /^[0-6]$/.test(result[end + 1].value) && symbol(result[end + 2], ")")) { expressionPrecision = Number(result[end + 1].value); end += 3; }
      else continue;
    }
    if (expressionPrecision !== precision || (result[end] && !(result[end].kind === "word" && boundaries.includes(result[end].value.toUpperCase())))) continue;
    result.splice(valueIndex, end - valueIndex, { kind: "word", value: `CURRENT_TIMESTAMP(${precision})` });
  }
  return result;
}

function normalizedForeignKey(tokens: Token[]): Token[] {
  let index = 0;
  if (word(tokens[index], "CONSTRAINT")) { if (tokens[index + 1]?.kind !== "identifier") return tokens; index += 2; }
  if (!word(tokens[index++], "FOREIGN") || !word(tokens[index++], "KEY")) return tokens;
  if (tokens[index]?.kind === "identifier") index++;
  function identifiers(): boolean {
    if (!symbol(tokens[index++], "(")) return false;
    for (;;) {
      if (tokens[index++]?.kind !== "identifier") return false;
      if (symbol(tokens[index], ")")) { index++; return true; }
      if (!symbol(tokens[index++], ",")) return false;
    }
  }
  if (!identifiers() || !word(tokens[index++], "REFERENCES") || tokens[index++]?.kind !== "identifier") return tokens;
  if (symbol(tokens[index], ".")) { index++; if (tokens[index++]?.kind !== "identifier") return tokens; }
  if (!identifiers()) return tokens;
  const result = tokens.slice(0, index), actions = new Set<string>();
  while (index < tokens.length) {
    const start = index;
    if (!word(tokens[index++], "ON") || !(word(tokens[index], "UPDATE") || word(tokens[index], "DELETE"))) return tokens;
    const action = tokens[index++].value.toUpperCase();
    if (actions.has(action)) return tokens;
    actions.add(action);
    if (word(tokens[index], "RESTRICT")) index++;
    else if (word(tokens[index], "NO") && word(tokens[index + 1], "ACTION")) index += 2;
    else if (word(tokens[index], "CASCADE")) { index++; result.push(...tokens.slice(start, index)); }
    else if (word(tokens[index], "SET") && word(tokens[index + 1], "NULL")) { index += 2; result.push(...tokens.slice(start, index)); }
    else return tokens;
  }
  return result;
}

/** Presentation only. Every token outside these bounded representations remains exact. */
export function tableDefinitionsEquivalent(development: string, production: string, tableName: string): boolean {
  const a = parse(development, tableName), b = parse(production, tableName);
  if (!a || !b || a.clauses.length !== b.clauses.length) return false;
  const normalize = (table: Table) => [table.header, table.clauses.map(clause => a.innodb && b.innodb ? normalizedForeignKey(normalizedColumn(clause)) : normalizedColumn(clause)), table.suffix];
  return JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));
}
