import {
  constants,
  DatabaseSync,
  type SQLOutputValue,
  type StatementSync,
} from "node:sqlite";
import {
  MAX_CELL_CHARS,
  MAX_RESULT_CHARS,
  MAX_ROWS,
  SAMPLE_ROW_COUNT,
} from "./limits.js";

type Cell = number | string | null;

export interface QueryResult {
  columns: string[];
  rows: Cell[][];
  truncated: boolean;
}

interface CatalogEntry {
  name: string;
  type: "table" | "view";
}

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  pk: number;
}

interface ForeignKeyInfo {
  from: string;
  table: string;
  to: string;
}

/** SQLite's result code for a denied statement, which `node:sqlite` does not export. */
const SQLITE_AUTH = 23;

const READ_ACTIONS = new Set<number>([
  constants.SQLITE_SELECT,
  constants.SQLITE_READ,
  constants.SQLITE_FUNCTION,
  constants.SQLITE_RECURSIVE,
]);

const SCHEMA_PRAGMAS = new Set<string | null>(["table_info", "foreign_key_list"]);

/**
 * SQLite calls this while compiling every statement. Anything outside the
 * allowlist, including ATTACH and all other PRAGMAs, fails before it can run.
 */
export function authorizeReadsOnly(action: number, detail: string | null): number {
  const isAllowed =
    READ_ACTIONS.has(action) ||
    (action === constants.SQLITE_PRAGMA && SCHEMA_PRAGMAS.has(detail));

  return isAllowed ? constants.SQLITE_OK : constants.SQLITE_DENY;
}

export function openReadOnly(path: string): DatabaseSync {
  const db = new DatabaseSync(path, { readOnly: true });
  db.setAuthorizer(authorizeReadsOnly);
  return db;
}

const EMPTY_QUERY = "The query is empty: send one SELECT statement.";

/**
 * Blank text or a lone comment compiles to nothing. Before Node 24.22, `prepare`
 * still succeeds, and the only sign is that later access to the statement throws.
 */
function compiledLength(statement: StatementSync): number {
  try {
    return statement.sourceSQL.length;
  } catch {
    throw new Error(EMPTY_QUERY);
  }
}

function prepareSingleStatement(db: DatabaseSync, sql: string): StatementSync {
  let statement: StatementSync;
  try {
    statement = db.prepare(sql);
  } catch (error) {
    const { code, errcode } = error as { code?: string; errcode?: number };
    if (errcode === SQLITE_AUTH) {
      throw new Error("Rejected: only read-only SELECT statements are allowed.");
    }
    if (code === "ERR_INVALID_ARG_VALUE") {
      throw new Error(EMPTY_QUERY);
    }
    throw error;
  }

  // SQLite compiles only the first statement and ignores the rest without
  // reporting it. `sourceSQL` is the compiled part, so anything left over,
  // even a comment, is reported instead of being dropped.
  if (sql.slice(compiledLength(statement)).trim()) {
    throw new Error("Only one SQL statement is allowed per call.");
  }
  return statement;
}

function toCell(value: SQLOutputValue): Cell {
  if (typeof value === "bigint") {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (value instanceof Uint8Array) {
    return `<blob ${value.byteLength} bytes>`;
  }
  if (typeof value === "string" && value.length > MAX_CELL_CHARS) {
    return `${value.slice(0, MAX_CELL_CHARS)}... [cell truncated]`;
  }
  return value;
}

/**
 * The only read path for result rows, shared by every tool.
 *
 * Rows are arrays because rows keyed by column name would lose data when a
 * join returns two columns with the same name.
 */
export function runQuery(db: DatabaseSync, sql: string): QueryResult {
  const statement = prepareSingleStatement(db, sql);
  statement.setReadBigInts(true);
  statement.setReturnArrays(true);

  const columns = statement.columns().map((column) => column.name);
  const rows: Cell[][] = [];
  let resultChars = 0;

  // Iterating, rather than calling all(), stops SQLite as soon as a limit is
  // reached, so the rows beyond it are never produced.
  for (const rawRow of statement.iterate()) {
    const row = (rawRow as unknown as SQLOutputValue[]).map(toCell);
    resultChars += JSON.stringify(row).length;

    if (rows.length === MAX_ROWS || resultChars > MAX_RESULT_CHARS) {
      return { columns, rows, truncated: true };
    }
    rows.push(row);
  }

  return { columns, rows, truncated: false };
}

const quoteIdentifier = (name: string): string => `"${name.replaceAll('"', '""')}"`;

function countRows(db: DatabaseSync, table: string): number {
  const { rowCount } = db
    .prepare(`SELECT count(*) AS rowCount FROM ${quoteIdentifier(table)}`)
    .get() as { rowCount: number };
  return rowCount;
}

export function listTables(db: DatabaseSync) {
  const entries = db
    .prepare(
      `SELECT name, type FROM sqlite_schema
       WHERE type IN ('table', 'view') AND name NOT GLOB 'sqlite_*'
       ORDER BY name`,
    )
    .all() as unknown as CatalogEntry[];

  // Counting a view runs its whole query, so only tables get a row count.
  return entries.map(({ name, type }) => ({
    name,
    type,
    rowCount: type === "table" ? countRows(db, name) : null,
  }));
}

export function describeTable(db: DatabaseSync, table: string) {
  const columns = db
    .prepare("SELECT name, type, [notnull], pk FROM pragma_table_info(?)")
    .all(table) as unknown as ColumnInfo[];

  if (columns.length === 0) {
    throw new Error(`Unknown table: ${table}`);
  }

  const foreignKeys = db
    .prepare('SELECT "from", "table", "to" FROM pragma_foreign_key_list(?)')
    .all(table) as unknown as ForeignKeyInfo[];

  const sample = runQuery(
    db,
    `SELECT * FROM ${quoteIdentifier(table)} LIMIT ${SAMPLE_ROW_COUNT}`,
  );

  return {
    table,
    columns: columns.map(({ name, type, notnull, pk }) => ({
      name,
      type,
      nullable: notnull === 0,
      primaryKey: pk !== 0,
    })),
    foreignKeys: foreignKeys.map((key) => ({
      column: key.from,
      references: `${key.table}.${key.to}`,
    })),
    sampleRows: sample.rows,
  };
}
