import { useEffect, useRef, useState } from "react";
import { useStore } from "../store.js";
import { applyDevIdentityFromUrl, fetchConfig, fetchMe } from "../net/api.js";
import { Session } from "../net/session.js";
import { Login, Unreachable } from "./Login.js";
import { useLayout } from "./layout.js";
import { Office } from "./stage/Office.js";
import { LeftScreen, PhoneBlock } from "./stage/Screens.js";
import { Toasts } from "./primitives/toasts.js";

export function App() {
  const me = useStore((s) => s.me);
  const config = useStore((s) => s.config);
  const authChecked = useStore((s) => s.authChecked);
  const meId = me?.id;
  const layout = useLayout();
  // "Leave office" disconnects without signing out; Rejoin flips it back.
  const [left, setLeft] = useState(false);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef<Session | null>(null);
  // The server couldn't be reached at all (not "signed out": that's a 401).
  const [unreachable, setUnreachable] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // Bootstrap: who am I, and what does the server want the client to know?
  useEffect(() => {
    (async () => {
      try {
        // `?dev=Name` signs this tab in as that person before we ask who we are.
        await applyDevIdentityFromUrl().catch(() => false);
        const [cfg, user] = await Promise.all([fetchConfig(), fetchMe()]);
        setUnreachable(false);
        useStore.getState().set({ config: cfg, me: user, authChecked: true });
      } catch {
        setUnreachable(true);
        useStore.getState().set({ authChecked: true });
      }
    })();
  }, [attempt]);

  // Join the space once we know who we are.
  useEffect(() => {
    if (!meId || !config || left) return;

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
  }, [meId, config, left]);

  if (layout === "phone") return <PhoneBlock />;
  if (!authChecked) return <div className="boot">Loading…</div>;
  if (unreachable) return <Unreachable onRetry={() => setAttempt((n) => n + 1)} />;
  if (!me) return <Login />;
  if (left) return <LeftScreen onRejoin={() => setLeft(false)} />;

  return (
    <>
      <Office session={session} onLeave={() => setLeft(true)} />
      <Toasts />
    </>
  );
}
