import { MicOff, Volume2, WifiOff } from "lucide-react";
import { useStore } from "../../store.js";
import type { Session } from "../../net/session.js";
import { retryMicrophone } from "../../webrtc/media.js";
import { resumeRemoteAudio } from "../RemoteAudio.js";
import { Button } from "../primitives/primitives.js";
import { IntroCard } from "./IntroCard.js";
import "./stage.css";

/**
 * Problems that need the user's attention, on readable surfaces over the map:
 * lost connection, a blocked microphone, audio blocked by the browser. Each
 * says what still works and offers the fix.
 */
export function StageBanners({ session }: { session: Session | null }) {
  const connection = useStore((s) => s.connection);
  const detail = useStore((s) => s.connectionDetail);
  const micState = useStore((s) => s.micState);
  const audioBlocked = useStore((s) => s.audioBlocked);

  const banners = [];
  if (connection === "reconnecting" || connection === "connecting" || connection === "failed") {
    const failed = connection === "failed";
    banners.push(
      <div key="conn" className={`banner ${failed ? "bad" : "warn"}`} role="alert">
        <WifiOff size={20} className="banner-icon" />
        <div className="banner-text">
          <div className="banner-title">{failed ? "Couldn't reconnect" : connection === "connecting" ? "Joining the office…" : "Connection lost, reconnecting…"}</div>
          <div className="banner-detail">
            {failed
              ? detail || "Check your network, then reload."
              : connection === "connecting"
                ? "One moment."
                : detail.includes("offline")
                  ? detail
                  : "You'll be back in your spot in a moment. Calls resume automatically."}
          </div>
        </div>
        {failed && <Button onClick={() => location.reload()}>Reload</Button>}
      </div>,
    );
  }
  if (micState === "denied" || micState === "unavailable") {
    banners.push(
      <div key="mic" className="banner bad" role="alert">
        <MicOff size={20} className="banner-icon" />
        <div className="banner-text">
          <div className="banner-title">{micState === "denied" ? "Your microphone is blocked" : "No microphone available"}</div>
          <div className="banner-detail">Others can't hear you. You can still hear them and chat.</div>
        </div>
        <Button
          onClick={async () => {
            await retryMicrophone();
            session?.peers?.setLocalStream(useStore.getState().localStream);
          }}
        >
          Try again
        </Button>
      </div>,
    );
  }
  if (audioBlocked) {
    banners.push(
      <div key="audio" className="banner warn" role="alert">
        <Volume2 size={20} className="banner-icon" />
        <div className="banner-text">
          <div className="banner-title">Sound is paused by your browser</div>
          <div className="banner-detail">Click to hear the people near you.</div>
        </div>
        <Button variant="primary" onClick={resumeRemoteAudio}>
          Enable audio
        </Button>
      </div>,
    );
  }
  // The first-run intro sits in the same stack, under any problems.
  return (
    <div className="banners">
      {banners}
      <IntroCard />
    </div>
  );
}
