import { useStore } from "../store.js";
import { retryMicrophone } from "../webrtc/media.js";
import type { Session } from "../net/session.js";

export function ConnectionBanner() {
  const connection = useStore((s) => s.connection);
  const detail = useStore((s) => s.connectionDetail);

  if (connection === "connected" || connection === "idle") return null;

  return (
    <div className={`banner banner-${connection === "failed" ? "error" : "warn"}`}>
      <span>
        {connection === "connecting" && "Connecting…"}
        {connection === "reconnecting" && (detail || "Reconnecting…")}
        {connection === "failed" && (detail || "Disconnected.")}
      </span>
      {connection === "failed" && (
        <button className="btn btn-small" onClick={() => location.reload()}>
          Reload
        </button>
      )}
    </div>
  );
}

/**
 * Microphone problems get an explicit, actionable state — never a silent
 * failure. Calls still connect receive-only and text chat is unaffected, so the
 * copy says what you CAN still do rather than just what broke.
 */
export function MediaBanner({ session }: { session: Session | null }) {
  const micState = useStore((s) => s.micState);
  const error = useStore((s) => s.mediaError);

  if (micState !== "denied" && micState !== "unavailable") return null;

  // `error` is already a complete sentence naming the device and the cause, so
  // there is no separate heading here — adding one duplicated the wording.
  return (
    <div className="banner banner-warn">
      <span>{error}</span>
      <button
        className="btn btn-small"
        onClick={async () => {
          await retryMicrophone();
          session?.peers?.setLocalStream(useStore.getState().localStream);
        }}
      >
        Try again
      </button>
    </div>
  );
}

/** Tells the user their hardware is live, so it's never a surprise. */
export function LiveIndicator() {
  const micState = useStore((s) => s.micState);
  const micOn = useStore((s) => s.micOn);
  const camOn = useStore((s) => s.camOn);
  const sharing = useStore((s) => s.sharing);
  const inCall = useStore((s) => Object.keys(s.peers).length > 0);

  const micLive = micState === "granted" && micOn && inCall;
  if (!micLive && !camOn && !sharing) return null;

  const parts = [micLive && "mic", camOn && "camera", sharing && "screen"].filter(Boolean);

  return (
    <div className="live-indicator" title="Your hardware is currently in use">
      <span className="live-dot" />
      {parts.join(" + ")} live
    </div>
  );
}
