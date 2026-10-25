import { useEffect, useRef } from "react";
import { useStore } from "../store.js";
import { usePrefs } from "../prefs.js";

/** Chrome and Edge can choose the output device; elsewhere it's the system default. */
export const canPickSpeaker = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype;

/** Points an audio element at the speaker picked in Settings (if the browser can). */
export function applySpeaker(el: HTMLMediaElement, deviceId: string): void {
  if (!canPickSpeaker) return;
  void (el as HTMLMediaElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId).catch(() => {
    /* device gone: the browser keeps playing on the default */
  });
}

/**
 * Plays one peer's voice. Kept apart from the video bubbles so hearing someone
 * never depends on where, or whether, their tile is drawn.
 */
function PeerAudio({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  const speaker = usePrefs((s) => s.speakerDeviceId);

  useEffect(() => {
    if (ref.current) applySpeaker(ref.current, speaker);
  }, [speaker]);

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
