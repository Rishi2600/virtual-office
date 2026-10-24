import { useStore, type MediaState } from "../store.js";

/**
 * Microphone and camera acquisition.
 *
 * Two deliberate behaviours:
 *
 * 1. **Audio and video are requested SEPARATELY.** Asking for both in one
 *    getUserMedia call means a machine with a working mic but no webcam throws
 *    NotFoundError and you get *nothing* — not even audio. Splitting them means
 *    each device degrades on its own.
 *
 * 2. **We never re-prompt on our own.** The microphone is requested on load,
 *    so its outcome is cached and only the banner's explicit retry clears it.
 *    The camera is only requested by a click, so each click is itself an
 *    explicit retry and a camera failure is not cached.
 *
 * The camera is only ever requested when the user asks for it, so walking past
 * somebody never turns your webcam on.
 */
const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
};

const VIDEO_CONSTRAINTS: MediaTrackConstraints = {
  width: { ideal: 320 },
  height: { ideal: 240 },
  frameRate: { ideal: 24 },
};

let audioTrack: MediaStreamTrack | null = null;
let videoTrack: MediaStreamTrack | null = null;
let micPromise: Promise<MediaStreamTrack | null> | null = null;
let camPromise: Promise<MediaStreamTrack | null> | null = null;

/** Rebuild as a NEW MediaStream so React sees a changed reference and re-binds
 *  the <video> element; mutating one in place doesn't reliably re-render. */
function publishStream(): void {
  const tracks = [audioTrack, videoTrack].filter(Boolean) as MediaStreamTrack[];
  useStore.getState().set({ localStream: tracks.length ? new MediaStream(tracks) : null });
}

function classify(err: unknown): { state: MediaState; message: string } {
  const e = err as DOMException;
  if (e?.name === "NotAllowedError" || e?.name === "SecurityError") {
    return { state: "denied", message: "blocked in your browser" };
  }
  if (e?.name === "NotFoundError" || e?.name === "OverconstrainedError") {
    return { state: "unavailable", message: "no device found" };
  }
  if (e?.name === "NotReadableError") {
    return { state: "unavailable", message: "already in use by another app" };
  }
  return { state: "denied", message: e?.name ?? "unknown error" };
}

function unsupported(): boolean {
  // `navigator.mediaDevices` is absent entirely on insecure origins, so this has
  // to be a runtime check even though the DOM types claim it's always there.
  if (typeof navigator.mediaDevices?.getUserMedia === "function") return false;
  useStore.getState().set({
    micState: "unavailable",
    camState: "unavailable",
    mediaError:
      "This browser can't reach media devices. Camera and microphone need a secure context (https, or localhost).",
  });
  return true;
}

// ------------------------------------------------------------------ microphone
export function ensureMicrophone(): Promise<MediaStreamTrack | null> {
  if (micPromise) return micPromise;
  if (unsupported()) return Promise.resolve(null);

  useStore.getState().set({ micState: "prompting" });

  micPromise = navigator.mediaDevices
    .getUserMedia({ audio: AUDIO_CONSTRAINTS })
    .then((stream) => {
      audioTrack = stream.getAudioTracks()[0] ?? null;
      if (audioTrack) audioTrack.enabled = useStore.getState().micOn;
      publishStream();
      useStore.getState().set({ micState: "granted", mediaError: "" });
      return audioTrack;
    })
    .catch((err) => {
      const { state, message } = classify(err);
      useStore.getState().set({
        micState: state,
        mediaError: `Microphone ${message}. Others won't hear you, but you can still hear them and use chat.`,
      });
      return null;
    });

  return micPromise;
}

// ---------------------------------------------------------------------- camera
/** Only ever called from an explicit user action. */
export function ensureCamera(): Promise<MediaStreamTrack | null> {
  if (camPromise) return camPromise;
  if (unsupported()) return Promise.resolve(null);

  useStore.getState().set({ camState: "prompting" });

  camPromise = navigator.mediaDevices
    .getUserMedia({ video: VIDEO_CONSTRAINTS })
    .then((stream) => {
      videoTrack = stream.getVideoTracks()[0] ?? null;
      publishStream();
      useStore.getState().set({ camState: "granted", cameraError: "" });
      return videoTrack;
    })
    .catch((err) => {
      // Not cached: the next "Turn on video" click asks again.
      camPromise = null;
      const { state, message } = classify(err);
      useStore.getState().set({
        camState: state,
        cameraError: `Camera ${message}. Audio and chat still work.`,
      });
      return null;
    });

  return camPromise;
}

export function stopCamera(): void {
  videoTrack?.stop();
  videoTrack = null;
  camPromise = null;
  publishStream();
  useStore.getState().set({ camState: "idle", camOn: false });
}

export function getVideoTrack(): MediaStreamTrack | null {
  return videoTrack;
}

// --------------------------------------------------------------------- retries
/** Explicit user-initiated retry — the only thing that clears a denial. */
export function retryMicrophone(): Promise<MediaStreamTrack | null> {
  micPromise = null;
  useStore.getState().set({ micState: "idle", mediaError: "" });
  return ensureMicrophone();
}

export function stopAllMedia(): void {
  audioTrack?.stop();
  videoTrack?.stop();
  audioTrack = null;
  videoTrack = null;
  micPromise = null;
  camPromise = null;
  useStore.getState().set({ localStream: null, micState: "idle", camState: "idle" });
}
