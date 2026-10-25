import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { ArrowDown, SendHorizontal, ShieldCheck, Users, X } from "lucide-react";
import { CHAT_MAX_LENGTH, type ChatScope } from "@vo/shared";
import { useStore, type ChatLine } from "../../store.js";
import type { Session } from "../../net/session.js";
import { focusMap } from "../../game/sceneBus.js";
import { AvatarImage } from "../avatar/AvatarImage.js";
import { IconButton, Kbd, Tabs } from "../primitives/primitives.js";
import "./chat.css";

const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
/** Messages from the same person this close together are shown as one group. */
const GROUP_MS = 3 * 60 * 1000;

export function ChatPanel({ session, onClose }: { session: Session | null; onClose?: () => void }) {
  const chat = useStore((s) => s.chat);
  const tab = useStore((s) => s.chatTab);
  const unread = useStore((s) => s.unread);
  const players = useStore((s) => s.players);
  const sessionId = useStore((s) => s.sessionId);
  const inCall = useStore((s) => Object.keys(s.peers).length > 0);
  const [draft, setDraft] = useState("");
  const list = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);

  const lines = chat.filter((l) => l.scope === tab);
  const setTab = (scope: ChatScope) => useStore.getState().set({ chatTab: scope });

  // Reading the tab counts as reading it (also when the window regains focus).
  useEffect(() => {
    const read = () => document.visibilityState === "visible" && useStore.getState().markRead(tab);
    read();
    document.addEventListener("visibilitychange", read);
    return () => document.removeEventListener("visibilitychange", read);
  }, [tab, lines.length]);

  // Follow new messages only if you're already at the bottom; otherwise offer a jump.
  useLayoutEffect(() => {
    const el = list.current;
    if (el && atBottom) el.scrollTop = el.scrollHeight;
  }, [lines.length, tab, atBottom]);
  const onScroll = () => {
    const el = list.current;
    if (el) setAtBottom(el.scrollHeight - el.scrollTop - el.clientHeight < 40);
  };
  const jump = () => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
  };

  const nearbyEmpty = tab === "nearby" && !inCall;
  const send = (e: FormEvent) => {
    e.preventDefault();
    if (!draft.trim() || nearbyEmpty) return;
    session?.sendChat(tab, draft);
    setDraft("");
    setAtBottom(true);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    // Typing never moves your avatar: stop keys reaching the game.
    e.stopPropagation();
    if (e.key === "Escape") {
      e.preventDefault();
      focusMap();
    }
  };

  return (
    <section className="chat-panel" aria-label="Chat">
      <header className="chat-head">
        <Tabs
          label="Chat"
          value={tab}
          onChange={setTab}
          items={[
            { key: "nearby", label: "Nearby", badge: tab === "nearby" ? 0 : unread.nearby },
            { key: "room", label: "Everyone", badge: tab === "room" ? 0 : unread.room },
          ]}
        />
        {onClose && (
          <IconButton label="Close chat" tipSide="left" onClick={onClose}>
            <X size={18} />
          </IconButton>
        )}
      </header>

      <div className="chat-list" ref={list} onScroll={onScroll} aria-live="polite" data-testid="chat-list">
        {lines.length === 0 && (
          <p className="chat-empty">
            {tab === "nearby"
              ? "Messages here go only to the people you're standing with."
              : "Messages here go to everyone in the office."}
          </p>
        )}
        {lines.map((line, i) => (
          <Line key={line.id} line={line} prev={lines[i - 1]} mine={line.kind === "msg" && line.from === sessionId} look={line.kind === "msg" ? players[line.from]?.avatar : undefined} />
        ))}
        {!atBottom && (
          <button type="button" className="chat-jump" onClick={jump}>
            <ArrowDown size={14} /> New messages
          </button>
        )}
      </div>

      <form className="chat-compose" onSubmit={send}>
        <div className="chat-input">
          <input
            data-chat-input
            value={draft}
            maxLength={CHAT_MAX_LENGTH}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={nearbyEmpty ? "Walk up to someone to chat nearby" : tab === "nearby" ? "Message your huddle…" : "Message everyone…"}
            disabled={nearbyEmpty}
            aria-label={tab === "nearby" ? "Message the people near you" : "Message everyone"}
          />
          <IconButton label="Send" type="submit" disabled={!draft.trim() || nearbyEmpty} tipSide="left">
            <SendHorizontal size={18} />
          </IconButton>
        </div>
        <div className="chat-hint">
          <span>
            <Kbd>Enter</Kbd> send · <Kbd>Esc</Kbd> back to map
          </span>
          <span>
            <ShieldCheck size={13} /> Not saved anywhere
          </span>
        </div>
      </form>
    </section>
  );
}

function Line({ line, prev, mine, look }: { line: ChatLine; prev?: ChatLine; mine: boolean; look?: string }) {
  if (line.kind === "sys") {
    return (
      <div className="chat-sys">
        <Users size={13} /> {line.text} · {time(line.at)}
      </div>
    );
  }
  const continues = prev?.kind === "msg" && prev.from === line.from && line.at - prev.at < GROUP_MS;
  if (mine) {
    return (
      <div className={`chat-msg mine ${continues ? "cont" : ""}`}>
        {!continues && <div className="chat-meta">{time(line.at)}</div>}
        <div className="chat-bubble">{line.text}</div>
      </div>
    );
  }
  return (
    <div className={`chat-msg ${continues ? "cont" : ""}`}>
      <div className="chat-ava">{!continues && look && <AvatarImage look={look} size={28} />}</div>
      <div className="chat-body">
        {!continues && (
          <div className="chat-meta">
            <b>{line.name}</b> {time(line.at)}
          </div>
        )}
        <div className="chat-text">{line.text}</div>
      </div>
    </div>
  );
}
