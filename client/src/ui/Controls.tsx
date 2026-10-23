import { useState } from "react";
import { useStore } from "../store.js";
import { logout } from "../net/api.js";
import type { Session } from "../net/session.js";

export function Controls({ session }: { session: Session | null }) {
  const { micOn, camOn, sharing, status, micState, camState, cameraError, me, players, sessionId } =
    useStore();
  const peerCount = useStore((s) => Object.keys(s.peers).length);
  const [shareError, setShareError] = useState("");
  const [busy, setBusy] = useState(false);

  const self = sessionId ? players[sessionId] : undefined;
  const locked = !!self?.lockGroup;
  const inCall = peerCount > 0;
  const micAvailable = micState === "granted";

  async function toggleVideo() {
    setBusy(true);
    try {
      await session?.peers?.setVideoEnabled(!camOn);
    } finally {
      setBusy(false);
    }
  }

  async function toggleShare() {
    setShareError("");
    try {
      if (sharing) await session?.peers?.stopScreenShare();
      else await session?.peers?.startScreenShare();
    } catch (err) {
      const e = err as DOMException;
      // The user dismissing the picker is not an error worth shouting about.
      if (e.name !== "NotAllowedError" && e.name !== "AbortError") {
        setShareError(e.message || "Screen share failed");
      }
    }
  }

  return (
    <div className="controls">
      <div className="controls-left">
        <span className="controls-me">{me?.name}</span>
      </div>

      <div className="controls-main">
        <button
          className={`btn btn-toggle ${micOn ? "on" : "off"}`}
          disabled={!micAvailable}
          title={micAvailable ? "Mute / unmute" : "No microphone available"}
          onClick={() => session?.peers?.setMicEnabled(!micOn)}
        >
          {micOn ? "Mic on" : "Mic off"}
        </button>

        <button
          className={`btn btn-toggle ${camOn ? "on" : ""}`}
          disabled={busy}
          title={
            camOn
              ? "Turn your camera off"
              : "Start sending video to the people you're talking to"
          }
          onClick={toggleVideo}
        >
          {busy ? "…" : camOn ? "Stop video" : "Turn on video"}
        </button>

        <button
          className={`btn btn-toggle ${sharing ? "on" : ""}`}
          onClick={toggleShare}
          title="Share your screen with the people you're currently talking to"
        >
          {sharing ? "Stop sharing" : "Share screen"}
        </button>

        <button
          className={`btn btn-toggle ${locked ? "locked" : ""}`}
          disabled={!inCall && !locked}
          title={
            locked
              ? "Unlock so others can join again"
              : inCall
                ? "Stop anyone else from joining this conversation"
                : "Walk up to someone first"
          }
          onClick={() => session?.setLocked(!locked)}
        >
          {locked ? "Unlock" : "Lock conversation"}
        </button>

        <button
          className={`btn btn-toggle ${status === "focus" ? "focus" : ""}`}
          onClick={() => session?.setStatus(status === "focus" ? "available" : "focus")}
          title="In focus mode nobody can start a call with you at all"
        >
          {status === "focus" ? "Focus mode" : "Available"}
        </button>
      </div>

      <div className="controls-right">
        {camState === "denied" || camState === "unavailable" ? (
          <span className="controls-error">{cameraError}</span>
        ) : null}
        {shareError && <span className="controls-error">{shareError}</span>}
        <button
          className="btn btn-quiet"
          onClick={async () => {
            await session?.disconnect();
            await logout();
            location.reload();
          }}
        >
          Leave
        </button>
      </div>
    </div>
  );
}
