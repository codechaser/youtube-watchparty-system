import { z } from "zod";
import { isYouTubeVideoId } from "@watch-party/shared";

export const usernameSchema = z
  .string()
  .trim()
  .min(2)
  .max(24)
  .regex(/^[\p{L}\p{N}_ -]+$/u);
export const videoIdSchema = z.string().refine(isYouTubeVideoId, {
  message:
    "A video ID must contain 11 letters, numbers, underscores, or hyphens.",
});
export const seekTimeSchema = z.number().finite().min(0).max(86400);
export const joinRoomSchema = z.object({
  roomId: z.string().min(1).max(80),
  username: usernameSchema,
  sessionToken: z.string().length(64).optional(),
});
export const requestedActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("play") }),
  z.object({ type: z.literal("pause") }),
  z.object({ type: z.literal("seek"), time: seekTimeSchema }),
  z.object({ type: z.literal("change_video"), videoId: videoIdSchema }),
]);
