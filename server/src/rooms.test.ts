import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { extractYouTubeVideoId, isYouTubeVideoId } from "@watch-party/shared";
import { RoomService } from "./rooms.js";
import {
  canAssignRole,
  canChangeVideo,
  canPlay,
  canRemoveParticipant,
  canSeek,
} from "./permissions.js";
import {
  joinRoomSchema,
  requestedActionSchema,
  seekTimeSchema,
  videoIdSchema,
} from "./validation.js";

describe("role permissions", () => {
  it("allows hosts and moderators, but not participants, to control playback", () => {
    assert.equal(canPlay("host"), true);
    assert.equal(canPlay("moderator"), true);
    assert.equal(canPlay("participant"), false);
    assert.equal(canSeek("moderator"), true);
    assert.equal(canChangeVideo("moderator"), true);
  });

  it("restricts role assignment and participant removal to the host", () => {
    assert.equal(canAssignRole("host"), true);
    assert.equal(canAssignRole("participant"), false);
    assert.equal(canRemoveParticipant("host"), true);
    assert.equal(canRemoveParticipant("participant"), false);
  });
});

describe("room state", () => {
  it("creates unique rooms and assigns their creators as host", () => {
    const service = new RoomService();
    const a = service.create("Jamie", "s1");
    const b = service.create("Alex", "s2");
    assert.equal(a.snapshot.participants[0].role, "host");
    assert.notEqual(a.snapshot.roomCode, b.snapshot.roomCode);
  });

  it("joins, synchronizes state, updates playback and leaves", () => {
    const service = new RoomService();
    const created = service.create("Jamie", "s1");
    const joined = service.join(created.snapshot.roomCode, "Alex", "s2");
    assert.equal(joined.snapshot.participants.length, 2);
    assert.equal(joined.snapshot.participants[1].connected, true);
    assert.equal(joined.snapshot.participants[0].username, "Jamie");
    assert.equal(joined.snapshot.videoId, created.snapshot.videoId);
    const room = service.room(created.snapshot.roomId)!;
    service.update(room, { type: "seek", time: 41 });
    service.update(room, { type: "pause" });
    assert.equal(service.snapshot(room).currentTime, 41);
    assert.equal(service.snapshot(room).playbackState, "paused");
    service.leave(room, joined.userId, "s2");
    assert.equal(service.snapshot(room).participants.length, 1);
  });

  it("tracks playback progress so a pause preserves the current position", () => {
    const service = new RoomService();
    const created = service.create("Jamie", "s1");
    const room = service.room(created.snapshot.roomId)!;
    service.update(room, { type: "play" });
    service.updateProgress(room, 52.5);
    service.update(room, { type: "pause" });
    assert.ok(service.snapshot(room).currentTime >= 52.5);
    assert.equal(service.snapshot(room).playbackState, "paused");
  });

  it("resets playback position when the room video changes", () => {
    const service = new RoomService();
    const created = service.create("Jamie", "s1");
    const room = service.room(created.snapshot.roomId)!;
    service.update(room, { type: "seek", time: 184 });
    service.update(room, { type: "change_video", videoId: "M7lc1UVf-VE" });

    const snapshot = service.snapshot(room);
    assert.equal(snapshot.videoId, "M7lc1UVf-VE");
    assert.equal(snapshot.currentTime, 0);
  });

  it("supports role promotion and request resolution", () => {
    const service = new RoomService();
    const host = service.create("Jamie", "s1");
    const guest = service.join(host.snapshot.roomId, "Alex", "s2");
    const room = service.room(host.snapshot.roomId)!;
    service.assign(room, guest.userId, "moderator");
    assert.equal(service.snapshot(room).participants[1].role, "moderator");
    const request = service.addRequest(room, host.userId, { type: "play" });
    assert.equal(
      service.takeRequest(room, request.requestId).action.type,
      "play",
    );
  });

  it("reconnects with a server-issued token and rejects username impersonation", () => {
    const service = new RoomService();
    const host = service.create("Jamie", "s1");
    assert.throws(() => service.join(host.snapshot.roomId, "Jamie", "s2"));
    service.detach(service.room(host.snapshot.roomId)!, host.userId, "s1");
    const resumed = service.join(
      host.snapshot.roomId,
      "Untrusted name",
      "s2",
      host.sessionToken,
    );
    assert.equal(resumed.userId, host.userId);
    assert.equal(resumed.participant.role, "host");
    assert.equal(resumed.snapshot.participants[0].connected, true);
    assert.equal(resumed.presenceChanged, true);
  });

  it("marks a participant offline on disconnect and restores presence on reconnect", () => {
    const service = new RoomService();
    const host = service.create("Jamie", "s1");
    const guest = service.join(host.snapshot.roomId, "Alex", "s2");
    const room = service.room(host.snapshot.roomId)!;

    assert.equal(service.detach(room, guest.userId, "s2"), true);
    assert.equal(
      service.snapshot(room).participants.find((p) => p.userId === guest.userId)
        ?.connected,
      false,
    );

    const resumed = service.join(
      host.snapshot.roomId,
      "Alex",
      "s3",
      guest.sessionToken,
    );
    assert.equal(resumed.userId, guest.userId);
    assert.equal(resumed.participant.role, "participant");
    assert.equal(resumed.presenceChanged, true);
    assert.equal(resumed.snapshot.participants.length, 2);
    assert.equal(resumed.snapshot.participants[1].connected, true);
  });

  it("does not double count an identity with multiple active sockets", () => {
    const service = new RoomService();
    const host = service.create("Jamie", "s1");
    const guest = service.join(host.snapshot.roomId, "Alex", "s2");
    const room = service.room(host.snapshot.roomId)!;
    const secondSocket = service.join(
      host.snapshot.roomId,
      "Alex",
      "s3",
      guest.sessionToken,
    );

    assert.equal(secondSocket.presenceChanged, false);
    assert.equal(secondSocket.snapshot.participants.length, 2);
    assert.equal(service.detach(room, guest.userId, "s2"), false);
    assert.equal(service.snapshot(room).participants[1].connected, true);
    assert.equal(service.detach(room, guest.userId, "s3"), true);
  });

  it("removes a kicked participant from the authoritative snapshot", () => {
    const service = new RoomService();
    const host = service.create("Jamie", "s1");
    const guest = service.join(host.snapshot.roomId, "Alex", "s2");
    const room = service.room(host.snapshot.roomId)!;
    service.remove(room, guest.userId);

    assert.deepEqual(
      service.snapshot(room).participants.map((participant) => participant.userId),
      [host.userId],
    );
  });

  it("accepts valid room actions and rejects malformed payloads and video IDs", () => {
    assert.equal(
      joinRoomSchema.safeParse({ roomId: "AB12CD", username: "Jamie" }).success,
      true,
    );
    assert.equal(
      joinRoomSchema.safeParse({ roomId: "", username: "J" }).success,
      false,
    );
    assert.equal(videoIdSchema.safeParse("M7lc1UVf-VE").success, true);
    assert.equal(
      videoIdSchema.safeParse("https://youtu.be/nope").success,
      false,
    );
    assert.equal(seekTimeSchema.safeParse(-1).success, false);
    assert.equal(
      requestedActionSchema.safeParse({
        type: "change_video",
        videoId: "short",
      }).success,
      false,
    );
  });

  it("extracts IDs from all supported YouTube URL formats", () => {
    const videoId = "M7lc1UVf-VE";
    const urls = [
      `https://www.youtube.com/watch?v=${videoId}`,
      `https://www.youtube.com/watch?v=${videoId}&t=435s`,
      `https://www.youtube.com/watch?feature=share&v=${videoId}&si=tracking`,
      `https://youtu.be/${videoId}`,
      `https://youtu.be/${videoId}?si=tracking&t=435s`,
      `https://www.youtube.com/embed/${videoId}`,
      `https://www.youtube.com/shorts/${videoId}`,
      `https://www.youtube.com/live/${videoId}`,
    ];

    for (const url of urls)
      assert.equal(extractYouTubeVideoId(url), videoId, url);
  });

  it("rejects malformed URLs, unsupported hosts, missing IDs, and invalid IDs", () => {
    const invalidInputs = [
      "not a URL",
      "https://www.youtube.com/watch",
      "https://www.youtube.com/watch?feature=share",
      "https://www.youtube.com/embed/",
      "https://youtu.be/",
      "https://youtube.com.evil.test/watch?v=M7lc1UVf-VE",
      "https://notyoutube.com/watch?v=M7lc1UVf-VE",
      "https://example.com/watch?v=M7lc1UVf-VE",
      "ftp://www.youtube.com/watch?v=M7lc1UVf-VE",
      "https://www.youtube.com@evil.test/watch?v=M7lc1UVf-VE",
      "https://www.youtube.com/watch?v=short",
      "https://www.youtube.com/watch?v=M7lc1UVf-VE!",
      "https://youtu.be/M7lc1UVf-VE/extra",
      "https://www.youtube.com/playlist?list=M7lc1UVf-VE",
    ];

    for (const input of invalidInputs)
      assert.equal(extractYouTubeVideoId(input), null, input);
    assert.equal(isYouTubeVideoId("M7lc1UVf-VE"), true);
    assert.equal(isYouTubeVideoId("M7lc1UVf-VE!"), false);
    assert.equal(
      videoIdSchema.safeParse("https://youtu.be/M7lc1UVf-VE").success,
      false,
    );
  });
});
