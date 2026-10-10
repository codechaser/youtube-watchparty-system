import { useCallback, useEffect, useRef, useState } from "react";
import { io, Socket } from "socket.io-client";
import {
  ArrowLeft,
  Check,
  ChevronDown,
  CircleHelp,
  Copy,
  Crown,
  Film,
  Link,
  LoaderCircle,
  LogOut,
  MessageSquareText,
  Play,
  Plus,
  Radio,
  Shield,
  ShieldCheck,
  Sparkles,
  Users,
  X,
  Youtube,
} from "lucide-react";
import type {
  ActionRequest,
  ClientToServerEvents,
  Role,
  RoomSnapshot,
  ServerToClientEvents,
} from "@watch-party/shared";
import { extractYouTubeVideoId } from "@watch-party/shared";

const URL =
  import.meta.env.VITE_SERVER_URL ||
  (import.meta.env.DEV ? "http://localhost:3001" : window.location.origin);
type PartySocket = Socket<ServerToClientEvents, ClientToServerEvents>;
declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}
function useYoutube(
  state: RoomSnapshot | null,
  socket: PartySocket | null,
  onError: (message: string) => void,
) {
  const player = useRef<any>(null),
    target = useRef<HTMLDivElement>(null),
    guard = useRef(false),
    ready = useRef(false),
    requestedVideoId = useRef<string | null>(null),
    latest = useRef(state),
    latestSocket = useRef(socket),
    latestOnError = useRef(onError);
  const [videoLoading, setVideoLoading] = useState(false);
  latest.current = state;
  latestSocket.current = socket;
  latestOnError.current = onError;
  const getCurrentTime = useCallback(
    () => player.current?.getCurrentTime?.() ?? 0,
    [],
  );
  const applySnapshot = (snapshot: RoomSnapshot | null) => {
    const p = player.current;
    if (!snapshot) {
      setVideoLoading(false);
      return;
    }
    if (!p || !ready.current) {
      setVideoLoading(true);
      return;
    }

    const currentId = p.getVideoData?.()?.video_id;
    if (currentId !== snapshot.videoId) {
      if (requestedVideoId.current === snapshot.videoId) return;
      requestedVideoId.current = snapshot.videoId;
      setVideoLoading(true);
      const options = {
        videoId: snapshot.videoId,
        startSeconds: Math.max(0, snapshot.currentTime),
      };
      if (snapshot.playbackState === "playing") p.loadVideoById(options);
      else p.cueVideoById(options);
      return;
    }

    if (requestedVideoId.current) return;
    guard.current = true;
    const drift = Math.abs((p.getCurrentTime?.() ?? 0) - snapshot.currentTime);
    if (drift > 2) p.seekTo(snapshot.currentTime, true);
    if (snapshot.playbackState === "playing") p.playVideo();
    else p.pauseVideo();
    window.setTimeout(() => (guard.current = false), 800);
  };
  useEffect(() => {
    let cancelled = false;
    if (!state) return;
    const init = () => {
      if (
        cancelled ||
        !target.current ||
        !window.YT?.Player ||
        player.current
      )
        return;
      player.current = new window.YT.Player(target.current, {
        videoId: latest.current?.videoId,
        playerVars: {
          playsinline: 1,
          rel: 0,
          modestbranding: 1,
          controls: 0,
          disablekb: 1,
        },
        events: {
          onReady: () => {
            ready.current = true;
            applySnapshot(latest.current);
            if (!requestedVideoId.current) setVideoLoading(false);
          },
          onStateChange: (e: any) => {
            const p = player.current;
            const requestedId = requestedVideoId.current;
            if (
              requestedId &&
              (e.data === 1 || e.data === 5) &&
              p?.getVideoData?.()?.video_id === requestedId
            ) {
              requestedVideoId.current = null;
              setVideoLoading(false);
              applySnapshot(latest.current);
              return;
            }
            if (requestedId || guard.current) return;
            if (e.data === 1) latestSocket.current?.emit("play");
            if (e.data === 2) latestSocket.current?.emit("pause");
          },
          onError: (e: any) => {
            requestedVideoId.current = null;
            setVideoLoading(false);
            const messages: Record<number, string> = {
              2: "YouTube rejected this video ID.",
              5: "This video cannot be played in the embedded player.",
              100: "This YouTube video is unavailable or private.",
              101: "The owner does not allow this video to be embedded.",
              150: "The owner does not allow this video to be embedded.",
              153: "YouTube could not verify the player origin.",
            };
            latestOnError.current(
              messages[e.data] ??
                "The YouTube player could not load this video.",
            );
          },
        },
      });
    };
    const previous = window.onYouTubeIframeAPIReady;
    const onReady = () => {
      previous?.();
      init();
    };
    if (window.YT?.Player) init();
    else {
      const old = document.querySelector("script[data-youtube-api]");
      if (!old) {
        const script = document.createElement("script");
        script.src = "https://www.youtube.com/iframe_api";
        script.dataset.youtubeApi = "true";
        script.onerror = () => {
          if (!cancelled) {
            setVideoLoading(false);
            latestOnError.current(
              "The YouTube player could not be loaded. Check your connection and try again.",
            );
          }
        };
        document.body.appendChild(script);
      }
      window.onYouTubeIframeAPIReady = onReady;
    }
    return () => {
      cancelled = true;
      ready.current = false;
      requestedVideoId.current = null;
      if (window.onYouTubeIframeAPIReady === onReady)
        window.onYouTubeIframeAPIReady = previous;
      player.current?.destroy?.();
      player.current = null;
      setVideoLoading(false);
    };
  }, [Boolean(state)]);
  useEffect(() => {
    applySnapshot(state);
  }, [state?.videoId, state?.playbackState, state?.currentTime]);
  return {
    target,
    getCurrentTime,
    videoLoading,
  };
}
function App() {
  const [socket, setSocket] = useState<PartySocket | null>(null),
    [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null),
    [username, setUsername] = useState(""),
    [roomInput, setRoomInput] = useState(""),
    [view, setView] = useState<"home" | "create" | "join" | "room">("home"),
    [connected, setConnected] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState(""),
    [videoInput, setVideoInput] = useState(""),
    [seekInput, setSeekInput] = useState(0),
    [requests, setRequests] = useState<ActionRequest[]>([]),
    [requestType, setRequestType] = useState<
      "play" | "pause" | "seek" | "change_video"
    >("play");
  const player = useYoutube(snapshot, socket, (message) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 3200);
  });
  const target = player.target;
  const videoLoading = player.videoLoading;
  const me = snapshot?.participants.find(
    (p) => p.userId === localStorage.getItem("wp-user"),
  );
  const elevated = me?.role === "host" || me?.role === "moderator";
  const connectedParticipants =
    snapshot?.participants.filter((participant) => participant.connected).length ??
    0;
  useEffect(() => {
    if (
      !snapshot ||
      snapshot.playbackState !== "playing" ||
      !elevated ||
      !socket
    )
      return;
    const timer = window.setInterval(() => {
      socket.emit("playback_progress", { time: player.getCurrentTime() });
    }, 2500);
    return () => window.clearInterval(timer);
  }, [snapshot?.playbackState, elevated, socket, player.getCurrentTime]);
  useEffect(() => {
    const match = window.location.pathname.match(/\/room\/([^/]+)/);
    if (match) {
      setRoomInput(decodeURIComponent(match[1]).toUpperCase());
      setView("join");
    }
  }, []);
  useEffect(() => {
    const s = io(URL, { transports: ["websocket"], autoConnect: true });
    setSocket(s);
    s.on("connect", () => {
      setConnected(true);
      const roomId = localStorage.getItem("wp-room"),
        sessionToken = localStorage.getItem("wp-token"),
        savedName = localStorage.getItem("wp-name"),
        savedCode = localStorage.getItem("wp-code"),
        inviteCode = window.location.pathname.match(/\/room\/([^/]+)/)?.[1];
      const inviteMatches =
        !inviteCode || inviteCode.toUpperCase() === savedCode;
      if (roomId && sessionToken && savedName && inviteMatches)
        s.emit(
          "join_room",
          { roomId, username: savedName, sessionToken },
          (r: any) => {
            if (r.ok) {
              setSnapshot(r.data.snapshot);
              setUsername(savedName);
              localStorage.setItem("wp-user", r.data.userId);
              setView("room");
              history.replaceState({}, "", `/room/${r.data.snapshot.roomCode}`);
            } else {
              localStorage.removeItem("wp-room");
              localStorage.removeItem("wp-code");
              localStorage.removeItem("wp-token");
              localStorage.removeItem("wp-user");
              localStorage.removeItem("wp-name");
              setSnapshot(null);
              setView("home");
            }
          },
        );
    });
    s.on("disconnect", () => setConnected(false));
    s.on("sync_state", setSnapshot);
    s.on("user_joined", (e) =>
      setSnapshot((old) =>
        old ? { ...old, participants: e.participants } : old,
      ),
    );
    s.on("user_left", (e) =>
      setSnapshot((old) =>
        old ? { ...old, participants: e.participants } : old,
      ),
    );
    s.on("participant_presence", (e) =>
      setSnapshot((old) =>
        old ? { ...old, participants: e.participants } : old,
      ),
    );
    s.on("role_assigned", (e) =>
      setSnapshot((old) =>
        old
          ? {
              ...old,
              participants: e.participants,
              hostUserId: e.role === "host" ? e.userId : old.hostUserId,
            }
          : old,
      ),
    );
    s.on("request_created", (r) => setRequests((old) => [...old, r]));
    s.on("request_resolved", (r) => {
      setRequests((old) => old.filter((x) => x.requestId !== r.requestId));
      toast(r.approved ? "Request approved" : "Request declined");
    });
    s.on("participant_removed", () => {
      localStorage.removeItem("wp-room");
      localStorage.removeItem("wp-code");
      localStorage.removeItem("wp-token");
      localStorage.removeItem("wp-user");
      localStorage.removeItem("wp-name");
      setSnapshot(null);
      setView("home");
      toast("You were removed from the room.");
    });
    s.on("room_error", (e) => toast(e.message));
    return () => {
      s.disconnect();
    };
  }, []);
  function toast(text: string) {
    setNotice(text);
    window.setTimeout(() => setNotice(""), 3200);
  }
  function enter(action: "create" | "join" | "room") {
    if (!socket) return;
    setBusy(true);
    const callback = (result: any) => {
      setBusy(false);
      if (!result.ok) {
        toast(result.error.message);
        return;
      }
      setSnapshot(result.data.snapshot);
      localStorage.setItem("wp-room", result.data.snapshot.roomId);
      localStorage.setItem("wp-code", result.data.snapshot.roomCode);
      localStorage.setItem("wp-user", result.data.userId);
      localStorage.setItem("wp-token", result.data.sessionToken);
      localStorage.setItem("wp-name", username.trim());
      setView("room");
      history.replaceState({}, "", `/room/${result.data.snapshot.roomCode}`);
    };
    if (action === "create") socket.emit("create_room", { username }, callback);
    else
      socket.emit(
        "join_room",
        {
          roomId: roomInput.trim(),
          username,
          sessionToken:
            roomInput.trim().toUpperCase() ===
              localStorage.getItem("wp-code") ||
            roomInput.trim() === localStorage.getItem("wp-room")
              ? (localStorage.getItem("wp-token") ?? undefined)
              : undefined,
        },
        callback,
      );
  }
  function send(event: "play" | "pause") {
    socket?.emit(event, (r: any) => {
      if (!r.ok) toast(r.error.message);
    });
  }
  function submitVideo() {
    const videoId = extractYouTubeVideoId(videoInput);
    if (!videoId) {
      toast(
        "Enter a valid YouTube video ID or a youtube.com/youtu.be link containing an 11-character video ID.",
      );
      return;
    }
    if (elevated)
      socket?.emit("change_video", { videoId }, (r: any) => {
        if (!r.ok) toast(r.error.message);
        else setVideoInput("");
      });
    else
      socket?.emit(
        "request_action",
        { type: "change_video", videoId },
        (r: any) => {
          if (!r.ok) toast(r.error.message);
          else toast("Video change request sent.");
        },
      );
  }
  function submitRequest() {
    const requestedVideoId =
      requestType === "change_video"
        ? extractYouTubeVideoId(videoInput)
        : undefined;
    if (requestType === "change_video" && !requestedVideoId) {
      toast(
        "Enter a valid YouTube video ID or a youtube.com/youtu.be link containing an 11-character video ID.",
      );
      return;
    }
    const action =
      requestType === "seek"
        ? { type: "seek" as const, time: Number(seekInput) }
        : requestType === "change_video"
          ? {
              type: "change_video" as const,
              videoId: requestedVideoId!,
            }
          : { type: requestType };
    socket?.emit("request_action", action as any, (r: any) => {
      if (!r.ok) toast(r.error.message);
      else toast("Request sent to the room.");
    });
  }
  function resolve(req: ActionRequest, approved: boolean) {
    socket?.emit(
      "resolve_request",
      { requestId: req.requestId, approved },
      (r: any) => {
        if (!r.ok) toast(r.error.message);
      },
    );
  }
  async function copyInvite() {
    await navigator.clipboard.writeText(
      `${window.location.origin}/room/${snapshot?.roomCode}`,
    );
    toast("Invite link copied.");
  }
  function startJoin() {
    const match = window.location.pathname.match(/\/room\/([^/]+)/);
    if (match) setRoomInput(decodeURIComponent(match[1]));
    setView("join");
  }
  function leave() {
    if (snapshot) socket?.emit("leave_room", { roomId: snapshot.roomId });
    for (const key of ["wp-room", "wp-code", "wp-user", "wp-token", "wp-name"])
      localStorage.removeItem(key);
    setSnapshot(null);
    setRequests([]);
    setView("home");
    history.replaceState({}, "", "/");
  }
  function roleIcon(role: Role) {
    return role === "host" ? (
      <Crown size={12} />
    ) : role === "moderator" ? (
      <Shield size={12} />
    ) : null;
  }
  const playerTarget = (
    <div className="player-shell">
      <div className="player-frame">
        <div ref={target} className="youtube-player" />
      </div>
      <div className="player-bottom">
        <div className="playing-indicator">
          <span
            className={
              snapshot?.playbackState === "playing"
                ? "live-dot"
                : "live-dot idle"
            }
          />
          {snapshot?.playbackState === "playing"
            ? "PLAYING TOGETHER"
            : "ROOM PAUSED"}
        </div>
        <div className="youtube-caption">
          <Youtube size={15} /> YouTube player
        </div>
      </div>
    </div>
  );
  if (view === "room" && snapshot)
    return (
      <main className="app-shell room-shell">
        <header className="topbar">
          <div className="brand small" onClick={leave}>
            <div className="brand-mark">
              <Film size={17} />
            </div>
            <span>
              frame..<span className="brand-period">.</span>
            </span>
          </div>
          <div className="room-title">
            <span className="room-live">
              <span /> LIVE ROOM
            </span>
            <b>{snapshot.roomCode}</b>
          </div>
          <div className="top-actions">
            <span className={`connection ${connected ? "" : "offline"}`}>
              <span />
              {connected ? "Connected" : "Reconnecting"}
            </span>
            <button className="icon-button" onClick={leave} title="Leave room">
              <LogOut size={16} />
            </button>
            <div className="avatar-small">
              {me?.username.charAt(0).toUpperCase()}
            </div>
          </div>
        </header>
        <div className="room-content">
          <div className="room-heading">
            <div>
              <div className="eyebrow">YOUR WATCH ROOM</div>
              <h1>
                Good videos are <em>better together.</em>
              </h1>
              <p>
                Everything here stays in sync, wherever your friends are
                watching.
              </p>
            </div>
            <button className="invite-button" onClick={copyInvite}>
              <Link size={15} /> Invite friends <Copy size={13} />
            </button>
          </div>
          <div className="room-grid">
            <section className="watch-column">
              {playerTarget}
              <div className="controls-card">
                <div className="controls-title">
                  <div>
                    <span className="eyebrow">NOW PLAYING</span>
                    <h3>Room playback</h3>
                  </div>
                  {elevated ? (
                    <span className="control-badge">
                      <ShieldCheck size={13} /> {me?.role}
                    </span>
                  ) : (
                    <span className="control-badge participant">
                      <CircleHelp size={13} /> request controls
                    </span>
                  )}
                </div>
                {elevated ? (
                  <div className="playback-row">
                    <button
                      className={`play-control ${snapshot.playbackState === "playing" ? "active" : ""}`}
                      onClick={() => send("play")}
                    >
                      <Play size={15} fill="currentColor" /> Play together
                    </button>
                    <button
                      className={`pause-control ${snapshot.playbackState === "paused" ? "active" : ""}`}
                      onClick={() => send("pause")}
                    >
                      Pause
                    </button>
                    <label className="seek-control">
                      <span>SEEK TO</span>
                      <input
                        type="number"
                        min="0"
                        value={seekInput}
                        onChange={(e) => setSeekInput(Number(e.target.value))}
                      />
                      <small>sec</small>
                      <button
                        onClick={() =>
                          socket?.emit(
                            "seek",
                            { time: Number(seekInput) },
                            (r: any) => !r.ok && toast(r.error.message),
                          )
                        }
                      >
                        Go
                      </button>
                    </label>
                  </div>
                ) : (
                  <div className="request-row">
                    <select
                      value={requestType}
                      onChange={(e) => setRequestType(e.target.value as any)}
                    >
                      <option value="play">Request play</option>
                      <option value="pause">Request pause</option>
                      <option value="seek">Request seek</option>
                      <option value="change_video">Request video change</option>
                    </select>
                    {requestType === "seek" && (
                      <input
                        type="number"
                        min="0"
                        value={seekInput}
                        onChange={(e) => setSeekInput(Number(e.target.value))}
                        placeholder="Seconds"
                      />
                    )}
                    <button className="request-button" onClick={submitRequest}>
                      Send request <ArrowLeft size={14} />
                    </button>
                  </div>
                )}
                <div className="video-change">
                  <div className="video-icon">
                    <Youtube size={17} />
                  </div>
                  <div className="video-entry">
                    <b>Change the video</b>
                    <span aria-live="polite">
                      {videoLoading
                        ? "Loading video…"
                        : "Paste a YouTube link or video ID"}
                    </span>
                  </div>
                  <input
                    value={videoInput}
                    onChange={(e) => setVideoInput(e.target.value)}
                    placeholder="youtube.com/watch?v=..."
                  />
                  <button onClick={submitVideo}>
                    {elevated ? "Load video" : "Request"}{" "}
                    <ArrowLeft size={14} />
                  </button>
                </div>
              </div>
            </section>
            <aside className="sidebar">
              <div className="people-card">
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">THE ROOM</span>
                    <h3>
                      Watching with you{" "}
                      <span className="count-pill">
                        {snapshot.participants.length}
                      </span>
                    </h3>
                  </div>
                  <Users size={17} />
                </div>
                <div className="participant-list">
                  {snapshot.participants.map((p) => (
                    <div className="person" key={p.userId}>
                      <div className={`person-avatar avatar-${p.role}`}>
                        {p.username.slice(0, 1).toUpperCase()}
                      </div>
                      <div className="person-info">
                        <b>
                          {p.username}
                          {p.userId === me?.userId ? " (you)" : ""}
                        </b>
                        <span>
                          {p.role === "host"
                            ? "Room host"
                            : p.role === "moderator"
                              ? "Moderator"
                              : "Participant"}
                        </span>
                        <span
                          className={`presence-status ${p.connected ? "online" : "reconnecting"}`}
                        >
                          <i />
                          {p.connected ? "Connected" : "Reconnecting"}
                        </span>
                      </div>
                      <span className={`role-badge ${p.role}`}>
                        {roleIcon(p.role)}
                        {p.role}
                      </span>
                      {me?.role === "host" && p.userId !== me.userId && (
                        <div className="person-actions">
                          <button
                            title="Change role"
                            onClick={() =>
                              socket?.emit(
                                "assign_role",
                                {
                                  userId: p.userId,
                                  role:
                                    p.role === "moderator"
                                      ? "participant"
                                      : "moderator",
                                },
                                (r: any) => !r.ok && toast(r.error.message),
                              )
                            }
                          >
                            <ChevronDown size={14} />
                          </button>
                          <button
                            title="Remove participant"
                            onClick={() => {
                              if (
                                confirm(`Remove ${p.username} from this room?`)
                              )
                                socket?.emit(
                                  "remove_participant",
                                  { userId: p.userId },
                                  (r: any) => !r.ok && toast(r.error.message),
                                );
                            }}
                          >
                            <X size={14} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
                <div className="people-footer">
                  <span className="green-dot" /> {connectedParticipants} connected
                  {connectedParticipants !== snapshot.participants.length &&
                    ` · ${snapshot.participants.length - connectedParticipants} reconnecting`}
                </div>
              </div>
              <div className="requests-card">
                <div className="card-heading">
                  <div>
                    <span className="eyebrow">ROOM ACTIVITY</span>
                    <h3>
                      Requests{" "}
                      <span className="count-pill">{requests.length}</span>
                    </h3>
                  </div>
                  <MessageSquareText size={17} />
                </div>
                {requests.length === 0 ? (
                  <div className="empty-requests">
                    <div className="empty-icon">
                      <Sparkles size={17} />
                    </div>
                    <div>
                      <b>All caught up</b>
                      <p>Requests from your friends will show up here.</p>
                    </div>
                  </div>
                ) : (
                  requests.map((req) => (
                    <div className="request-item" key={req.requestId}>
                      <span>
                        <b>{req.username}</b> requested{" "}
                        {req.action.type === "change_video"
                          ? "a video change"
                          : req.action.type === "seek"
                            ? `a seek to ${req.action.time}s`
                            : req.action.type}
                      </span>
                      {elevated && (
                        <div>
                          <button
                            className="approve"
                            onClick={() => resolve(req, true)}
                          >
                            <Check size={13} />
                          </button>
                          <button
                            className="reject"
                            onClick={() => resolve(req, false)}
                          >
                            <X size={13} />
                          </button>
                        </div>
                      )}
                    </div>
                  ))
                )}
              </div>
              <div className="tip-card">
                <div className="tip-icon">
                  <CircleHelp size={17} />
                </div>
                <div>
                  <b>Made for the moment</b>
                  <p>
                    Send this room to your favorite people and press play
                    together.
                  </p>
                </div>
              </div>
            </aside>
          </div>
          <footer className="room-footer">
            <span>
              YouTube Watch Party <i>·</i> WATCHING IS BETTER TOGETHER
            </span>
            <span>ROOM {snapshot.roomCode}</span>
          </footer>
        </div>
        {notice && (
          <div className="toast">
            <Check size={15} />
            {notice}
          </div>
        )}
      </main>
    );
  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark">
            <Film size={17} />
          </div>
          <span>
            YouTube Watch Party <span className="brand-period">.</span>
          </span>
        </div>
        <div className="top-tag">
          <span className="tiny-spark">✳</span> Watch together, wherever
        </div>
        <button className="join-top" onClick={startJoin}>
          Join a room <ArrowLeft size={14} />
        </button>
      </header>
      <section className="hero">
        <div className="hero-copy">
          <div className="eyebrow">
            <span className="green-dot" /> YOUR PEOPLE. YOUR VIDEO. ONE ROOM.
          </div>
          <h1>
            Make movie night
            <br />
            feel <em>like movie night.</em>
          </h1>
          <p>
            Press play from anywhere. Laugh at the same moment.
            <br className="desktop-break" /> Frame keeps your YouTube in sync
            with your favorite people.
          </p>
          <div className="hero-buttons">
            <button
              className="primary-button"
              onClick={() => setView("create")}
            >
              <Plus size={17} /> Create a room <ArrowLeft size={15} />
            </button>
            <button className="text-button" onClick={startJoin}>
              I have an invite <ArrowLeft size={14} />
            </button>
          </div>
          <div className="social-proof">
            <div className="avatar-stack">
              <span>J</span>
              <span>M</span>
              <span>A</span>
              <span>+</span>
            </div>
            <div>
              <b>Better when you're together</b>
              <small>Free, simple, and made for your group chat.</small>
            </div>
          </div>
        </div>
        <div className="hero-art">
          <div className="art-glow" />
          <div className="art-window">
            <div className="art-top">
              <span className="window-dots">
                <i />
                <i />
                <i />
              </span>
              <span>FRIDAY NIGHT · ROOM 4B7K2A</span>
              <span className="art-live">
                <i />
                LIVE
              </span>
            </div>
            <div className="art-screen">
              <div className="art-image">
                <div className="mountain back" />
                <div className="mountain front" />
                <div className="moon" />
                <div className="art-play">
                  <Play size={18} fill="currentColor" />
                </div>
                <div className="art-time">
                  <span>02:14</span>
                  <div>
                    <i />
                  </div>
                  <span>1:48:32</span>
                </div>
              </div>
            </div>
            <div className="art-people">
              <div className="art-person">
                <i>J</i>
                <span>
                  Jamie <b>HOST</b>
                </span>
                <span className="sound-wave">▂▄▆</span>
              </div>
              <div className="art-person">
                <i>M</i>
                <span>Morgan</span>
                <span className="sound-wave">▂▄▆</span>
              </div>
              <div className="art-person">
                <i>A</i>
                <span>Alex</span>
                <span className="sound-wave muted">▁▁▁</span>
              </div>
            </div>
          </div>
          <div className="floating-note">
            <div className="note-icon">
              <Check size={14} />
            </div>
            <div>
              <b>You're all in sync</b>
              <span>Same scene. Same second.</span>
            </div>
            <span className="note-spark">✳</span>
          </div>
          <div className="sync-stamp">
            <Radio size={13} /> LIVE SYNC
          </div>
        </div>
      </section>
      <section className="steps-section">
        <div className="steps-head">
          <div>
            <span className="eyebrow">THAT'S THE WHOLE THING</span>
            <h2>
              Good plans. <em>Zero setup.</em>
            </h2>
          </div>
          <span className="steps-aside">
            Three steps between
            <br />
            the group chat and the good part.
          </span>
        </div>
        <div className="steps-grid">
          <div className="step">
            <span className="step-number">01</span>
            <div className="step-icon purple">
              <Plus size={18} />
            </div>
            <h3>Start a room</h3>
            <p>
              Make a room in seconds. Your invite link is ready before you are.
            </p>
            <span className="step-arrow">↗</span>
          </div>
          <div className="step">
            <span className="step-number">02</span>
            <div className="step-icon yellow">
              <Link size={18} />
            </div>
            <h3>Send the invite</h3>
            <p>
              Drop the link in the group chat. Your people show up in the
              sidebar.
            </p>
            <span className="step-arrow">↗</span>
          </div>
          <div className="step">
            <span className="step-number">03</span>
            <div className="step-icon green">
              <Play size={18} />
            </div>
            <h3>Watch in sync</h3>
            <p>
              You press play, they press play. Pauses and rewinds come along
              too.
            </p>
            <span className="step-arrow">↗</span>
          </div>
        </div>
      </section>
      <footer className="home-footer">
        <div className="brand small">
          <div className="brand-mark">
            <Film size={14} />
          </div>
          <span>
            frame<span className="brand-period">.</span>
          </span>
        </div>
        <span>MADE FOR THE PEOPLE YOU'D SAVE A SEAT FOR.</span>
        <span>© FRAME 2026</span>
      </footer>
      {view !== "home" && (
        <div className="modal-backdrop" onClick={() => setView("home")}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <button className="modal-close" onClick={() => setView("home")}>
              <X size={17} />
            </button>
            <div className="modal-symbol">
              <Film size={21} />
            </div>
            <span className="eyebrow">
              {view === "create"
                ? "YOUR ROOM IS ONE CLICK AWAY"
                : "YOU’RE INVITED"}
            </span>
            <h2>
              {view === "create" ? "Start the watch party." : "Come on in."}
            </h2>
            <p>
              {view === "create"
                ? "Pick a name for the room. We’ll take care of the rest."
                : "Enter the room code and a name your friends know."}
            </p>
            <label className="field-label">
              YOUR NAME
              <input
                autoFocus
                maxLength={24}
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="e.g. Jamie"
                onKeyDown={(e) =>
                  e.key === "Enter" &&
                  username.trim().length >= 2 &&
                  enter(view)
                }
              />
            </label>
            {view === "join" && (
              <label className="field-label">
                ROOM CODE OR INVITE LINK
                <input
                  value={roomInput}
                  onChange={(e) =>
                    setRoomInput(
                      e.target.value.replace(/^.*\/room\//, "").toUpperCase(),
                    )
                  }
                  placeholder="e.g. 4B7K2A"
                  onKeyDown={(e) => e.key === "Enter" && enter(view)}
                />
              </label>
            )}
            <button
              className="primary-button modal-submit"
              disabled={
                busy ||
                username.trim().length < 2 ||
                (view === "join" && !roomInput.trim()) ||
                !connected
              }
              onClick={() => enter(view)}
            >
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : view === "create" ? (
                <>
                  <Plus size={16} /> Create room <ArrowLeft size={15} />
                </>
              ) : (
                <>
                  Join the room <ArrowLeft size={15} />
                </>
              )}
            </button>
            <div className="modal-foot">
              <ShieldCheck size={13} /> Room roles keep playback in good hands.
            </div>
          </div>
        </div>
      )}
      {notice && (
        <div className="toast">
          <Check size={15} />
          {notice}
        </div>
      )}
    </main>
  );
}
export default App;
