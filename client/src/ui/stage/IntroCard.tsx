import { Footprints, MessageSquare, Search, Video, X } from "lucide-react";
import { useStore } from "../../store.js";
import { usePrefs } from "../../prefs.js";
import { Button, Kbd } from "../primitives/primitives.js";
import { isMac } from "./TopBar.js";
import "./stage.css";

/**
 * Four lines on how the office works, shown once per browser on the first
 * visit (after the avatar builder), then never again.
 */
export function IntroCard() {
  const seen = usePrefs((s) => s.introSeen);
  const ready = useStore((s) => s.connection === "connected" && s.dialog === null && s.me?.avatar !== "");
  if (seen || !ready) return null;
  const done = () => usePrefs.getState().setPref("introSeen", true);
  return (
    <section className="intro" aria-label="How Lamports works" data-testid="intro">
      <header>
        <b>Welcome to the office</b>
        <button type="button" className="intro-close" aria-label="Close" onClick={done}>
          <X size={16} />
        </button>
      </header>
      <ul>
        <li>
          <Footprints size={16} />
          <span>Move with <Kbd>↑ ↓ ← →</Kbd> or <Kbd>W A S D</Kbd>, or click the floor.</span>
        </li>
        <li>
          <MessageSquare size={16} />
          <span>Walk up to someone and you can talk and chat. Walk away and it ends.</span>
        </li>
        <li>
          <Video size={16} />
          <span>Your camera only turns on when you click it. Nothing is ever recorded.</span>
        </li>
        <li>
          <Search size={16} />
          <span>Looking for someone? <Kbd>{isMac ? "⌘ K" : "Ctrl K"}</Kbd></span>
        </li>
      </ul>
      <Button variant="primary" onClick={done}>
        Got it
      </Button>
    </section>
  );
}
