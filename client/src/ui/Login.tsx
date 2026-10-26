import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ShieldCheck } from "lucide-react";
import { devSignIn, fetchMe } from "../net/api.js";
import { useStore } from "../store.js";
import { drawMapPicture } from "../game/mapPicture.js";
import { Button } from "./primitives/primitives.js";
import "./login.css";

/** OAuth failures come back as /?error=auth (server/src/auth/routes.ts). Read
 *  once, then removed from the address bar so a reload doesn't repeat it. */
function takeAuthError(): boolean {
  const params = new URLSearchParams(location.search);
  if (!params.has("error")) return false;
  params.delete("error");
  const rest = params.toString();
  history.replaceState(null, "", location.pathname + (rest ? `?${rest}` : "") + location.hash);
  return true;
}

/** The office, softly, behind the sign-in card. */
function MapBackdrop() {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let alive = true;
    void drawMapPicture(32)
      .then((c) => {
        if (alive && host.current) host.current.replaceChildren(c);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);
  return <div className="signin-map" ref={host} aria-hidden />;
}

export function Login() {
  const config = useStore((s) => s.config);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [authFailed] = useState(takeAuthError);
  const [error, setError] = useState("");

  async function signInAsDev(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setBusy(true);
    setError("");
    try {
      await devSignIn(name.trim());
      const me = await fetchMe();
      useStore.getState().set({ me });
    } catch (err) {
      setError((err as Error).message || "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  const shown = error || (authFailed ? "Sign-in didn't finish. Please try again." : "");

  return (
    <div className="signin">
      <MapBackdrop />
      <main className="signin-side">
        <div className="signin-card">
          <div className="wordmark signin-wordmark">
            <span className="wordmark-mark" aria-hidden />
            Lamports
          </div>
          <h1>
            Your team's office,
            <br />
            one walk away.
          </h1>
          <p className="signin-lede">Walk up to someone to talk. Walk away and the call ends. Like an office, without the commute.</p>
          <ul className="signin-facts">
            <li>
              <Check size={18} /> Voice opens when you're near someone
            </li>
            <li>
              <Check size={18} /> Video only when you choose to turn it on
            </li>
            <li>
              <ShieldCheck size={18} /> Nothing is ever recorded or stored
            </li>
          </ul>

          <div className="signin-stack">
            {config?.githubEnabled && (
              <a className="btn btn-primary btn-lg" href="/auth/github">
                Continue with GitHub
              </a>
            )}
          </div>

          {config && !config.githubEnabled && !config.devAuthEnabled && (
            <p className="signin-fine">
              GitHub sign-in isn't configured yet. Add <code>GITHUB_CLIENT_ID</code>/<code>GITHUB_CLIENT_SECRET</code> to{" "}
              <code>.env</code>; see the README.
            </p>
          )}

          {config?.devAuthEnabled && (
            <form className="signin-dev" onSubmit={signInAsDev}>
              <div className="signin-divider">
                <span>local testing</span>
              </div>
              <div className="signin-row">
                <input
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Pick any name"
                  aria-label="Name for local testing"
                  maxLength={32}
                  autoFocus
                />
                <Button type="submit" disabled={busy || !name.trim()}>
                  {busy ? "…" : "Enter"}
                </Button>
              </div>
              <p className="signin-fine">Open a second tab with another name to test two people.</p>
            </form>
          )}

          {shown && (
            <div className="signin-error" role="alert">
              <AlertCircle size={16} /> {shown}
            </div>
          )}
          <p className="signin-fine">Your browser will ask to use your microphone after you sign in.</p>
        </div>
      </main>
    </div>
  );
}

/** The server couldn't be reached at all: say so, and offer to try again. */
export function Unreachable({ onRetry }: { onRetry: () => void }) {
  const offline = typeof navigator !== "undefined" && navigator.onLine === false;
  return (
    <div className="signin">
      <MapBackdrop />
      <main className="signin-side">
        <div className="signin-card" role="alert">
          <div className="wordmark signin-wordmark">
            <span className="wordmark-mark" aria-hidden />
            Lamports
          </div>
          <h1>{offline ? "You're offline" : "Can't reach Lamports"}</h1>
          <p className="signin-lede">
            {offline ? "Check your internet connection, then try again." : "The office server isn't answering. It may be restarting; try again in a moment."}
          </p>
          <Button variant="primary" size="lg" onClick={onRetry}>
            Try again
          </Button>
        </div>
      </main>
    </div>
  );
}
