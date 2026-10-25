import { useEffect, useRef } from "react";
import { Lock } from "lucide-react";
import officeMap from "@vo/shared/maps/office.json";
import { PROXIMITY_ENTER, type TiledMap } from "@vo/shared";
import { useStore } from "../../store.js";
import { positionBus } from "../../game/bus.js";
import { describe } from "../presence.js";
import { PresenceIcons } from "../people/PeoplePanel.js";
import "./map.css";

const LABELS = ((officeMap as TiledMap).layers.find((l) => l.name === "labels")?.objects ?? []).map((o) => ({
  name: o.name,
  x: o.x,
  y: o.y,
}));

/** World px from the feet to just above the head (avatars are 52px tall). */
const HEAD_PX = 56;

/**
 * Everything drawn in HTML over the map: room names, a name pill under each
 * person (with what they're doing), a soft ring under whoever is speaking,
 * and a "private conversation" note when you're standing next to a locked
 * huddle. HTML rather than canvas text so it stays crisp and readable at
 * every zoom. Positions come from the scene every frame via positionBus and
 * are written straight to the elements; React only re-renders when who's
 * here or what they're doing changes.
 */
export function MapOverlay() {
  const players = useStore((s) => s.players);
  const speaking = useStore((s) => s.speaking);
  const peers = useStore((s) => s.peers);

  const root = useRef<HTMLDivElement>(null);
  const marks = useRef(new Map<string, HTMLDivElement>());
  const labels = useRef<Array<HTMLDivElement | null>>([]);
  const hint = useRef<HTMLDivElement>(null);

  useEffect(
    () =>
      positionBus.on(({ people, view }) => {
        root.current?.style.setProperty("--z", String(view.zoom));
        for (const [id, el] of marks.current) {
          const p = people[id];
          if (!p?.visible) {
            el.style.visibility = "hidden";
            continue;
          }
          el.style.visibility = "";
          el.style.transform = `translate3d(${Math.round(p.x)}px, ${Math.round(p.y)}px, 0)`;
        }
        LABELS.forEach((l, i) => {
          const el = labels.current[i];
          if (el) el.style.transform = `translate3d(${Math.round((l.x - view.x) * view.zoom)}px, ${Math.round((l.y - view.y) * view.zoom)}px, 0)`;
        });
        placePrivateHint(hint.current, people, view.zoom);
      }),
    [],
  );

  const list = Object.values(players);
  return (
    <div className="map-overlay" ref={root} aria-hidden>
      {LABELS.map((l, i) => (
        <div
          key={l.name}
          className="room-label"
          ref={(el) => {
            labels.current[i] = el;
          }}
        >
          {l.name}
        </div>
      ))}
      {list.map((p) => {
        const presence = describe(p, { speaking: !!speaking[p.sessionId], inMyCall: !!peers[p.sessionId] });
        return (
          <div
            key={p.sessionId}
            className={`person-mark ${presence.kind === "offline" ? "away" : ""}`}
            data-testid="name-pill"
            ref={(el) => {
              if (el) marks.current.set(p.sessionId, el);
              else marks.current.delete(p.sessionId);
            }}
          >
            {presence.speaking && <span className="speak-ring" />}
            <span className={`name-pill ${p.isSelf ? "me" : ""}`}>
              <PresenceIcons presence={{ ...presence, speaking: false }} size={13} />
              <span className="name-pill-text">{p.name}</span>
            </span>
          </div>
        );
      })}
      <div className="private-hint" ref={hint} hidden>
        <Lock size={15} />
        Private conversation: they've locked their huddle
      </div>
    </div>
  );
}

/**
 * Shows the "private conversation" note over the nearest locked person you're
 * close enough to talk to but aren't connected with: otherwise walking up to
 * them and hearing nothing would look broken.
 */
function placePrivateHint(el: HTMLDivElement | null, people: Record<string, { x: number; y: number; wx: number; wy: number; visible: boolean }>, zoom: number) {
  if (!el) return;
  const s = useStore.getState();
  const me = s.sessionId ? people[s.sessionId] : undefined;
  const myGroup = s.sessionId ? s.players[s.sessionId]?.lockGroup : "";
  let best: { x: number; y: number; d: number } | null = null;
  if (me) {
    for (const p of Object.values(s.players)) {
      if (!p.lockGroup || p.lockGroup === myGroup || p.isSelf || s.peers[p.sessionId]) continue;
      const at = people[p.sessionId];
      if (!at?.visible) continue;
      const d = Math.hypot(at.wx - me.wx, at.wy - me.wy);
      if (d <= PROXIMITY_ENTER && (!best || d < best.d)) best = { x: at.x, y: at.y, d };
    }
  }
  el.hidden = !best;
  if (best) el.style.transform = `translate3d(${Math.round(best.x)}px, ${Math.round(best.y - HEAD_PX * zoom)}px, 0) translate(-50%, -100%)`;
}
