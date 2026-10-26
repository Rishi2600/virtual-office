import { DoorOpen, LogOut, MessageSquare, Palette, Search, Settings } from "lucide-react";
import { useStore, type ConnectionState } from "../../store.js";
import { logout } from "../../net/api.js";
import { AvatarImage } from "../avatar/AvatarImage.js";
import { IconButton, Kbd, MenuButton } from "../primitives/primitives.js";
import "./stage.css";

const CONN: Record<ConnectionState, { dot: string; text: string }> = {
  idle: { dot: "off", text: "Offline" },
  connecting: { dot: "warn", text: "Joining…" },
  connected: { dot: "ok", text: "Connected" },
  reconnecting: { dot: "warn", text: "Reconnecting…" },
  failed: { dot: "bad", text: "Disconnected" },
  replaced: { dot: "off", text: "Open elsewhere" },
};

export const isMac = /Mac|iPhone|iPad/.test(navigator.platform);

/** Wordmark, find-a-person, chat toggle, connection state and the "me" menu. */
export function TopBar({ onLeave }: { onLeave: () => void }) {
  const connection = useStore((s) => s.connection);
  const chatVisible = useStore((s) => s.chatVisible);
  const unread = useStore((s) => s.unread.nearby + s.unread.room);
  const myLook = useStore((s) => (s.sessionId ? s.players[s.sessionId]?.avatar : undefined));
  const name = useStore((s) => s.me?.name ?? "");
  const conn = CONN[connection];
  const open = (dialog: "settings" | "avatar" | "finder") => useStore.getState().set({ dialog });

  return (
    <header className="topbar">
      <div className="wordmark">
        <span className="wordmark-mark" aria-hidden />
        Lamports
      </div>
      <span className="office-title">The Office</span>
      <button type="button" className="finder-trigger" onClick={() => open("finder")} data-testid="finder-trigger">
        <Search size={15} />
        <span>Find a person…</span>
        <Kbd>{isMac ? "⌘ K" : "Ctrl K"}</Kbd>
      </button>
      <span style={{ position: "relative", display: "inline-flex" }}>
        <IconButton
          label={chatVisible ? "Hide chat" : unread ? `Show chat, ${unread} unread` : "Show chat"}
          tipSide="bottom"
          pressed={chatVisible}
          onClick={() => useStore.getState().set({ chatVisible: !chatVisible })}
          data-testid="chat-toggle"
        >
          <MessageSquare size={18} />
        </IconButton>
        {unread > 0 && !chatVisible && <span className="topbar-badge">{unread > 99 ? "99+" : unread}</span>}
      </span>
      <span className="conn" role="status" data-testid="connection">
        <span className={`dot ${conn.dot}`} />
        {conn.text}
      </span>
      <MenuButton
        label={`Account: ${name}`}
        align="right"
        trigger={myLook ? <AvatarImage look={myLook} size={30} /> : <span className="dot off" />}
        items={[
          { label: "Edit avatar", icon: <Palette size={16} />, onSelect: () => open("avatar") },
          { label: "Settings", icon: <Settings size={16} />, onSelect: () => open("settings") },
          { label: "Leave office", icon: <DoorOpen size={16} />, onSelect: onLeave },
          {
            label: "Sign out",
            icon: <LogOut size={16} />,
            tone: "danger",
            onSelect: () => void logout().finally(() => (location.href = "/")),
          },
        ]}
      />
    </header>
  );
}
