import { useEffect } from "react";
import { DoorOpen, Lock, LockOpen, Mic, MicOff, MonitorUp, Moon, MoreHorizontal, Palette, Settings, Video, VideoOff } from "lucide-react";
import { useStore } from "../../store.js";
import type { Session } from "../../net/session.js";
import { retryMicrophone } from "../../webrtc/media.js";
import { IconButton, MenuButton } from "../primitives/primitives.js";
import { toast, useToasts } from "../primitives/toasts.js";
import "./stage.css";

/** True when a key press is meant for a text field, not for us. */
export const isTyping = (e: KeyboardEvent) => {
  const t = e.target as HTMLElement | null;
  return !!t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName));
};

/**
 * The floating control dock: mic, camera, screen │ lock, focus │ more.
 * Every button shows its state (on / off / blocked), names its action and its
 * shortcut, and the shortcuts work anywhere except while typing.
 */
export function Dock({ session, onLeave }: { session: Session | null; onLeave: () => void }) {
  const micOn = useStore((s) => s.micOn);
  const micState = useStore((s) => s.micState);
  const camOn = useStore((s) => s.camOn);
  const camState = useStore((s) => s.camState);
  const sharing = useStore((s) => s.sharing);
  const status = useStore((s) => s.status);
  const inCall = useStore((s) => Object.keys(s.peers).length > 0);
  const locked = useStore((s) => !!(s.sessionId && s.players[s.sessionId]?.lockGroup));

  const micBlocked = micState === "denied" || micState === "unavailable";
  const camBlocked = camState === "denied" || camState === "unavailable";

  const toggleMic = async () => {
    if (micBlocked) {
      await retryMicrophone();
      session?.peers?.setLocalStream(useStore.getState().localStream);
      return;
    }
    session?.peers?.setMicEnabled(!useStore.getState().micOn);
  };
  const toggleCamera = async () => {
    const ok = await session?.peers?.setVideoEnabled(!useStore.getState().camOn);
    if (ok === false) {
      toast({ key: "camera", text: useStore.getState().cameraError || "Couldn't start the camera.", tone: "warn", icon: <VideoOff size={16} /> });
    } else {
      useToasts.getState().dismissKey("camera");
    }
  };
  const toggleShare = async () => {
    try {
      if (useStore.getState().sharing) await session?.peers?.stopScreenShare();
      else await session?.peers?.startScreenShare();
    } catch (err) {
      const e = err as DOMException;
      // Closing the browser's picker isn't an error worth reporting.
      if (e.name !== "NotAllowedError" && e.name !== "AbortError") {
        toast({ text: e.message || "Screen sharing failed.", tone: "warn", icon: <MonitorUp size={16} /> });
      }
    }
  };
  const toggleLock = () => {
    if (!locked && !inCall) {
      toast({ text: "Walk up to someone first: locking makes a huddle private." });
      return;
    }
    session?.setLocked(!locked);
  };
  const toggleFocus = () => session?.setStatus(useStore.getState().status === "focus" ? "available" : "focus");

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e) || useStore.getState().dialog) return;
      const k = e.key.toLowerCase();
      if (k === "m") void toggleMic();
      else if (k === "v") void toggleCamera();
      else if (k === "p") void toggleShare();
      else if (k === "l") toggleLock();
      else if (k === "f") toggleFocus();
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="dock" role="toolbar" aria-label="Call controls" data-testid="dock">
      <IconButton
        label={micBlocked ? "Microphone blocked: try again" : micOn ? "Mute microphone" : "Unmute microphone"}
        shortcut="M"
        pressed={!micBlocked && micOn}
        tone={micBlocked || !micOn ? "off" : undefined}
        className="dock-btn"
        onClick={() => void toggleMic()}
      >
        {micBlocked || !micOn ? <MicOff size={20} /> : <Mic size={20} />}
        {micBlocked && <span className="dock-lbl">Mic blocked</span>}
      </IconButton>
      <IconButton
        label={camOn ? "Turn camera off" : camBlocked ? "Camera blocked: try again" : "Turn camera on"}
        shortcut="V"
        pressed={camOn}
        tone={camOn ? "active" : camBlocked ? "off" : undefined}
        className="dock-btn"
        onClick={() => void toggleCamera()}
      >
        {camOn ? <Video size={20} /> : <VideoOff size={20} />}
      </IconButton>
      <IconButton
        label={sharing ? "Stop sharing your screen" : "Share your screen"}
        shortcut="P"
        pressed={sharing}
        tone={sharing ? "active" : undefined}
        className="dock-btn"
        onClick={() => void toggleShare()}
      >
        <MonitorUp size={20} />
        {sharing && <span className="dock-lbl">Sharing</span>}
      </IconButton>
      <span className="dock-sep" />
      <IconButton
        label={locked ? "Unlock: let others join" : "Lock huddle: keep it private"}
        shortcut="L"
        pressed={locked}
        tone={locked ? "warn" : undefined}
        className="dock-btn"
        onClick={toggleLock}
      >
        {locked ? <Lock size={20} /> : <LockOpen size={20} />}
      </IconButton>
      <IconButton
        label={status === "focus" ? "Leave focus mode" : "Focus mode: nobody can call you"}
        shortcut="F"
        pressed={status === "focus"}
        tone={status === "focus" ? "warn" : undefined}
        className="dock-btn"
        onClick={toggleFocus}
      >
        <Moon size={20} />
        {status === "focus" && <span className="dock-lbl">Focus</span>}
      </IconButton>
      <span className="dock-sep" />
      <MenuButton
        label="More"
        align="right"
        placement="up"
        className="dock-btn"
        trigger={<MoreHorizontal size={20} />}
        items={[
          { label: "Settings", icon: <Settings size={16} />, onSelect: () => useStore.getState().set({ dialog: "settings" }) },
          { label: "Edit avatar", icon: <Palette size={16} />, onSelect: () => useStore.getState().set({ dialog: "avatar" }) },
          { label: "Leave office", icon: <DoorOpen size={16} />, onSelect: onLeave },
        ]}
      />
    </div>
  );
}
