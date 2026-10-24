import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { applyDevIdentityFromUrl, fetchConfig, fetchMe } from "../net/api.js";
import { Session } from "../net/session.js";
import { GameCanvas } from "../game/GameCanvas.js";
import { Login } from "./Login.js";
import { PresenceList } from "./PresenceList.js";
import { Controls } from "./Controls.js";
import { AudioBlockedBanner, ConnectionBanner, LiveIndicator, MediaBanner } from "./Banners.js";
import { RemoteAudio } from "./RemoteAudio.js";
import { Chat } from "./Chat.js";
import { SelfPreview, VideoBubbles } from "./VideoBubbles.js";

export function App() {
  const me = useStore((s) => s.me);
  const config = useStore((s) => s.config);
  const authChecked = useStore((s) => s.authChecked);
  const meId = me?.id;
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);

  // Bootstrap: who am I, and what does the server want the client to know?
  useEffect(() => {
    (async () => {
      try {
        // `?dev=Name` signs this tab in as that person before we ask who we are.
        await applyDevIdentityFromUrl();
        const [cfg, user] = await Promise.all([fetchConfig(), fetchMe()]);
        useStore.getState().set({ config: cfg, me: user, authChecked: true });
      } catch {
        useStore.getState().set({ authChecked: true });
      }
    })();
  }, []);

  // Join the space once we know who we are.
  useEffect(() => {
    if (!meId || !config) return;

    const s = new Session();
    sessionRef.current = s;
    // The session is an external resource created here and handed to the
    // children; storing it in state is what lets them re-render against it.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSession(s);
    // Lets you inspect live peer connections from the console when a call
    // misbehaves: __session.peers
    if (import.meta.env.DEV) (window as unknown as { __session?: Session }).__session = s;
    s.connect().catch((err: Error) => {
      useStore.getState().set({
        connection: "failed",
        connectionDetail: err.message || "Could not join the space.",
      });
    });

    return () => {
      sessionRef.current = null;
      setSession(null);
      void s.disconnect();
    };
  }, [meId, config]);

  if (!authChecked) return <div className="boot">Loading…</div>;
  if (!me) return <Login />;

  return (
    <div className="app">
      <div className="stage">
        {session && <GameCanvas />}
        <VideoBubbles />
        <RemoteAudio />
        <SelfPreview />
        <LiveIndicator />
        <div className="banners">
          <ConnectionBanner />
          <AudioBlockedBanner />
          <MediaBanner session={session} />
        </div>
      </div>
      <aside className="sidebar">
        <PresenceList />
        <Chat session={session} />
      </aside>
      <Controls session={session} />
    </div>
  );
}
