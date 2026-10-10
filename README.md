# Frame — YouTube Watch Party

Frame is a room-based watch party for synchronizing YouTube playback with friends. A room host or moderator controls playback; participants can watch along and send requests for approval.

> **Deployment:** No public deployment has been created. Configure the Render service below and add the resulting frontend/backend URL here when deployment is complete.

## Features

- Create rooms with unique six-character invite codes and shareable links.
- Join by room code or link; see live participants and role badges.
- Synchronize play, pause, seek, and YouTube video changes through Socket.IO.
- Enforce host, moderator, and participant permissions on the server.
- Let participants request playback, seek, and video changes; hosts and moderators approve or reject them.
- Use the YouTube IFrame Player API, with URL/ID parsing for watch, short, embed, and Shorts URLs.
- SQLite history metadata, health endpoint, responsive layout, and actionable room errors.

## Architecture

```text
client (React + Vite) ── Socket.IO/WebSocket ── server (Express + Socket.IO)
                                                   ├── RoomService (authoritative live state)
                                                   └── SQLite (room history metadata)
shared (typed event and state contracts) ─────────────┘
```

The live room map is authoritative for users, roles, video, playback state, time, and pending requests. SQLite records room identifiers and creation history only; playback and socket presence are intentionally ephemeral. `RoomService` isolates room operations from Socket.IO transport and keeps a future database or pub/sub change localized. Participants are counted once per identity; their connected state reflects whether any of that identity's sockets remain active. A disconnected member is retained for the reconnect window and shown as reconnecting until they return or expire.

### Synchronization flow

The client emits an action. The server derives the user and role from the socket's server-side membership, validates the payload and permission, updates room state, then broadcasts `sync_state`. While playing, the authorized player sends small progress updates so pause and reconnect snapshots retain the current position. A joining participant receives the current snapshot. The IFrame adapter applies remote updates with a guard and corrects drift above two seconds to reduce feedback loops.

### RBAC

`server/src/permissions.ts` is the permission source. Hosts can control playback, change video, assign roles, and remove participants. Moderators can control playback and change video. Participants cannot mutate playback directly; they can submit actions to the server request queue. Every mutation handler checks server-owned membership/role before mutating or broadcasting. Client-side control visibility is only a convenience.

## Stack and layout

- **Client:** React 19, TypeScript strict mode, Vite, Socket.IO client, Lucide icons, custom CSS.
- **Server:** Node.js, Express, TypeScript, Socket.IO, Zod, SQLite (`better-sqlite3`).
- **Shared:** TypeScript Socket.IO event contracts and room/request types.

```text
client/src/App.tsx                 UI, room flow, and YouTube IFrame adapter
client/src/style.css               responsive Frame interface
server/src/index.ts                HTTP health check and validated socket handlers
server/src/main.ts                 production and development server entry point
server/src/rooms.ts                authoritative in-memory room service
server/src/permissions.ts          centralized role policy
server/src/database.ts             SQLite history metadata
server/src/validation.ts           shared Zod payload schemas
server/src/rooms.test.ts           room and role logic tests
server/src/socket.integration.test.ts real Socket.IO authorization and broadcast tests
shared/src/index.ts                event contracts and domain types
```

## Local setup

Requires Node.js 20+ and npm 10+.

```bash
npm install
Copy-Item .env.example .env
npm run dev
```

Vite runs at `http://localhost:5173` (or the next available port); the API and Socket.IO server runs at `http://localhost:3001`. The server creates the SQLite data directory automatically. `GET /health` returns `{ "status": "ok" }`.

### Environment variables

| Variable          | Purpose                                  | Local default               |
| ----------------- | ---------------------------------------- | --------------------------- |
| `PORT`            | Express/Socket.IO port                   | `3001`                      |
| `CLIENT_ORIGIN`   | Allowed browser origin                   | `http://localhost:5173`     |
| `VITE_SERVER_URL` | Client Socket.IO server URL (build-time) | `http://localhost:3001`     |
| `DATABASE_PATH`   | SQLite file location                     | `./data/watch-party.sqlite` |

## WebSocket events

The canonical typed event definitions live in `shared/src/index.ts`. All client mutation events use Socket.IO acknowledgements (`{ ok, data }` or `{ ok: false, error }`); server errors also emit `room_error` to the requester.

| Direction       | Event                                                              | Purpose                                        |
| --------------- | ------------------------------------------------------------------ | ---------------------------------------------- |
| Client → server | `create_room`, `join_room`, `leave_room`                           | Room membership                                |
| Client → server | `play`, `pause`, `seek`, `playback_progress`, `change_video`       | Authorized playback mutations and time updates |
| Client → server | `assign_role`, `remove_participant`                                | Host management                                |
| Client → server | `request_action`, `resolve_request`                                | Approval workflow                              |
| Server → client | `sync_state`                                                       | Full authoritative room snapshot               |
| Server → client | `user_joined`, `user_left`, `role_assigned`, `participant_removed`, `participant_presence` | Membership, presence, and role changes                    |
| Server → client | `request_created`, `request_resolved`                              | Request queue updates                          |
| Server → client | `room_error`, `connection_status`                                  | Errors and connection status                   |

## Testing and checks

```bash
npm test       # room/RBAC unit tests and Socket.IO cross-client integration tests
npm run typecheck
npm run build  # production client and server builds
```

For a manual synchronization check, open the app in two or three browser windows. Create a room in one, join from the others, promote a participant to moderator, and verify play/pause/seek/video updates and participant requests across windows. Also try sending a restricted event from a participant socket: the server responds with `FORBIDDEN` without broadcasting a mutation.

## Deployment (Render)

`render.yaml` describes a persistent-disk Node web service and a static client site with a `/health` health check. Deploy the blueprint in Render, then set `CLIENT_ORIGIN` on the server to the deployed client origin and `VITE_SERVER_URL` on the static site to the deployed server URL (including `https://`). The static site must be rebuilt after setting its build-time `VITE_SERVER_URL`. Verify `/health`, room creation/joining, and cross-client synchronization before documenting a public URL. No public deployment URL is currently verified.

## Trade-offs and limitations

- Live room state is in memory and disappears on server restart. SQLite is currently used for room history metadata, not room restoration.
- The current single-process room map is appropriate for an assignment MVP. Multi-instance deployments need a shared room store and Socket.IO Redis adapter/pub-sub.
- Participants receive a random server-issued room session token stored in browser local storage; it preserves role and identity across a reconnect and expires after 90 seconds offline. These tokens are bearer credentials, not full account authentication. Do not expose private rooms without adding authenticated accounts and stronger session controls.
- Browser autoplay policies may require a user gesture before audio playback starts. YouTube may restrict embedding for individual videos.
- A host who leaves or remains disconnected beyond the reconnect window transfers host to the next participant. Rooms and playback state are still ephemeral across server restarts.
