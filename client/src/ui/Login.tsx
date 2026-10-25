import "./login.css";
import { useState } from "react";
import { devSignIn, fetchMe } from "../net/api.js";
import { useStore } from "../store.js";

export function Login() {
  const config = useStore((s) => s.config);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
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

  return (
    <div className="login">
      <div className="login-card">
        <h1>Virtual Office</h1>
        <p className="login-sub">
          Walk up to someone and you'll be in a call. Walk away and it ends.
        </p>

        {config?.microsoftEnabled && (
          <a className="btn btn-microsoft" href="/auth/microsoft">
            Sign in with Microsoft
          </a>
        )}

        {config?.githubEnabled && (
          <a className="btn btn-github" href="/auth/github">
            Sign in with GitHub
          </a>
        )}

        {config && !config.microsoftEnabled && !config.githubEnabled && (
          <p className="login-note">
            No sign-in provider is configured yet. Add <code>MICROSOFT_CLIENT_ID</code>/
            <code>MICROSOFT_CLIENT_SECRET</code> or <code>GITHUB_CLIENT_ID</code>/
            <code>GITHUB_CLIENT_SECRET</code> to <code>.env</code> — see the README.
          </p>
        )}

        {config?.devAuthEnabled && (
          <form className="login-dev" onSubmit={signInAsDev}>
            <div className="login-divider">
              <span>local testing</span>
            </div>
            <p className="login-note">
              Pick any name. Open a second tab with a different name to test two people.
            </p>
            <div className="login-row">
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                maxLength={32}
                autoFocus
              />
              <button className="btn" disabled={busy || !name.trim()}>
                {busy ? "…" : "Enter"}
              </button>
            </div>
          </form>
        )}

        {error && <p className="login-error">{error}</p>}
      </div>
    </div>
  );
}
