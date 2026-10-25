import { usePrefs } from "../prefs.js";
import { applySpeaker } from "./RemoteAudio.js";

/**
 * Soft chimes, synthesised on the spot (no audio files), played through the
 * speaker picked in Settings. Off by default (owner decision): `chime` only
 * plays when the Sounds setting is on; `testChime` is the Settings button.
 */
export type ChimeKind = "join" | "message";

const NOTES: Record<ChimeKind | "test", number[]> = {
  join: [660, 880],
  message: [880],
  test: [523, 659, 784],
};

let ctx: AudioContext | null = null;

function play(notes: number[]): void {
  try {
    ctx ??= new AudioContext();
    void ctx.resume();
    const out = ctx.createMediaStreamDestination();
    const t0 = ctx.currentTime + 0.02;
    notes.forEach((freq, i) => {
      const osc = ctx!.createOscillator();
      const gain = ctx!.createGain();
      osc.type = "sine";
      osc.frequency.value = freq;
      const start = t0 + i * 0.12;
      gain.gain.setValueAtTime(0, start);
      gain.gain.linearRampToValueAtTime(0.12, start + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
      osc.connect(gain).connect(out);
      osc.start(start);
      osc.stop(start + 0.4);
    });
    // Through an <audio> element rather than ctx.destination, so it can be
    // sent to the chosen speaker.
    const el = new Audio();
    el.srcObject = out.stream;
    applySpeaker(el, usePrefs.getState().speakerDeviceId);
    void el.play().catch(() => {});
    setTimeout(() => (el.srcObject = null), 400 + notes.length * 120);
  } catch {
    /* no Web Audio: silently skip */
  }
}

export function chime(kind: ChimeKind): void {
  if (usePrefs.getState().sounds) play(NOTES[kind]);
}

export const testChime = () => play(NOTES.test);
