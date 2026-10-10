import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
const file = resolve(process.env.DATABASE_PATH ?? "./data/watch-party.sqlite");
mkdirSync(dirname(file), { recursive: true });
const db = new Database(file);
db.pragma("journal_mode = WAL");
db.exec(
  "CREATE TABLE IF NOT EXISTS room_history (room_id TEXT PRIMARY KEY, room_code TEXT NOT NULL, created_at INTEGER NOT NULL)",
);
export const saveRoom = (roomId: string, roomCode: string) =>
  db
    .prepare(
      "INSERT OR REPLACE INTO room_history(room_id,room_code,created_at) VALUES(?,?,?)",
    )
    .run(roomId, roomCode, Date.now());

export const closeDatabase = () => db.close();
