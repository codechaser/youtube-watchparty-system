import { randomBytes, randomUUID } from "node:crypto";
import type {
  ActionRequest,
  Participant,
  RequestedAction,
  Role,
  RoomSnapshot,
} from "@watch-party/shared";

type Member = Omit<Participant, "connected"> & {
  socketIds: Set<string>;
  sessionToken: string;
};
type Room = {
  roomId: string;
  roomCode: string;
  hostUserId: string;
  videoId: string;
  playbackState: "playing" | "paused";
  currentTime: number;
  updatedAt: number;
  members: Map<string, Member>;
  requests: Map<string, ActionRequest>;
};
export class RoomService {
  private rooms = new Map<string, Room>();
  private codes = new Map<string, string>();
  create(username: string, socketId: string) {
    const roomId = randomUUID();
    let roomCode = "";
    do {
      roomCode = randomBytes(3).toString("hex").toUpperCase();
    } while (this.codes.has(roomCode));
    const userId = randomUUID();
    const now = Date.now();
    const room: Room = {
      roomId,
      roomCode,
      hostUserId: userId,
      videoId: "dQw4w9WgXcQ",
      playbackState: "paused",
      currentTime: 0,
      updatedAt: now,
      members: new Map(),
      requests: new Map(),
    };
    const sessionToken = randomBytes(32).toString("hex");
    room.members.set(userId, {
      userId,
      username,
      role: "host",
      joinedAt: now,
      socketIds: new Set([socketId]),
      sessionToken,
    });
    this.rooms.set(roomId, room);
    this.codes.set(roomCode, roomId);
    return { userId, sessionToken, snapshot: this.snapshot(room) };
  }
  find(idOrCode: string) {
    const id = this.codes.get(idOrCode.toUpperCase()) ?? idOrCode;
    return this.rooms.get(id);
  }
  join(
    idOrCode: string,
    username: string,
    socketId: string,
    sessionToken?: string,
  ) {
    const room = this.find(idOrCode);
    if (!room) throw new Error("ROOM_NOT_FOUND");
    let member = sessionToken
      ? [...room.members.values()].find((m) => m.sessionToken === sessionToken)
      : undefined;
    if (sessionToken && !member) throw new Error("INVALID_SESSION");
    if (
      !member &&
      [...room.members.values()].some(
        (m) => m.username.toLowerCase() === username.toLowerCase(),
      )
    )
      throw new Error("USERNAME_TAKEN");
    const wasConnected = member ? member.socketIds.size > 0 : false;
    if (member) member.socketIds.add(socketId);
    else {
      const userId = randomUUID();
      member = {
        userId,
        username,
        role: "participant",
        joinedAt: Date.now(),
        socketIds: new Set([socketId]),
        sessionToken: randomBytes(32).toString("hex"),
      };
      room.members.set(userId, member);
    }
    const joinedMember = member;
    return {
      userId: joinedMember.userId,
      sessionToken: joinedMember.sessionToken,
      snapshot: this.snapshot(room),
      participant: this.publicMember(joinedMember),
      presenceChanged: !wasConnected,
    };
  }
  room(id: string) {
    return this.rooms.get(id);
  }
  member(room: Room, userId: string) {
    return room.members.get(userId);
  }
  snapshot(room: Room): RoomSnapshot {
    const elapsed =
      room.playbackState === "playing"
        ? (Date.now() - room.updatedAt) / 1000
        : 0;
    return {
      roomId: room.roomId,
      roomCode: room.roomCode,
      hostUserId: room.hostUserId,
      videoId: room.videoId,
      playbackState: room.playbackState,
      currentTime: room.currentTime + elapsed,
      updatedAt: room.updatedAt,
      participants: [...room.members.values()].map((m) => this.publicMember(m)),
    };
  }
  publicMember(member: Member): Participant {
    return {
      userId: member.userId,
      username: member.username,
      role: member.role,
      joinedAt: member.joinedAt,
      connected: member.socketIds.size > 0,
    };
  }
  update(room: Room, action: RequestedAction) {
    const now = Date.now();
    if (room.playbackState === "playing" && action.type !== "play")
      room.currentTime += (now - room.updatedAt) / 1000;
    if (action.type === "play") room.playbackState = "playing";
    else if (action.type === "pause") room.playbackState = "paused";
    else if (action.type === "seek") room.currentTime = action.time;
    else {
      room.videoId = action.videoId;
      room.currentTime = 0;
    }
    room.updatedAt = now;
  }
  updateProgress(room: Room, time: number) {
    if (room.playbackState !== "playing") return;
    room.currentTime = time;
    room.updatedAt = Date.now();
  }
  assign(room: Room, userId: string, role: Role) {
    const member = room.members.get(userId);
    if (!member) throw new Error("PARTICIPANT_NOT_FOUND");
    if (userId === room.hostUserId) throw new Error("CANNOT_CHANGE_HOST_ROLE");
    member.role = role;
    return member;
  }
  remove(room: Room, userId: string) {
    if (userId === room.hostUserId) throw new Error("CANNOT_REMOVE_HOST");
    const member = room.members.get(userId);
    if (!member) throw new Error("PARTICIPANT_NOT_FOUND");
    room.members.delete(userId);
    return member;
  }
  addRequest(
    room: Room,
    userId: string,
    action: RequestedAction,
  ): ActionRequest {
    const member = room.members.get(userId);
    if (!member) throw new Error("NOT_IN_ROOM");
    const request = {
      requestId: randomUUID(),
      userId,
      username: member.username,
      action,
      createdAt: Date.now(),
    };
    room.requests.set(request.requestId, request);
    return request;
  }
  takeRequest(room: Room, requestId: string) {
    const req = room.requests.get(requestId);
    if (!req) throw new Error("REQUEST_NOT_FOUND");
    room.requests.delete(requestId);
    return req;
  }
  leave(room: Room, userId: string, socketId: string) {
    const member = room.members.get(userId);
    if (!member) return null;
    member.socketIds.delete(socketId);
    if (member.socketIds.size) return null;
    room.members.delete(userId);
    if (member.userId === room.hostUserId && room.members.size) {
      const next = room.members.values().next().value as Member;
      next.role = "host";
      room.hostUserId = next.userId;
    }
    if (!room.members.size) {
      this.rooms.delete(room.roomId);
      this.codes.delete(room.roomCode);
    }
    return member;
  }
  detach(room: Room, userId: string, socketId: string) {
    const member = room.members.get(userId);
    if (!member) return false;
    member.socketIds.delete(socketId);
    return member.socketIds.size === 0;
  }
  expire(room: Room, userId: string) {
    const member = room.members.get(userId);
    if (!member || member.socketIds.size) return null;
    room.members.delete(userId);
    if (member.userId === room.hostUserId && room.members.size) {
      const next = room.members.values().next().value as Member;
      next.role = "host";
      room.hostUserId = next.userId;
    }
    if (!room.members.size) {
      this.rooms.delete(room.roomId);
      this.codes.delete(room.roomCode);
    }
    return member;
  }
}
