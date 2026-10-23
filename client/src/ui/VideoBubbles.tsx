import { useEffect, useRef } from "react";
import { useStore, type PeerView } from "../store.js";
import { positionBus } from "../game/bus.js";

/** Attaches a MediaStream to a <video> without React re-creating the element. */
function useStreamRef(stream: MediaStream | null) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  return ref;
}

function PeerBubble({ peer, name, status }: { peer: PeerView; name: string; status: string }) {
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

  const connecting = peer.connectionState !== "connected";
  // Audio-only is the default, so most bubbles show an initial rather than video.
  const hasVideo = !!peer.stream?.getVideoTracks().length;

  return (
    <div className={`bubble ${hasVideo ? "" : "bubble-audio"}`} ref={box} data-state={peer.connectionState}>
      <div className="bubble-video">
        <video ref={video} autoPlay playsInline />
        {!hasVideo && <div className="bubble-placeholder">{name.slice(0, 1).toUpperCase()}</div>}
        {connecting && <div className="bubble-connecting">connecting…</div>}
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
    <div className="self-preview">
      <video ref={video} autoPlay playsInline muted />
      <span className="self-preview-tag">{screenStream ? "your screen" : "you"}</span>
    </div>
  );
}
