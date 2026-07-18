import { createRequire } from "node:module";

export interface StatementSync {
  run(...parameters: any[]): { changes: number | bigint; lastInsertRowid?: number | bigint };
  get(...parameters: any[]): unknown;
  all(...parameters: any[]): unknown[];
}

export interface DatabaseSyncOptions {
  readOnly?: boolean;
  enableForeignKeyConstraints?: boolean;
  enableDoubleQuotedStringLiterals?: boolean;
}

const require = createRequire(import.meta.url);
const isBun = typeof process.versions.bun === "string";
const sqlite = require(isBun ? "bun:sqlite" : "node:sqlite") as Record<string, any>;

/** SQLite boundary shared by Pi's extension host and Node coordinator processes. */
export class DatabaseSync {
  private readonly database: any;

  constructor(filePath: string, options: DatabaseSyncOptions = {}) {
    if (isBun) {
      const Database = sqlite.Database;
      if (typeof Database !== "function") throw new Error("Pi host SQLite is unavailable");
      this.database = new Database(filePath, options.readOnly
        ? { readonly: true, create: false }
        : { readwrite: true, create: true });
    } else {
      const NativeDatabaseSync = sqlite.DatabaseSync;
      if (typeof NativeDatabaseSync !== "function") throw new Error("Node SQLite is unavailable");
      this.database = new NativeDatabaseSync(filePath, options);
    }
  }

  prepare(sql: string): StatementSync {
    return (isBun ? this.database.query(sql) : this.database.prepare(sql)) as StatementSync;
  }

  exec(sql: string): void {
    this.database.exec(sql);
  }

  close(): void {
    this.database.close();
  }
}
