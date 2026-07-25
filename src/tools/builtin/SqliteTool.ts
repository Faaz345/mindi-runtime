/**
 * SQLite Tool — query, schema, export, transactions.
 *
 * Uses the `better-sqlite3` package if available.
 */

import type {
  CapabilityInput,
  CapabilityResult,
  CapabilityType,
  ExecutionContext,
} from "../../core/types.js";
import { ToolError } from "../../core/errors.js";
import { ToolBase, type ToolMetadata, type ToolRetryPolicy, assertPermissions } from "../sdk/ToolBase.js";

const CAP: CapabilityType = "database";

const METADATA: ToolMetadata = {
  id: "tool.sqlite",
  label: "SQLite",
  description: "SQLite database: query, schema, export, transactions",
  capability: CAP,
  version: "1.0.0",
  permissions: ["filesystem.read", "filesystem.write"],
  operations: ["query", "schema", "export", "transaction"],
  inputSchema: {
    type: "object",
    properties: {
      op: { type: "string", enum: ["query", "schema", "export", "transaction"] },
      database: { type: "string", description: "path to .db file" },
      sql: { type: "string" },
      params: { type: "array" },
    },
    required: ["op", "database"],
  },
  streaming: false,
  defaultTimeoutMs: 30_000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, retryableErrors: [] } as ToolRetryPolicy,
};

export class SqliteTool extends ToolBase {
  readonly id = "tool.sqlite";
  readonly label = "SQLite";
  readonly capability: CapabilityType = CAP;
  readonly metadata = METADATA;

  protected async run(input: CapabilityInput, ctx: ExecutionContext): Promise<CapabilityResult> {
    assertPermissions(this.sb.getPolicy(), this.metadata.permissions);

    const op = String(input.params.op ?? "");
    const dbPath = this.sb.resolvePath(String(input.params.database ?? ""));
    const sql = String(input.params.sql ?? "");
    const params = Array.isArray(input.params.params) ? input.params.params : [];

    const start = Date.now();
    ctx.log.debug("sqlite.execute", { op, dbPath, sql: sql.slice(0, 80) });

    const Database = await importSqlite();
    const db = new Database(dbPath, { readonly: op === "schema" || op === "export" });

    try {
      switch (op) {
        case "query": {
          const rows = db.prepare(sql).all(...params);
          return result(this.id, true, { rows, count: rows.length }, start);
        }
        case "schema": {
          const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type='table'").all();
          return result(this.id, true, { tables }, start);
        }
        case "export": {
          const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>;
          const dump: Record<string, unknown[]> = {};
          for (const { name } of tables) {
            dump[name] = db.prepare(`SELECT * FROM ${name}`).all();
          }
          return result(this.id, true, { dump }, start);
        }
        case "transaction": {
          // Execute multiple statements in a transaction.
          const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
          const results: unknown[] = [];
          db.transaction(() => {
            for (const stmt of statements) {
              results.push(db.prepare(stmt).all());
            }
          })();
          return result(this.id, true, { results, count: results.length }, start);
        }
        default:
          throw new ToolError("E_TOOL_FAILED", `SqliteTool: unknown op "${op}"`, { op });
      }
    } catch (err) {
      return {
        type: CAP, source: this.id, ok: false,
        payload: { kind: "text", text: `SQLite error: ${err instanceof Error ? err.message : String(err)}` },
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    } finally {
      db.close();
    }
  }
}

function result(source: string, ok: boolean, data: Record<string, unknown>, start: number): CapabilityResult {
  return { type: CAP, source, ok, payload: { kind: "structured", data }, durationMs: Date.now() - start };
}

async function importSqlite(): Promise<new (path: string, opts?: { readonly?: boolean }) => {
  prepare: (sql: string) => { all: (...params: unknown[]) => unknown[] };
  transaction: (fn: () => void) => () => void;
  close: () => void;
}> {
  try {
    const mod = await import("better-sqlite3");
    return mod.default ?? mod;
  } catch {
    throw new ToolError("E_TOOL_FAILED", "better-sqlite3 is not installed. Run: npm install better-sqlite3", {});
  }
}
