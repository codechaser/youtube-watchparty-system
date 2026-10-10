import type { Role } from "@watch-party/shared";
export const canPlay = (role: Role) => role === "host" || role === "moderator";
export const canPause = canPlay;
export const canSeek = canPlay;
export const canChangeVideo = canPlay;
export const canAssignRole = (role: Role) => role === "host";
export const canRemoveParticipant = (role: Role) => role === "host";
