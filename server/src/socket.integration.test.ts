import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { io as createClient, type Socket } from "socket.io-client";
import type { ClientToServerEvents, ServerToClientEvents } from "@watch-party/shared";

type TestSocket = Socket<ServerToClientEvents, ClientToServerEvents>;
type AckResult<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };

let server: typeof import("./index.js");
let address: string;
let temporaryDirectory: string;
const clients = new Set<TestSocket>();

before(async () => {
  temporaryDirectory = mkdtempSync(join(tmpdir(), "watch-party-socket-test-"));
  const envFile = join(temporaryDirectory, "test.env");
  writeFileSync(envFile, "");
  process.env.NODE_ENV = "test";
  process.env.PORT = "0";
  process.env.DATABASE_PATH = join(temporaryDirectory, "test.sqlite");
  process.env.DOTENV_CONFIG_PATH = envFile;

  server = await import("./index.js");
  await new Promise<void>((resolve, reject) => {
    server.http.once("error", reject);
    server.http.listen(0, "127.0.0.1", resolve);
  });
  const listeningAddress = server.http.address();
  assert.ok(listeningAddress && typeof listeningAddress !== "string");
  address = `http://127.0.0.1:${listeningAddress.port}`;
});

after(async () => {
  for (const client of clients) client.disconnect();
  clients.clear();
  if (server?.io) await new Promise<void>((resolve) => server.io.close(() => resolve()));
  server?.closeDatabase();
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
});

function connectClient(): Promise<TestSocket> {
  const socket = createClient(address, {
    transports: ["websocket"],
    forceNew: true,
    timeout: 3000,
  });
  clients.add(socket);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Socket.IO client timed out")), 3000);
    socket.once("connect", () => {
      clearTimeout(timer);
      resolve(socket);
    });
    socket.once("connect_error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Socket.IO connection failed: ${error.message}`));
    });
  });
}

function waitForEvent<T>(
  socket: TestSocket,
  event: keyof ServerToClientEvents,
  predicate: (payload: T) => boolean = () => true,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off(event as never, listener as never);
      reject(new Error(`Timed out waiting for ${String(event)}`));
    }, 3000);
    const listener = (payload: T) => {
      if (!predicate(payload)) return;
      clearTimeout(timer);
      socket.off(event as never, listener as never);
      resolve(payload);
    };
    socket.on(event as never, listener as never);
  });
}

function emitAck<T = unknown>(
  socket: TestSocket,
  event: string,
  ...args: unknown[]
): Promise<AckResult<T>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${event} acknowledgement timed out`)), 3000);
    socket.emit(event as never, ...([...args, (result: AckResult<T>) => {
      clearTimeout(timer);
      resolve(result);
    }] as never));
  });
}

async function createRoomPair() {
  const host = await connectClient();
  const created = await emitAck<{
    snapshot: { roomId: string; roomCode: string; videoId: string };
    userId: string;
    sessionToken: string;
  }>(host, "create_room", { username: "RoomHost" });
  assert.equal(created.ok, true);

  const guest = await connectClient();
  const joined = await emitAck<{
    snapshot: { roomId: string; roomCode: string; videoId: string };
    userId: string;
    sessionToken: string;
  }>(guest, "join_room", {
    roomId: created.data.snapshot.roomCode,
    username: "RoomGuest",
  });
  assert.equal(joined.ok, true);
  return { host, guest, room: created.data.snapshot, guestUserId: joined.data.userId };
}

it("broadcasts play, pause, seek, and video changes between room clients", async () => {
  const { host, guest } = await createRoomPair();

  const playingAtGuest = waitForEvent<{ playbackState: string }>(
    guest,
    "sync_state",
    (state) => state.playbackState === "playing",
  );
  const playResult = await emitAck(host, "play");
  assert.equal(playResult.ok, true);
  assert.equal((await playingAtGuest).playbackState, "playing");

  const pausedAtGuest = waitForEvent<{ playbackState: string }>(
    guest,
    "sync_state",
    (state) => state.playbackState === "paused",
  );
  const pauseResult = await emitAck(host, "pause");
  assert.equal(pauseResult.ok, true);
  assert.equal((await pausedAtGuest).playbackState, "paused");

  const seekAtGuest = waitForEvent<{ currentTime: number }>(
    guest,
    "sync_state",
    (state) => state.currentTime === 73,
  );
  const seekResult = await emitAck(host, "seek", { time: 73 });
  assert.equal(seekResult.ok, true);
  assert.equal((await seekAtGuest).currentTime, 73);

  const videoAtGuest = waitForEvent<{ videoId: string; currentTime: number }>(
    guest,
    "sync_state",
    (state) => state.videoId === "M7lc1UVf-VE",
  );
  const videoResult = await emitAck(host, "change_video", {
    videoId: "M7lc1UVf-VE",
  });
  assert.equal(videoResult.ok, true);
  const videoState = await videoAtGuest;
  assert.equal(videoState.videoId, "M7lc1UVf-VE");
  assert.equal(videoState.currentTime, 0);
});

it("allows moderator video changes and rejects direct participant playback mutations", async () => {
  const { host, guest, guestUserId } = await createRoomPair();
  const roleAtGuest = waitForEvent<{ userId: string; role: string }>(
    guest,
    "role_assigned",
    (payload) => payload.userId === guestUserId,
  );
  const promoted = await emitAck(host, "assign_role", {
    userId: guestUserId,
    role: "moderator",
  });
  assert.equal(promoted.ok, true);
  assert.equal((await roleAtGuest).role, "moderator");

  const videoAtHost = waitForEvent<{ videoId: string }>(
    host,
    "sync_state",
    (state) => state.videoId === "dQw4w9WgXcQ",
  );
  const moderatorChange = await emitAck(guest, "change_video", {
    videoId: "dQw4w9WgXcQ",
  });
  assert.equal(moderatorChange.ok, true);
  assert.equal((await videoAtHost).videoId, "dQw4w9WgXcQ");

  const demoted = await emitAck(host, "assign_role", {
    userId: guestUserId,
    role: "participant",
  });
  assert.equal(demoted.ok, true);

  let hostBroadcasts = 0;
  const countBroadcast = () => hostBroadcasts++;
  host.on("sync_state", countBroadcast);
  const forbiddenActions: Array<[string, unknown[]]> = [
    ["play", []],
    ["pause", []],
    ["seek", [{ time: 19 }]],
    ["change_video", [{ videoId: "9bZkp7q19f0" }]],
  ];
  for (const [event, args] of forbiddenActions) {
    const result = await emitAck(guest, event, ...args);
    assert.equal(result.ok, false, `${event} should be forbidden`);
    if (!result.ok) assert.equal(result.error.code, "FORBIDDEN");
  }
  await new Promise((resolve) => setTimeout(resolve, 40));
  host.off("sync_state", countBroadcast);
  assert.equal(hostBroadcasts, 0, "rejected participant actions must not broadcast room state");
});
