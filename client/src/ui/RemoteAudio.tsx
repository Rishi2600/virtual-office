import { useEffect, useRef } from "react";
import { useStore } from "../store.js";

/**
 * Plays one peer's voice. Kept apart from the video bubbles so hearing someone
 * never depends on where, or whether, their tile is drawn.
 */
function PeerAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    // Called explicitly (not via the autoplay attribute) so a refusal is
    // reported instead of failing silently.
    el.play().catch((err: DOMException) => {
      if (err.name === "NotAllowedError") useStore.getState().set({ audioBlocked: true });
    });
  }, [stream]);

  return <audio ref={ref} data-remote-audio />;
}

export function RemoteAudio() {
  const peers = useStore((s) => s.peers);
  return (
    <div hidden>
      {Object.values(peers).map((p) => p.audio && <PeerAudio key={p.peerId} stream={p.audio} />)}
    </div>
  );
}

/** Restarts every peer's audio. Must run inside a user gesture (a click). */
export function resumeRemoteAudio(): void {
  document
    .querySelectorAll<HTMLAudioElement>("audio[data-remote-audio]")
    .forEach((el) => void el.play().catch(() => {}));
  useStore.getState().set({ audioBlocked: false });
}
