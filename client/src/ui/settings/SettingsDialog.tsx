import { useCallback, useEffect, useRef, useState } from "react";
import { DoorOpen, Mic, Volume2, VideoOff } from "lucide-react";
import { useStore } from "../../store.js";
import { usePrefs } from "../../prefs.js";
import type { Session } from "../../net/session.js";
import { logout } from "../../net/api.js";
import { switchCamera, switchMicrophone } from "../../webrtc/media.js";
import { canPickSpeaker } from "../RemoteAudio.js";
import { testChime } from "../sounds.js";
import { Button, Dialog, Kbd, Select, Switch } from "../primitives/primitives.js";
import { toast } from "../primitives/toasts.js";
import { isMac } from "../stage/TopBar.js";
import "./settings.css";

/** The devices of one kind, kept current as things are plugged in and out. */
function useDevices(kind: MediaDeviceKind, open: boolean) {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    if (!open || !navigator.mediaDevices?.enumerateDevices) return;
    const load = () =>
      void navigator.mediaDevices
        .enumerateDevices()
        .then((all) => setDevices(all.filter((d) => d.kind === kind && d.deviceId)))
        .catch(() => setDevices([]));
    load();
    navigator.mediaDevices.addEventListener("devicechange", load);
    return () => navigator.mediaDevices.removeEventListener("devicechange", load);
  }, [kind, open]);
  return devices;
}

/** "Default" first, then each device; browsers hide names until media is allowed. */
function options(devices: MediaDeviceInfo[], noun: string) {
  return [
    { value: "", label: "System default" },
    ...devices
      .filter((d) => d.deviceId !== "default")
      .map((d, i) => ({ value: d.deviceId, label: d.label || `${noun} ${i + 1}` })),
  ];
}

/** A live input level for your microphone. Reads the volume only; nothing is kept. */
function MicLevel({ stream }: { stream: MediaStream | null }) {
  const bar = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!stream?.getAudioTracks().length) return;
    const ac = new AudioContext();
    const source = ac.createMediaStreamSource(stream);
    const analyser = ac.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let raf = 0;
    const tick = () => {
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.min(1, Math.sqrt(sum / buf.length) * 6);
      if (bar.current) bar.current.style.width = `${Math.round(level * 100)}%`;
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => {
      cancelAnimationFrame(raf);
      source.disconnect();
      void ac.close();
    };
  }, [stream]);
  return (
    <div className="level" role="meter" aria-label="Microphone level">
      <i ref={bar} />
    </div>
  );
}

function CameraPreview({ stream }: { stream: MediaStream | null }) {
  const ref = useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && el.srcObject !== stream) el.srcObject = stream;
    },
    [stream],
  );
  return <video ref={ref} className="cam-preview" autoPlay playsInline muted />;
}

/** [what, keys, or a plain-text way to do it] */
const SHORTCUTS: Array<[string, string[], string?]> = [
  ["Move", ["↑ ↓ ← →", "W A S D"]],
  ["Walk somewhere", [], "click the map"],
  ["Find a person", [isMac ? "⌘ K" : "Ctrl K"]],
  ["Chat / back to the map", ["Enter", "Esc"]],
  ["Mic · camera · screen", ["M", "V", "P"]],
  ["Lock huddle · focus mode", ["L", "F"]],
  ["Zoom · back to me", ["+", "−", "0"]],
];

export function SettingsDialog({ session, onLeave }: { session: Session | null; onLeave: () => void }) {
  const open = useStore((s) => s.dialog === "settings");
  const localStream = useStore((s) => s.localStream);
  const micState = useStore((s) => s.micState);
  const camOn = useStore((s) => s.camOn);
  const prefs = usePrefs();
  const mics = useDevices("audioinput", open);
  const cams = useDevices("videoinput", open);
  const speakers = useDevices("audiooutput", open);
  const close = () => useStore.getState().set({ dialog: null });

  const pickMic = async (id: string) => {
    if (!(await switchMicrophone(id))) return toast({ text: "Couldn't open that microphone.", tone: "warn" });
    session?.peers?.setLocalStream(useStore.getState().localStream);
  };
  const pickCam = async (id: string) => {
    if (!(await switchCamera(id))) return toast({ text: "Couldn't open that camera.", tone: "warn" });
    session?.peers?.setLocalStream(useStore.getState().localStream);
  };
  const setNotifications = async (on: boolean) => {
    if (on && Notification.permission !== "granted") {
      const answer = await Notification.requestPermission();
      if (answer !== "granted") {
        toast({ text: "Notifications are blocked for this site in your browser.", tone: "warn" });
        return;
      }
    }
    prefs.setPref("notifications", on);
  };

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Settings"
      testId="settings"
      footer={
        <>
          <Button
            variant="ghost"
            onClick={() => {
              close();
              onLeave();
            }}
          >
            <DoorOpen size={16} /> Leave office
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={() => void logout().finally(() => (location.href = "/"))}>Sign out</Button>
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        </>
      }
    >
      <div>
        <Select label="Microphone" value={prefs.micDeviceId} options={options(mics, "Microphone")} onChange={(id) => void pickMic(id)} />
        <div className="level-row">
          <Mic size={15} />
          {open && micState === "granted" ? <MicLevel stream={localStream} /> : <div className="level" />}
        </div>
        <div className="help">
          {micState === "granted"
            ? "Talk to see the level move. Echo cancellation and noise suppression are on."
            : "The microphone isn't available yet, so there's nothing to show."}
        </div>
      </div>

      <div>
        <Select label="Camera" value={prefs.camDeviceId} options={options(cams, "Camera")} onChange={(id) => void pickCam(id)} />
        {camOn ? (
          <CameraPreview stream={localStream} />
        ) : (
          <div className="cam-off">
            <VideoOff size={16} /> Your camera stays off until you turn it on (V).
          </div>
        )}
      </div>

      <div>
        <div className="speaker-row">
          {canPickSpeaker ? (
            <Select
              label="Speakers"
              value={prefs.speakerDeviceId}
              options={options(speakers, "Speaker")}
              onChange={(id) => prefs.setPref("speakerDeviceId", id)}
            />
          ) : (
            <div className="field">
              <label>Speakers</label>
              <div className="help">This browser always uses your system's sound output.</div>
            </div>
          )}
          <Button onClick={testChime}>
            <Volume2 size={16} /> Test
          </Button>
        </div>
      </div>

      <Switch
        label="Sounds"
        description="A soft chime when someone joins you or sends you a message"
        checked={prefs.sounds}
        onChange={(v) => prefs.setPref("sounds", v)}
      />
      <Switch
        label="Desktop notifications"
        description="For messages while Lamports is in the background"
        checked={prefs.notifications && typeof Notification !== "undefined" && Notification.permission === "granted"}
        disabled={typeof Notification === "undefined"}
        onChange={(v) => void setNotifications(v)}
      />

      <div className="field">
        <label>Keyboard shortcuts</label>
        <dl className="keys">
          {SHORTCUTS.map(([what, keys, text]) => (
            <div key={what}>
              <dt>{what}</dt>
              <dd>
                {keys.map((k) => (
                  <Kbd key={k}>{k}</Kbd>
                ))}
                {text}
              </dd>
            </div>
          ))}
        </dl>
      </div>
    </Dialog>
  );
}
