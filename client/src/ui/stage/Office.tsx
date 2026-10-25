import { Suspense, lazy, useEffect } from "react";
import { useStore } from "../../store.js";
import type { Session } from "../../net/session.js";
import { meter, prune } from "../../webrtc/speaking.js";
import { useLayout } from "../layout.js";
import { ChatPanel } from "../chat/ChatPanel.js";
import { useChatAlerts } from "../chat/useChatAlerts.js";
import { PeoplePanel } from "../people/PeoplePanel.js";
import { RemoteAudio } from "../RemoteAudio.js";
import { SettingsDialog } from "../settings/SettingsDialog.js";
import { FinderDialog } from "../people/FinderDialog.js";
import { AvatarBuilder } from "../avatar/AvatarBuilder.js";
import { Dock } from "./Dock.js";
import { HuddleBar } from "./HuddleBar.js";
import { MapOverlay } from "./MapOverlay.js";
import { MapTools } from "./MapTools.js";
import { StageBanners } from "./StageBanners.js";
import { TopBar } from "./TopBar.js";
import "./stage.css";

/** The game engine (Phaser, the biggest part of the app) is only downloaded
 *  once you're signed in, so the sign-in page loads fast. */
const GameCanvas = lazy(() => import("../../game/GameCanvas.js").then((m) => ({ default: m.GameCanvas })));

/** Keeps the speaking meters in step with who you can hear (and yourself). */
function useSpeakingMeters() {
  const sessionId = useStore((s) => s.sessionId);
  const localStream = useStore((s) => s.localStream);
  const peers = useStore((s) => s.peers);
  useEffect(() => {
    const keep = new Set<string>();
    if (sessionId) {
      meter(sessionId, localStream);
      keep.add(sessionId);
    }
    for (const p of Object.values(peers)) {
      meter(p.peerId, p.audio);
      keep.add(p.peerId);
    }
    prune(keep);
  }, [sessionId, localStream, peers]);
  useEffect(() => () => prune(new Set()), []);
}

/**
 * The signed-in screen: top bar, people on the left, the map in the middle
 * with the huddle bar and dock floating over it, chat on the right. Below
 * 1280px the chat becomes a drawer over the map; on tablets the people list
 * collapses to faces.
 */
export function Office({ session, onLeave }: { session: Session | null; onLeave: () => void }) {
  const layout = useLayout();
  const chatVisible = useStore((s) => s.chatVisible);
  useSpeakingMeters();
  useChatAlerts();

  // Narrow screens start with the chat drawer closed so the map is usable.
  useEffect(() => {
    if (layout !== "desktop") useStore.getState().set({ chatVisible: false });
  }, [layout]);

  const docked = layout === "desktop" && chatVisible;
  const drawer = layout !== "desktop" && chatVisible;
  const closeChat = () => useStore.getState().set({ chatVisible: false });

  return (
    <div className="app">
      <TopBar onLeave={onLeave} />
      <div className={`office-body ${docked ? "with-chat" : ""} ${drawer ? "drawer-open" : ""} ${layout === "tablet" ? "tablet" : ""}`}>
        <PeoplePanel collapsed={layout === "tablet"} />
        <main className="stage" aria-label="Office map">
          {session && (
            <>
              <Suspense fallback={<div className="boot">Loading the office…</div>}>
                <GameCanvas />
              </Suspense>
              <MapOverlay />
              <MapTools />
            </>
          )}
          <RemoteAudio />
          <StageBanners session={session} />
          <HuddleBar session={session} />
          <Dock session={session} onLeave={onLeave} />
        </main>
        {docked && (
          <aside className="chat-dock" aria-label="Chat">
            <ChatPanel session={session} onClose={closeChat} />
          </aside>
        )}
        {drawer && (
          <aside className="chat-drawer" aria-label="Chat">
            <ChatPanel session={session} onClose={closeChat} />
          </aside>
        )}
      </div>
      <SettingsDialog session={session} onLeave={onLeave} />
      <FinderDialog />
      <AvatarBuilder session={session} />
    </div>
  );
}
