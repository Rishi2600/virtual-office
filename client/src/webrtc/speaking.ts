import { useStore } from "../store.js";

/**
 * Who's speaking right now, for the green rings and bars. Each audio stream
 * (yours and every peer's) gets a Web Audio analyser; ten times a second we
 * read its current loudness and keep a short "hangover" so the indicator
 * doesn't flicker between words.
 *
 * Privacy: this only looks at the live volume level. Nothing is recorded,
 * buffered, stored or sent anywhere.
 */
const THRESHOLD = 0.035; // RMS level counted as speech (0..1)
const HANGOVER_MS = 450;
const TICK_MS = 100;

let ctx: AudioContext | null = null;
const meters = new Map<string, { stream: MediaStream; analyser: AnalyserNode; source: MediaStreamAudioSourceNode; lastLoud: number }>();
const buf = new Float32Array(512);
let timer: ReturnType<typeof setInterval> | null = null;

function audioContext(): AudioContext {
  if (!ctx) {
    ctx = new AudioContext();
    // Browsers start an AudioContext suspended until the page has had a
    // click or key press; resume on the first one.
    const resume = () => void ctx?.resume();
    window.addEventListener("pointerdown", resume, { once: true });
    window.addEventListener("keydown", resume, { once: true });
  }
  return ctx;
}

/** Starts (or updates) metering a stream for a session id; null stops it. */
export function meter(sessionId: string, stream: MediaStream | null): void {
  const existing = meters.get(sessionId);
  if (existing && existing.stream === stream) return;
  if (existing) {
    existing.source.disconnect();
    meters.delete(sessionId);
  }
  if (!stream || stream.getAudioTracks().length === 0) {
    setSpeaking(sessionId, false);
    return;
  }
  const ac = audioContext();
  const source = ac.createMediaStreamSource(stream);
  const analyser = ac.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser); // analyser only: not connected to the speakers
  meters.set(sessionId, { stream, analyser, source, lastLoud: 0 });
  timer ??= setInterval(tick, TICK_MS);
}

/** Stops metering everything not in `keep`. */
export function prune(keep: Set<string>): void {
  for (const id of [...meters.keys()]) if (!keep.has(id)) meter(id, null);
}

function tick(): void {
  const now = performance.now();
  for (const [id, m] of meters) {
    m.analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (const v of buf) sum += v * v;
    if (Math.sqrt(sum / buf.length) > THRESHOLD) m.lastLoud = now;
    setSpeaking(id, now - m.lastLoud < HANGOVER_MS);
  }
}

function setSpeaking(id: string, on: boolean): void {
  const s = useStore.getState();
  if (!!s.speaking[id] === on) return;
  const next = { ...s.speaking };
  if (on) next[id] = true;
  else delete next[id];
  s.set({ speaking: next });
}
