import { useEffect, useRef, useState } from "react";
import type { ChatScope } from "@vo/shared";
import { useStore } from "../store.js";
import type { Session } from "../net/session.js";

const formatTime = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

export function Chat({ session }: { session: Session | null }) {
  const chat = useStore((s) => s.chat);
  const peerCount = useStore((s) => Object.keys(s.peers).length);
  const [scope, setScope] = useState<ChatScope>("nearby");
  const [draft, setDraft] = useState("");
  const listRef = useRef<HTMLDivElement>(null);

  const visible = chat.filter((m) => m.scope === scope);

  // Follow the conversation as it grows.
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [visible.length, scope]);

  function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    session?.sendChat(scope, draft);
    setDraft("");
  }

  const nearbyEmpty = scope === "nearby" && peerCount === 0;

  return (
    <section className="chat">
      <div className="chat-tabs">
        <button
          className={`chat-tab ${scope === "nearby" ? "active" : ""}`}
          onClick={() => setScope("nearby")}
        >
          Nearby
          {peerCount > 0 && <span className="chat-tab-count">{peerCount}</span>}
        </button>
        <button
          className={`chat-tab ${scope === "room" ? "active" : ""}`}
          onClick={() => setScope("room")}
        >
          Everyone
        </button>
      </div>

      <div className="chat-list" ref={listRef}>
        {visible.length === 0 && (
          <p className="chat-empty">
            {scope === "nearby"
              ? "Messages here go to the people you're standing with."
              : "Messages here go to everyone in the office."}
          </p>
        )}
        {visible.map((m) => (
          <div key={m.id} className="chat-msg">
            <span className="chat-author">{m.name}</span>
            <span className="chat-time">{formatTime(m.at)}</span>
            <div className="chat-text">{m.text}</div>
          </div>
        ))}
      </div>

      <form className="chat-input" onSubmit={send}>
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={500}
          placeholder={
            nearbyEmpty ? "Nobody nearby yet…" : scope === "nearby" ? "Message nearby" : "Message everyone"
          }
          disabled={nearbyEmpty}
          // Movement keys are captured by the game; stop them leaking through
          // while the user is typing.
          onKeyDown={(e) => e.stopPropagation()}
        />
        <button className="btn btn-small" disabled={!draft.trim() || nearbyEmpty}>
          Send
        </button>
      </form>

      <p className="chat-note">Chat isn't stored anywhere — it clears on reload.</p>
    </section>
  );
}
