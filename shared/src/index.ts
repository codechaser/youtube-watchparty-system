export { extractYouTubeVideoId, isYouTubeVideoId } from "./youtube.js";

export type Role = "host" | "moderator" | "participant";
export type PlaybackState = "playing" | "paused";
export interface Participant {
  userId: string;
  username: string;
  role: Role;
  joinedAt: number;
  connected: boolean;
}
export interface RoomSnapshot {
  roomId: string;
  roomCode: string;
  hostUserId: string;
  videoId: string;
  playbackState: PlaybackState;
  currentTime: number;
  updatedAt: number;
  participants: Participant[];
}
export interface RoomEntry {
  snapshot: RoomSnapshot;
  userId: string;
  sessionToken: string;
}
export type RequestedAction =
  | { type: "play" }
  | { type: "pause" }
  | { type: "seek"; time: number }
  | { type: "change_video"; videoId: string };
export interface ActionRequest {
  requestId: string;
  userId: string;
  username: string;
  action: RequestedAction;
  createdAt: number;
}
export interface ClientToServerEvents {
  create_room: (payload: { username: string }, ack: Ack<RoomEntry>) => void;
  join_room: (
    payload: { roomId: string; username: string; sessionToken?: string },
    ack: Ack<RoomEntry>,
  ) => void;
  leave_room: (payload: { roomId: string }) => void;
  play: (ack?: Ack<RoomSnapshot>) => void;
  pause: (ack?: Ack<RoomSnapshot>) => void;
  seek: (payload: { time: number }, ack?: Ack<RoomSnapshot>) => void;
  playback_progress: (payload: { time: number }, ack?: Ack<void>) => void;
  change_video: (payload: { videoId: string }, ack?: Ack<RoomSnapshot>) => void;
  assign_role: (
    payload: { userId: string; role: Role },
    ack?: Ack<RoomSnapshot>,
  ) => void;
  remove_participant: (payload: { userId: string }, ack?: Ack<void>) => void;
  request_action: (payload: RequestedAction, ack?: Ack<ActionRequest>) => void;
  resolve_request: (
    payload: { requestId: string; approved: boolean },
    ack?: Ack<void>,
  ) => void;
}
export interface ServerToClientEvents {
  sync_state: (state: RoomSnapshot) => void;
  user_joined: (payload: {
    participant: Participant;
    participants: Participant[];
  }) => void;
  user_left: (payload: {
    userId: string;
    username: string;
    participants: Participant[];
  }) => void;
  role_assigned: (payload: {
    userId: string;
    username: string;
    role: Role;
    participants: Participant[];
  }) => void;
  participant_removed: (payload: {
    userId: string;
    participants: Participant[];
  }) => void;
  participant_presence: (payload: {
    userId: string;
    connected: boolean;
    participants: Participant[];
  }) => void;
  request_created: (request: ActionRequest) => void;
  request_resolved: (payload: {
    requestId: string;
    approved: boolean;
    by: string;
  }) => void;
  room_error: (payload: { code: string; message: string }) => void;
  connection_status: (payload: {
    connected: boolean;
    message?: string;
  }) => void;
}
export type Ack<T> = (
  result:
    | { ok: true; data: T }
    | { ok: false; error: { code: string; message: string } },
) => void;
