import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Eye, Footprints, Search } from "lucide-react";
import { useStore } from "../../store.js";
import { sceneBus } from "../../game/sceneBus.js";
import { AvatarImage } from "../avatar/AvatarImage.js";
import { describe } from "../presence.js";
import { Dialog, Kbd } from "../primitives/primitives.js";
import { PresenceIcons } from "./PeoplePanel.js";
import "./people.css";

/** Matches "bo" in "Bob", and "jd" in "Jane Doe" (initials). */
function matches(name: string, query: string): boolean {
  const n = name.toLowerCase();
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (n.includes(q)) return true;
  const initials = n
    .split(/\s+/)
    .map((w) => w[0])
    .join("");
  return initials.startsWith(q.replace(/\s+/g, ""));
}

/**
 * Ctrl K / ⌘ K: type a name, Enter walks you there, Shift+Enter just looks.
 * A combobox with a listbox, so screen readers announce the active person.
 */
export function FinderDialog() {
  const open = useStore((s) => s.dialog === "finder");
  const players = useStore((s) => s.players);
  const peers = useStore((s) => s.peers);
  const speaking = useStore((s) => s.speaking);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);

  // The dialog stays mounted while closed, so focus the field each time it opens.
  useEffect(() => {
    // Synchronously, so letters typed straight after Ctrl K land in the field.
    if (open) input.current?.focus();
  }, [open]);

  // Global shortcut, also from inside text fields (it has a modifier).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        const s = useStore.getState();
        s.set({ dialog: s.dialog === "finder" ? null : "finder" });
      }
    };
    // Capture phase: the chat box stops key events from bubbling (so typing
    // never moves you), and Ctrl K should still work from there.
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  const results = useMemo(
    () =>
      Object.values(players)
        .filter((p) => !p.isSelf && matches(p.name, query))
        .sort((a, b) => Number(b.connected) - Number(a.connected) || a.name.localeCompare(b.name)),
    [players, query],
  );
  const index = Math.min(active, Math.max(results.length - 1, 0));

  const close = () => {
    setQuery("");
    setActive(0);
    useStore.getState().set({ dialog: null });
  };
  const go = (sessionId: string, walk: boolean) => {
    sceneBus.send(walk ? { type: "walkTo", sessionId } : { type: "panTo", sessionId });
    close();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") setActive((index + 1) % Math.max(results.length, 1));
    else if (e.key === "ArrowUp") setActive((index - 1 + results.length) % Math.max(results.length, 1));
    else if (e.key === "Enter" && results[index]) go(results[index].sessionId, !e.shiftKey);
    else return;
    e.preventDefault();
  };

  return (
    <Dialog open={open} onClose={close} title="Find a person" width={520} testId="finder">
      <div className="finder-input">
        <Search size={16} />
        <input
          ref={input}
          role="combobox"
          aria-expanded
          aria-controls={listId}
          aria-activedescendant={results[index] ? `${listId}-${index}` : undefined}
          aria-label="Name"
          placeholder="Type a name…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
        />
      </div>
      <ul className="finder-list" role="listbox" id={listId} aria-label="People">
        {results.length === 0 && <li className="people-empty">{query ? `Nobody called "${query}" is here.` : "Nobody else is here yet."}</li>}
        {results.map((p, i) => {
          const presence = describe(p, { speaking: !!speaking[p.sessionId], inMyCall: !!peers[p.sessionId] });
          return (
            <li
              key={p.sessionId}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === index}
              className={`finder-row ${i === index ? "on" : ""}`}
              onMouseMove={() => setActive(i)}
              onClick={() => go(p.sessionId, true)}
            >
              <AvatarImage look={p.avatar} size={28} />
              <span className="finder-who">
                <b>{p.name}</b>
                <span>{presence.text}</span>
              </span>
              <PresenceIcons presence={presence} size={14} />
              {/* Mouse shortcut for "just look"; keyboards use Shift+Enter (an
                  option can't contain a button, so it's hidden from assistive tech). */}
              <span
                className="finder-look"
                aria-hidden
                title="Just look (Shift+Enter)"
                onClick={(e) => {
                  e.stopPropagation();
                  go(p.sessionId, false);
                }}
              >
                <Eye size={15} />
              </span>
              <Footprints size={15} className="finder-walk" aria-hidden />
            </li>
          );
        })}
      </ul>
      <div className="help">
        <Kbd>↑</Kbd> <Kbd>↓</Kbd> choose · <Kbd>Enter</Kbd> walk there · <Kbd>Shift Enter</Kbd> just look · <Kbd>Esc</Kbd> close
      </div>
    </Dialog>
  );
}
