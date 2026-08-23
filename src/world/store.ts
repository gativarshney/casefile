/**
 * SQLite storage for the payment world.
 *
 * The world is generated, never committed: it is reproducible from a seed and a
 * scenario configuration, and the dataset manifest pins exactly what was produced so a
 * reader can confirm they regenerated the same world rather than a similar one.
 *
 * The read side opens a read-only connection so nothing on the investigation path can
 * mutate the evidence it is about to seal.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import Database, { type Database as Db } from "better-sqlite3";
import { type Digest, merkleRoot } from "../canon/hash.js";
import {
  type ErasedRecordType,
  type RecordType,
  recordHash,
  WORLD_RECORD_TYPES,
} from "./schema.js";

/** Bumped when a schema change makes previously generated worlds unreadable. */
export const STORE_FORMAT_VERSION = 1;

export class IntegrityError extends Error {
  readonly subject: string;
  readonly expected: string | undefined;
  readonly actual: string | undefined;

  constructor(message: string, subject: string, expected?: string, actual?: string) {
    const detail =
      expected === undefined && actual === undefined
        ? `${message} [subject=${subject}]`
        : `${message} [subject=${subject}]\n  expected: ${expected}\n  actual:   ${actual}`;
    super(detail);
    this.name = "IntegrityError";
    this.subject = subject;
    this.expected = expected;
    this.actual = actual;
  }
}

export class StoreError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StoreError";
  }
}

export interface TableDigest {
  readonly count: number;
  readonly root: Digest;
}

export interface DatasetManifest {
  readonly storeFormatVersion: number;
  readonly provenance: Record<string, unknown>;
  readonly tables: Record<string, TableDigest>;
  readonly worldRoot: Digest;
}

function createTableSql(type: ErasedRecordType): string {
  const columns = type.columns.map((name) =>
    name === type.primaryKey ? `  ${name} TEXT PRIMARY KEY` : `  ${name}`,
  );
  // Stored only to make manifest construction cheap. Integrity checks recompute from
  // the row's own fields — see recordHash.
  columns.push("  record_hash TEXT NOT NULL");
  return `CREATE TABLE ${type.table} (\n${columns.join(",\n")}\n)`;
}

function toStorage(value: unknown): string | number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  if (typeof value === "number" || typeof value === "string") return value;
  throw new StoreError(`cannot store value of type ${typeof value}`);
}

export class WorldStore {
  private readonly db: Db;
  private readonly types: readonly ErasedRecordType[];

  constructor(
    readonly path: string,
    types: readonly ErasedRecordType[] = WORLD_RECORD_TYPES,
  ) {
    this.types = types;
    mkdirSync(dirname(path), { recursive: true });
    if (existsSync(path)) rmSync(path, { force: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    for (const type of this.types) this.db.exec(createTableSql(type));
  }

  insert<T extends Record<string, unknown>>(type: RecordType<T>, records: readonly T[]): number {
    const placeholders = type.columns
      .map(() => "?")
      .concat("?")
      .join(", ");
    const statement = this.db.prepare(
      `INSERT INTO ${type.table} (${[...type.columns, "record_hash"].join(", ")}) VALUES (${placeholders})`,
    );
    const insertAll = this.db.transaction((rows: readonly T[]) => {
      for (const row of rows) {
        const validated = type.parseUnknown(row);
        const values = type.columns.map((name) => toStorage(validated[name]));
        statement.run(...values, recordHash(type, validated));
      }
    });
    insertAll(records);
    return records.length;
  }

  /**
   * Ordering by primary key rather than by insertion makes the root a property of the
   * table's content, so two generators emitting the same rows in a different sequence
   * still agree.
   */
  tableDigest(table: string): TableDigest {
    const type = this.types.find((candidate) => candidate.table === table);
    if (!type) throw new StoreError(`${table} is not a table of this store`);
    const rows = this.db
      .prepare(`SELECT record_hash FROM ${table} ORDER BY ${type.primaryKey}`)
      .all() as { record_hash: string }[];
    return { count: rows.length, root: merkleRoot(rows.map((row) => row.record_hash)) };
  }

  manifest(provenance: Record<string, unknown> = {}): DatasetManifest {
    const tables: Record<string, TableDigest> = {};
    for (const type of this.types) tables[type.table] = this.tableDigest(type.table);
    return {
      storeFormatVersion: STORE_FORMAT_VERSION,
      provenance,
      tables,
      worldRoot: merkleRoot(this.types.map((type) => tables[type.table]?.root as Digest)),
    };
  }

  close(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
    this.db.close();
  }
}

export class WorldReader {
  private readonly db: Db;
  private readonly types: readonly ErasedRecordType[];

  constructor(
    readonly path: string,
    types: readonly ErasedRecordType[] = WORLD_RECORD_TYPES,
  ) {
    if (!existsSync(path)) {
      throw new StoreError(`no world at ${path}. Generate one first: casefile generate`);
    }
    this.types = types;
    this.db = new Database(path, { readonly: true, fileMustExist: true });
  }

  query<T>(type: RecordType<T>, where = "", params: readonly unknown[] = []): T[] {
    const clause = where === "" ? "" : ` WHERE ${where}`;
    const rows = this.db
      .prepare(`SELECT * FROM ${type.table}${clause} ORDER BY ${type.primaryKey}`)
      .all(...(params as never[])) as Record<string, unknown>[];
    return rows.map((row) => type.parse(restoreTypes(type, row)));
  }

  get<T>(type: RecordType<T>, key: string): T | undefined {
    return this.query(type, `${type.primaryKey} = ?`, [key])[0];
  }

  all<T>(type: RecordType<T>): T[] {
    return this.query(type);
  }

  count(table: string): number {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    return row.n;
  }

  /**
   * Recomputes every table root from the rows themselves rather than reading the stored
   * `record_hash` column, so a forgery that updates both the row and its digest still
   * fails here.
   */
  verifyAgainstManifest(manifest: DatasetManifest): void {
    for (const type of this.types) {
      const expected = manifest.tables[type.table];
      if (!expected) {
        throw new IntegrityError("manifest does not describe this table", type.table);
      }
      const records = this.readRaw(type);
      const actualRoot = merkleRoot(records.map((record) => recordHash(type, record)));
      if (records.length !== expected.count || actualRoot !== expected.root) {
        throw new IntegrityError(
          "table no longer matches the manifest it was generated with",
          type.table,
          `${expected.count} rows, root ${expected.root}`,
          `${records.length} rows, root ${actualRoot}`,
        );
      }
    }
  }

  private readRaw(type: ErasedRecordType): Record<string, unknown>[] {
    const rows = this.db
      .prepare(`SELECT * FROM ${type.table} ORDER BY ${type.primaryKey}`)
      .all() as Record<string, unknown>[];
    return rows.map((row) => type.parseUnknown(restoreTypes(type, row)));
  }

  close(): void {
    this.db.close();
  }
}

function restoreTypes(
  type: ErasedRecordType,
  row: Record<string, unknown>,
): Record<string, unknown> {
  const { record_hash: _sealed, ...rest } = row;
  for (const name of type.booleanColumns) {
    if (rest[name] !== null && rest[name] !== undefined) rest[name] = rest[name] === 1;
  }
  return rest;
}
