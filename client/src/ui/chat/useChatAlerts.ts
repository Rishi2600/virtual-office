import { useEffect } from "react";
import { useStore } from "../../store.js";
import { usePrefs } from "../../prefs.js";
import { chime } from "../sounds.js";
import { isTyping } from "../stage/Dock.js";

const TITLE = "Lamports";

/**
 * Everything that tells you about chat while you're looking elsewhere:
 * - the unread count in the tab title, "(3) Lamports";
 * - a chime (only if Sounds is on) for messages and for someone joining you;
 * - a desktop notification (only if turned on in Settings) while the tab is in
 *   the background. It says who wrote and where, but not what: the message
 *   itself would otherwise sit in the system's notification history, and chat
 *   is never kept anywhere.
 * Also: Enter on the map jumps to the chat box (opening the drawer if needed;
 * on the Everyone tab when nobody's near you).
 */
export function useChatAlerts(): void {
  const unread = useStore((s) => s.unread.nearby + s.unread.room);

  useEffect(() => {
    document.title = unread ? `(${unread > 99 ? "99+" : unread}) ${TITLE}` : TITLE;
  }, [unread]);
  useEffect(() => () => void (document.title = TITLE), []);

  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        if (s.chat === prev.chat || s.chat.length === 0) return;
        const line = s.chat[s.chat.length - 1]!;
        if (line === prev.chat[prev.chat.length - 1]) return;

        if (line.kind === "sys") {
          if (line.text.endsWith("joined your huddle")) chime("join");
          return;
        }
        if (line.from === s.sessionId) return;
        const looking = document.visibilityState === "visible" && s.chatVisible && s.chatTab === line.scope;
        if (!looking) chime("message");

        const prefs = usePrefs.getState();
        if (document.visibilityState === "hidden" && prefs.notifications && typeof Notification !== "undefined" && Notification.permission === "granted") {
          const where = line.scope === "nearby" ? "your huddle" : "Everyone";
          const n = new Notification(`${line.name} sent a message`, { body: `In ${where} · Lamports`, tag: "lamports-chat" });
          n.onclick = () => {
            window.focus();
            useStore.getState().set({ chatVisible: true, chatTab: line.scope });
            n.close();
          };
        }
      }),
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Enter" || e.repeat || e.ctrlKey || e.metaKey || e.altKey || isTyping(e)) return;
      const s = useStore.getState();
      if (s.dialog) return;
      // Buttons and links use Enter themselves.
      const t = e.target as HTMLElement | null;
      if (t?.closest("button, a, [role=option], [role=menuitem], [role=tab]")) return;
      e.preventDefault();
      if (!s.chatVisible) s.set({ chatVisible: true });
      // Alone, the Nearby box is disabled: go to Everyone instead.
      if (s.chatTab === "nearby" && Object.keys(s.peers).length === 0) s.set({ chatTab: "room" });
      requestAnimationFrame(() => document.querySelector<HTMLInputElement>("[data-chat-input]")?.focus());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
