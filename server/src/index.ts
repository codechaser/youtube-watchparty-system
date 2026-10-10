import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import { createServer } from "node:http";
import { Server } from "socket.io";
import { z } from "zod";
import type {
  ClientToServerEvents,
  ServerToClientEvents,
  Ack,
  RoomSnapshot,
  Role,
  RequestedAction,
} from "@watch-party/shared";
import { RoomService } from "./rooms.js";
import { closeDatabase, saveRoom } from "./database.js";
import { canPlay, canAssignRole, canRemoveParticipant } from "./permissions.js";
import {
  joinRoomSchema,
  requestedActionSchema,
  seekTimeSchema,
  usernameSchema,
  videoIdSchema,
} from "./validation.js";

dotenv.config({ path: process.env.DOTENV_CONFIG_PATH ?? "../.env" });
const app = express();
const allowedOrigins = new Set(
  (process.env.CLIENT_ORIGIN ?? "http://localhost:5173")
    .split(",")
    .map((value) => value.trim()),
);
const allowOrigin = (
  requestOrigin: string | undefined,
  callback: (error: Error | null, allowed?: boolean) => void,
) => {
  const localDevelopmentOrigin =
    process.env.NODE_ENV !== "production" &&
    !!requestOrigin &&
    /^https?:\/\/(localhost|127\.0\.0\.1):\d+$/.test(requestOrigin);
  if (
    !requestOrigin ||
    allowedOrigins.has(requestOrigin) ||
    localDevelopmentOrigin
  )
    callback(null, true);
  else callback(new Error("Origin is not allowed"), false);
};
app.use(cors({ origin: allowOrigin }));
app.get("/health", (_req, res) => res.json({ status: "ok" }));
const http = createServer(app);
const io = new Server<ClientToServerEvents, ServerToClientEvents>(http, {
  cors: { origin: allowOrigin, methods: ["GET", "POST"] },
  transports: ["websocket"],
});
const rooms = new RoomService();
const identities = new Map<string, { roomId: string; userId: string }>();
function fail(
  ack: Ack<any> | undefined,
  code: string,
  message: string,
  socketId: string,
) {
  const result = { ok: false as const, error: { code, message } };
  if (typeof ack === "function") ack(result);
  io.to(socketId).emit("room_error", { code, message });
}
function success<T>(ack: Ack<T> | undefined, data: T) {
  if (typeof ack === "function") ack({ ok: true, data });
}
function current(socketId: string) {
  const identity = identities.get(socketId);
  if (!identity) return null;
  const room = rooms.room(identity.roomId);
  const member = room && rooms.member(room, identity.userId);
  return room && member ? { room, member, identity } : null;
}
function sync(roomId: string) {
  const room = rooms.room(roomId);
  if (room) io.to(roomId).emit("sync_state", rooms.snapshot(room));
}
function apply(roomId: string, action: RequestedAction) {
  const room = rooms.room(roomId);
  if (!room) return;
  rooms.update(room, action);
  sync(roomId);
}
io.on("connection", (socket) => {
  socket.emit("connection_status", { connected: true });
  function leave(roomId: string) {
    const identity = identities.get(socket.id);
    if (!identity || identity.roomId !== roomId) return;
    const room = rooms.room(identity.roomId);
    if (room) {
      const member = rooms.leave(room, identity.userId, socket.id);
      socket.leave(room.roomId);
      if (member) {
        const snapshot = rooms.snapshot(room);
        io.to(room.roomId).emit("user_left", {
          userId: member.userId,
          username: member.username,
          participants: snapshot.participants,
        });
        const host = snapshot.participants.find((p) => p.role === "host");
        if (host && member.role === "host")
          io.to(room.roomId).emit("role_assigned", {
            userId: host.userId,
            username: host.username,
            role: "host",
            participants: snapshot.participants,
          });
      }
    }
    identities.delete(socket.id);
  }
  socket.on("create_room", (payload, ack) => {
    const parsed = usernameSchema.safeParse(payload?.username);
    if (!parsed.success)
      return fail(
        ack,
        "INVALID_USERNAME",
        "Use a name between 2 and 24 letters, numbers, spaces, _ or -.",
        socket.id,
      );
    const previous = identities.get(socket.id);
    if (previous) leave(previous.roomId);
    const created = rooms.create(parsed.data, socket.id);
    identities.set(socket.id, {
      roomId: created.snapshot.roomId,
      userId: created.userId,
    });
    socket.join(created.snapshot.roomId);
    try {
      saveRoom(created.snapshot.roomId, created.snapshot.roomCode);
    } catch (error) {
      console.error("Could not persist room history", error);
    }
    success(ack, {
      snapshot: created.snapshot,
      userId: created.userId,
      sessionToken: created.sessionToken,
    });
  });
  socket.on("join_room", (payload, ack) => {
    const parsed = joinRoomSchema.safeParse(payload);
    if (!parsed.success)
      return fail(
        ack,
        "INVALID_PAYLOAD",
        "Enter a valid room code and username.",
        socket.id,
      );
    const targetRoom = rooms.find(parsed.data.roomId);
    if (!targetRoom)
      return fail(
        ack,
        "ROOM_NOT_FOUND",
        "That room could not be found. Check the code or invite link.",
        socket.id,
      );
    const previous = current(socket.id);
    if (
      previous &&
      previous.room.roomId === targetRoom.roomId &&
      previous.member.sessionToken !== parsed.data.sessionToken
    )
      return fail(
        ack,
        "ALREADY_IN_ROOM",
        "Leave this room before joining with another identity.",
        socket.id,
      );
    if (previous && previous.room.roomId !== targetRoom.roomId)
      leave(previous.room.roomId);
    try {
      const joined = rooms.join(
        parsed.data.roomId,
        parsed.data.username,
        socket.id,
        parsed.data.sessionToken,
      );
      identities.set(socket.id, {
        roomId: joined.snapshot.roomId,
        userId: joined.userId,
      });
      socket.join(joined.snapshot.roomId);
      socket.emit("sync_state", joined.snapshot);
      if (joined.presenceChanged && parsed.data.sessionToken) {
        io.to(joined.snapshot.roomId).emit("participant_presence", {
          userId: joined.userId,
          connected: true,
          participants: joined.snapshot.participants,
        });
      } else if (!parsed.data.sessionToken)
        socket.to(joined.snapshot.roomId).emit("user_joined", {
          participant: joined.participant,
          participants: joined.snapshot.participants,
        });
      success(ack, {
        snapshot: joined.snapshot,
        userId: joined.userId,
        sessionToken: joined.sessionToken,
      });
    } catch (e) {
      const reason = e instanceof Error ? e.message : "";
      const code =
        reason === "USERNAME_TAKEN"
          ? "USERNAME_TAKEN"
          : reason === "INVALID_SESSION"
            ? "INVALID_SESSION"
            : "ROOM_NOT_FOUND";
      const message =
        code === "USERNAME_TAKEN"
          ? "That name is already in use in this room. Choose another name."
          : code === "INVALID_SESSION"
            ? "This room session has expired. Join with a new name."
            : "That room could not be found. Check the code or invite link.";
      fail(ack, code, message, socket.id);
    }
  });
  socket.on("leave_room", (payload) => {
    const parsed = z
      .object({ roomId: z.string().min(1).max(80) })
      .safeParse(payload);
    if (!parsed.success)
      return fail(
        undefined,
        "INVALID_PAYLOAD",
        "A valid room ID is required to leave.",
        socket.id,
      );
    leave(parsed.data.roomId);
  });
  socket.on("disconnect", () => {
    const item = current(socket.id);
    if (item) {
      const lastSocket = rooms.detach(item.room, item.member.userId, socket.id);
      identities.delete(socket.id);
      if (lastSocket) {
        const snapshot = rooms.snapshot(item.room);
        io.to(item.room.roomId).emit("participant_presence", {
          userId: item.member.userId,
          connected: false,
          participants: snapshot.participants,
        });
      }
      const expiryTimer = setTimeout(() => {
        const removed = rooms.expire(item.room, item.member.userId);
        if (removed) {
          const snapshot = rooms.snapshot(item.room);
          io.to(item.room.roomId).emit("user_left", {
            userId: removed.userId,
            username: removed.username,
            participants: snapshot.participants,
          });
          const newHost = snapshot.participants.find((p) => p.role === "host");
          if (newHost && removed.role === "host")
            io.to(item.room.roomId).emit("role_assigned", {
              userId: newHost.userId,
              username: newHost.username,
              role: "host",
              participants: snapshot.participants,
            });
        }
      }, 90000);
      expiryTimer.unref();
    }
    socket.emit("connection_status", {
      connected: false,
      message: "Connection lost",
    });
  });
  const mutate = (action: RequestedAction, ack?: Ack<RoomSnapshot>) => {
    const item = current(socket.id);
    if (!item)
      return fail(
        ack,
        "NOT_IN_ROOM",
        "Join a room before controlling playback.",
        socket.id,
      );
    if (!canPlay(item.member.role))
      return fail(
        ack,
        "FORBIDDEN",
        "Only the Host or a Moderator can control playback. Request approval instead.",
        socket.id,
      );
    apply(item.room.roomId, action);
    success(ack, rooms.snapshot(item.room));
  };
  socket.on("play", (ack) => mutate({ type: "play" }, ack));
  socket.on("pause", (ack) => mutate({ type: "pause" }, ack));
  socket.on("seek", (p, ack) => {
    const v = z.object({ time: seekTimeSchema }).safeParse(p);
    if (!v.success)
      return fail(
        ack,
        "INVALID_TIME",
        "Seek time must be between 0 and 24 hours.",
        socket.id,
      );
    mutate({ type: "seek", time: v.data.time }, ack);
  });
  socket.on("playback_progress", (p, ack) => {
    const item = current(socket.id);
    if (!item)
      return fail(
        ack,
        "NOT_IN_ROOM",
        "Join a room before syncing playback.",
        socket.id,
      );
    if (!canPlay(item.member.role))
      return fail(
        ack,
        "FORBIDDEN",
        "Only the Host or a Moderator can sync playback.",
        socket.id,
      );
    if (item.room.playbackState !== "playing") return;
    const parsed = z.object({ time: seekTimeSchema }).safeParse(p);
    if (!parsed.success)
      return fail(
        ack,
        "INVALID_TIME",
        "Playback time must be between 0 and 24 hours.",
        socket.id,
      );
    rooms.updateProgress(item.room, parsed.data.time);
    success(ack, undefined);
  });
  socket.on("change_video", (p, ack) => {
    const v = z.object({ videoId: videoIdSchema }).safeParse(p);
    if (!v.success)
      return fail(
        ack,
        "INVALID_VIDEO",
        "Enter an 11-character YouTube video ID using only letters, numbers, underscores, or hyphens.",
        socket.id,
      );
    mutate({ type: "change_video", videoId: v.data.videoId }, ack);
  });
  socket.on("assign_role", (p, ack) => {
    const item = current(socket.id);
    if (!item) return fail(ack, "NOT_IN_ROOM", "Join a room first.", socket.id);
    if (!canAssignRole(item.member.role))
      return fail(
        ack,
        "FORBIDDEN",
        "Only the Host can assign roles.",
        socket.id,
      );
    const v = z
      .object({
        userId: z.string().uuid(),
        role: z.enum(["moderator", "participant"]),
      })
      .safeParse(p);
    if (!v.success)
      return fail(
        ack,
        "INVALID_ROLE",
        "Choose Moderator or Participant.",
        socket.id,
      );
    try {
      const target = rooms.assign(item.room, v.data.userId, v.data.role);
      const snap = rooms.snapshot(item.room);
      io.to(item.room.roomId).emit("role_assigned", {
        userId: target.userId,
        username: target.username,
        role: target.role,
        participants: snap.participants,
      });
      success(ack, snap);
    } catch (e) {
      fail(
        ack,
        "PARTICIPANT_NOT_FOUND",
        "That participant is no longer in the room.",
        socket.id,
      );
    }
  });
  socket.on("remove_participant", (p, ack) => {
    const item = current(socket.id);
    if (!item) return fail(ack, "NOT_IN_ROOM", "Join a room first.", socket.id);
    if (!canRemoveParticipant(item.member.role))
      return fail(
        ack,
        "FORBIDDEN",
        "Only the Host can remove participants.",
        socket.id,
      );
    const v = z.object({ userId: z.string().uuid() }).safeParse(p);
    if (!v.success)
      return fail(ack, "INVALID_PAYLOAD", "Invalid participant.", socket.id);
    try {
      const target = rooms.remove(item.room, v.data.userId);
      const ids = [...target.socketIds];
      for (const id of ids) {
        identities.delete(id);
        io.sockets.sockets.get(id)?.leave(item.room.roomId);
        io.to(id).emit("participant_removed", {
          userId: target.userId,
          participants: rooms.snapshot(item.room).participants,
        });
      }
      io.to(item.room.roomId).emit("user_left", {
        userId: target.userId,
        username: target.username,
        participants: rooms.snapshot(item.room).participants,
      });
      success(ack, undefined);
    } catch (e) {
      fail(
        ack,
        "PARTICIPANT_NOT_FOUND",
        "That participant is no longer in the room.",
        socket.id,
      );
    }
  });
  socket.on("request_action", (p, ack) => {
    const item = current(socket.id);
    if (!item) return fail(ack, "NOT_IN_ROOM", "Join a room first.", socket.id);
    if (item.member.role !== "participant")
      return fail(
        ack,
        "NOT_NEEDED",
        "You already have playback controls.",
        socket.id,
      );
    const v = requestedActionSchema.safeParse(p);
    if (!v.success)
      return fail(
        ack,
        "INVALID_REQUEST",
        "The requested action is invalid.",
        socket.id,
      );
    const request = rooms.addRequest(item.room, item.member.userId, v.data);
    io.to(item.room.roomId).emit("request_created", request);
    success(ack, request);
  });
  socket.on("resolve_request", (p, ack) => {
    const item = current(socket.id);
    if (!item) return fail(ack, "NOT_IN_ROOM", "Join a room first.", socket.id);
    if (!canPlay(item.member.role))
      return fail(
        ack,
        "FORBIDDEN",
        "Only the Host or a Moderator can review requests.",
        socket.id,
      );
    const v = z
      .object({ requestId: z.string().uuid(), approved: z.boolean() })
      .safeParse(p);
    if (!v.success)
      return fail(
        ack,
        "INVALID_PAYLOAD",
        "Invalid request decision.",
        socket.id,
      );
    try {
      const req = rooms.takeRequest(item.room, v.data.requestId);
      if (v.data.approved) apply(item.room.roomId, req.action);
      io.to(item.room.roomId).emit("request_resolved", {
        requestId: req.requestId,
        approved: v.data.approved,
        by: item.member.username,
      });
      success(ack, undefined);
    } catch (e) {
      fail(
        ack,
        "REQUEST_NOT_FOUND",
        "That request is no longer available.",
        socket.id,
      );
    }
  });
});
const port = Number(process.env.PORT ?? 3001);
export { closeDatabase, http, io };
