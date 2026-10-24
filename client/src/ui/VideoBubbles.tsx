import { useCallback, useEffect, useRef } from "react";
import { useStore, type CallQuality, type CallStatus, type PeerView } from "../store.js";
import { positionBus } from "../game/bus.js";

/**
 * Attaches a MediaStream to a <video> without React re-creating the element.
 * A callback ref, so the stream is attached whenever the element mounts; an
 * effect keyed on the stream missed elements that mount after it changed (the
 * self-preview stayed black).
 */
function useStreamRef(stream: MediaStream | null) {
  return useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && el.srcObject !== stream) el.srcObject = stream;
    },
    [stream],
  );
}

const STATUS_TEXT: Record<Exclude<CallStatus, "connected">, string> = {
  connecting: "connecting…",
  reconnecting: "reconnecting…",
  failed: "can't connect",
};

/** Covers the tile whenever the call isn't working, saying why. */
function CallStatusOverlay({ status }: { status: CallStatus }) {
  if (status === "connected") return null;
  return (
    <div className="bubble-overlay" role="status">
      <span>{STATUS_TEXT[status]}</span>
      {status === "failed" && <span className="bubble-overlay-hint">network may be blocking calls · still trying</span>}
    </div>
  );
}

/** Green / amber / red dot for the call's measured quality. */
function QualityDot({ quality }: { quality: CallQuality }) {
  const parts = [
    `connection ${quality.level}`,
    quality.rttMs !== null ? `${quality.rttMs} ms` : null,
    quality.lossPct !== null ? `${quality.lossPct}% loss` : null,
    quality.relayed ? "via relay" : null,
  ].filter(Boolean);
  return <span className="bubble-quality" data-quality={quality.level} aria-label={parts.join(", ")} title={parts.join(", ")} />;
}

interface PeerBubbleProps {
  peer: PeerView;
  name: string;
  status: string;
  /** The peer says their camera or screen is on. */
  sendingVideo: boolean;
}

function PeerBubble({ peer, name, status, sendingVideo }: PeerBubbleProps) {
  const box = useRef<HTMLDivElement>(null);
  const video = useStreamRef(peer.stream);

  // Follow the avatar every frame by writing transform directly — going through
  // React state at 60Hz would re-render the whole tree.
  useEffect(
    () =>
      positionBus.on((positions) => {
        const el = box.current;
        if (!el) return;
        const p = positions[peer.peerId];
        if (!p || !p.visible) {
          el.style.opacity = "0";
          return;
        }
        el.style.opacity = "1";
        // Lift clear of the sprite so the bubble sits above the head rather
        // than covering the avatar it belongs to.
        el.style.transform = `translate3d(${p.x}px, ${p.y - 26}px, 0) translate(-50%, -100%)`;
      }),
    [peer.peerId],
  );

  // Audio-only is the default, so most bubbles show an initial rather than video.
  // A received video track outlives the peer turning their camera off, so the
  // track alone isn't enough: their camOn/sharing flags decide.
  const hasVideo = sendingVideo && !!peer.stream?.getVideoTracks().length;

  return (
    <div className={`bubble ${hasVideo ? "" : "bubble-audio"}`} ref={box} data-status={peer.callStatus}>
      <div className="bubble-video">
        {/* Muted: the peer's voice plays through RemoteAudio. */}
        <video ref={video} autoPlay playsInline muted />
        {!hasVideo && <div className="bubble-placeholder">{name.slice(0, 1).toUpperCase()}</div>}
        <CallStatusOverlay status={peer.callStatus} />
        {peer.callStatus === "connected" && peer.quality && <QualityDot quality={peer.quality} />}
      </div>
      <div className="bubble-name">
        {name}
        {status ? <span className="bubble-status"> · {status}</span> : null}
      </div>
    </div>
  );
}

export function VideoBubbles() {
  const peers = useStore((s) => s.peers);
  const players = useStore((s) => s.players);

  return (
    <div className="bubble-layer">
      {Object.values(peers).map((peer) => {
        const player = players[peer.peerId];
        const status = !player
          ? ""
          : player.sharing
            ? "sharing screen"
            : !player.micOn
              ? "muted"
              : "";
        return (
          <PeerBubble
            key={peer.peerId}
            peer={peer}
            name={player?.name ?? "Someone"}
            status={status}
            sendingVideo={!!player && (player.camOn || player.sharing)}
          />
        );
      })}
    </div>
  );
}

/**
 * Your own camera (or screen, while sharing), pinned in the corner. Only shown
 * when there is actually outgoing video — with audio-only calls there is nothing
 * to preview, and an empty black box would just look broken.
 */
export function SelfPreview() {
  const localStream = useStore((s) => s.localStream);
  const screenStream = useStore((s) => s.screenStream);
  const camOn = useStore((s) => s.camOn);
  const shown = screenStream ?? localStream;
  const video = useStreamRef(shown);

  const hasCameraVideo = camOn && !!localStream?.getVideoTracks().length;
  if (!screenStream && !hasCameraVideo) return null;

  return (
    // Mirror only the camera, like a mirror; a mirrored screen is unreadable.
    <div className={`self-preview ${screenStream ? "" : "self-preview-mirrored"}`}>
      <video ref={video} autoPlay playsInline muted />
      <span className="self-preview-tag">{screenStream ? "your screen" : "you"}</span>
    </div>
  );
}
