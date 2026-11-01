import type { DatabaseSync } from "node:sqlite";
import { Schema } from "effect";
import type { OptMemoryId, OptMemoryWriteInput } from "../../contracts/memory/opt-memory-data";
import {
  MemoryNode,
  MemoryTreeState,
  initialMemoryTreeState,
  type MemoryTreeAdapter,
} from "./memory-tree";

const Row = Schema.Struct({ data: Schema.String });
const Source = Schema.Struct({ id: Schema.Int });
const Note = Schema.Struct({
  sourceId: Schema.String,
  text: Schema.String,
  sourceSessionId: Schema.String,
});
const StateDocument = Schema.Struct({ version: Schema.Literal(1), state: MemoryTreeState });

/** Only intentional notes live here. Pi session transcripts are never read or stored.
 * SQLite commits are synchronous and short; no provider callback runs in a transaction. */
export function createAutomationMemoryStore(database: DatabaseSync) {
  const version = Schema.decodeUnknownSync(Schema.Struct({ user_version: Schema.Int }))(
    database.prepare("PRAGMA user_version").get(),
  ).user_version;
  if (version !== 0 && version !== 1)
    throw new Error(`Unsupported OptMemory database version ${version}`);
  database.exec(`
    PRAGMA journal_mode = WAL;
    BEGIN;
    CREATE TABLE IF NOT EXISTS memory_notes (
      id INTEGER PRIMARY KEY, memory_id TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS memory_notes_owner ON memory_notes(memory_id, id);
    CREATE TABLE IF NOT EXISTS memory_nodes (
      id INTEGER PRIMARY KEY, memory_id TEXT NOT NULL, data TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS memory_states (
      memory_id TEXT PRIMARY KEY, data TEXT NOT NULL
    );
    PRAGMA user_version = 1;
    COMMIT;
  `);
  const transaction = (operation: () => void) => {
    database.exec("BEGIN IMMEDIATE");
    try {
      operation();
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  };
  const save = (memoryId: OptMemoryId, state: MemoryTreeState) => {
    database
      .prepare(
        "INSERT INTO memory_states(memory_id, data) VALUES (?, ?) ON CONFLICT(memory_id) DO UPDATE SET data = excluded.data",
      )
      .run(memoryId, JSON.stringify({ version: 1, state }));
  };
  const note = async (memoryId: OptMemoryId, entry: number) =>
    Schema.decodeUnknownPromise(Schema.fromJsonString(Note))(
      Schema.decodeUnknownSync(Row)(
        database
          .prepare("SELECT data FROM memory_notes WHERE memory_id = ? AND id = ?")
          .get(memoryId, entry),
      ).data,
    );
  return {
    write(input: OptMemoryWriteInput) {
      const sourceId = crypto.randomUUID();
      database
        .prepare("INSERT INTO memory_notes(memory_id, data) VALUES (?, ?)")
        .run(
          input.memoryId,
          JSON.stringify({ sourceId, text: input.text, sourceSessionId: input.sourceSessionId }),
        );
      return { sourceId };
    },
    originals(memoryId: OptMemoryId, through: number | null) {
      return Schema.decodeUnknownSync(Schema.Array(Source))(
        database
          .prepare(
            "SELECT id FROM memory_notes WHERE memory_id = ? AND id > ? ORDER BY id LIMIT 64",
          )
          .all(memoryId, through ?? -1),
      );
    },
    note,
    adapter(
      memoryId: OptMemoryId,
    ): Pick<MemoryTreeAdapter, "state" | "node" | "save" | "append" | "original"> {
      return {
        state: async (signal) => {
          signal.throwIfAborted();
          const row = database
            .prepare("SELECT data FROM memory_states WHERE memory_id = ?")
            .get(memoryId);
          return row
            ? (
                await Schema.decodeUnknownPromise(Schema.fromJsonString(StateDocument))(
                  Schema.decodeUnknownSync(Row)(row).data,
                )
              ).state
            : initialMemoryTreeState();
        },
        node: async (entry, signal) => {
          signal.throwIfAborted();
          const row = database
            .prepare("SELECT data FROM memory_nodes WHERE memory_id = ? AND id = ?")
            .get(memoryId, entry);
          return {
            ...(await Schema.decodeUnknownPromise(Schema.fromJsonString(MemoryNode))(
              Schema.decodeUnknownSync(Row)(row).data,
            )),
            entry,
          };
        },
        save: async (state, signal) => {
          signal.throwIfAborted();
          save(memoryId, state);
        },
        append: async (node, state, assigned, signal) => {
          signal.throwIfAborted();
          transaction(() => {
            const result = database
              .prepare("INSERT INTO memory_nodes(memory_id, data) VALUES (?, ?)")
              .run(memoryId, JSON.stringify(node));
            assigned(Number(result.lastInsertRowid));
            save(memoryId, state);
          });
        },
        original: async (entry, signal) => {
          signal.throwIfAborted();
          const original = await note(memoryId, entry);
          return `note: [session=${original.sourceSessionId}] ${original.text}`;
        },
      };
    },
  };
}
