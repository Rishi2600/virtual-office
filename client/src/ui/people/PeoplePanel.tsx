import { useMemo, useState } from "react";
import { Footprints, Lock, MicOff, MonitorUp, Moon, Search, Video, WifiOff } from "lucide-react";
import { useStore, type PlayerView } from "../../store.js";
import { sceneBus } from "../../game/sceneBus.js";
import { AvatarImage } from "../avatar/AvatarImage.js";
import { describe, type Presence } from "../presence.js";
import "./people.css";

type Filter = "all" | "huddle" | "available" | "focus";

/** Live "speaking" bars; static (and still labelled) under reduced motion. */
export function SpeakingBars() {
  return (
    <span className="speaking-bars" role="img" aria-label="speaking">
      <i />
      <i />
      <i />
    </span>
  );
}

/** Small icons for what someone's doing; shared by the panel and the map. */
export function PresenceIcons({ presence, size = 15 }: { presence: Presence; size?: number }) {
  return (
    <>
      {presence.speaking && <SpeakingBars />}
      {presence.muted && <MicOff size={size} className="ic-danger" aria-label="muted" />}
      {presence.video && <Video size={size} aria-label="video on" />}
      {presence.sharing && <MonitorUp size={size} aria-label="sharing screen" />}
      {presence.kind === "focus" && <Moon size={size} className="ic-warn" aria-label="focus mode" />}
      {presence.kind === "private" && <Lock size={size} className="ic-warn" aria-label="private conversation" />}
      {presence.kind === "offline" && <WifiOff size={size} aria-label="reconnecting" />}
    </>
  );
}

export function PeoplePanel({ collapsed }: { collapsed: boolean }) {
  const players = useStore((s) => s.players);
  const peers = useStore((s) => s.peers);
  const speaking = useStore((s) => s.speaking);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [selected, setSelected] = useState<string | null>(null);

  const rows = useMemo(() => {
    const all = Object.values(players).map((p) => ({
      p,
      presence: describe(p, { speaking: !!speaking[p.sessionId], inMyCall: !!peers[p.sessionId] }),
      inHuddle: p.isSelf ? Object.keys(peers).length > 0 : !!peers[p.sessionId],
    }));
    const q = query.trim().toLowerCase();
    return all
      .filter((r) => !q || r.p.name.toLowerCase().includes(q))
      .filter((r) =>
        filter === "huddle" ? r.inHuddle
          : filter === "available" ? r.presence.kind === "available" || r.presence.kind === "talking" || r.presence.kind === "in-call"
            : filter === "focus" ? r.presence.kind === "focus"
              : true,
      )
      .sort((a, b) =>
        Number(b.p.isSelf) - Number(a.p.isSelf) ||
        Number(a.p.connected === false) - Number(b.p.connected === false) ||
        a.p.name.localeCompare(b.p.name),
      );
  }, [players, peers, speaking, query, filter]);

  const huddle = rows.filter((r) => r.inHuddle);
  const others = rows.filter((r) => !r.inHuddle);
  const total = Object.keys(players).length;

  const show = (p: PlayerView) => {
    setSelected(p.sessionId);
    sceneBus.send({ type: p.isSelf ? "recenter" : "panTo", sessionId: p.sessionId });
  };

  if (collapsed) {
    return (
      <aside className="people collapsed" aria-label="People">
        {rows.map(({ p, presence }) => (
          <button key={p.sessionId} type="button" className="people-face" onClick={() => show(p)} aria-label={`${p.name}: ${presence.text}`} title={`${p.name} · ${presence.text}`}>
            <AvatarImage look={p.avatar} size={36} dim={!p.connected} />
            <span className={`status-dot ${presence.dot}`} />
          </button>
        ))}
      </aside>
    );
  }

  return (
    <aside className="people" aria-label="People">
      <div className="people-head">
        <h2>People · {total}</h2>
      </div>
      <label className="people-search">
        <Search size={15} />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.stopPropagation()}
          placeholder="Search people"
          aria-label="Search people"
        />
      </label>
      <div className="people-filters" role="group" aria-label="Filter people">
        {(
          [
            ["all", `All ${total}`],
            ["huddle", "Your huddle"],
            ["available", "Available"],
            ["focus", "Focus"],
          ] as Array<[Filter, string]>
        ).map(([key, label]) => (
          <button key={key} type="button" className={`chip ${filter === key ? "on" : ""}`} aria-pressed={filter === key} onClick={() => setFilter(key)}>
            {label}
          </button>
        ))}
      </div>
      <div className="people-list">
        {huddle.length > 0 && <div className="people-group">Your huddle</div>}
        {huddle.map((r) => (
          <PersonRow key={r.p.sessionId} {...r} selected={selected === r.p.sessionId} onShow={show} />
        ))}
        {huddle.length > 0 && others.length > 0 && <div className="people-group">In the office</div>}
        {others.map((r) => (
          <PersonRow key={r.p.sessionId} {...r} selected={selected === r.p.sessionId} onShow={show} />
        ))}
        {rows.length === 0 && <p className="people-empty">Nobody matches “{query}”.</p>}
      </div>
    </aside>
  );
}

function PersonRow({
  p,
  presence,
  selected,
  onShow,
}: {
  p: PlayerView;
  presence: Presence;
  selected: boolean;
  onShow: (p: PlayerView) => void;
}) {
  return (
    <div className={`person ${selected ? "sel" : ""} ${p.connected ? "" : "away"}`} data-testid="person-row">
      <button type="button" className="person-main" onClick={() => onShow(p)} aria-label={`Show ${p.name} on the map. ${presence.text}`}>
        <span className="person-ava">
          <AvatarImage look={p.avatar} size={32} dim={!p.connected} />
          <span className={`status-dot ${presence.dot}`} />
        </span>
        <span className="person-who">
          <span className="person-name">
            {p.name}
            {p.isSelf && <span className="person-you"> (you)</span>}
          </span>
          <span className="person-sub">{presence.text}</span>
        </span>
        <span className="person-tags">
          <PresenceIcons presence={presence} />
        </span>
      </button>
      {!p.isSelf && p.connected && (
        <button
          type="button"
          className="person-walk"
          onClick={() => sceneBus.send({ type: "walkTo", sessionId: p.sessionId })}
          aria-label={`Walk to ${p.name}`}
          title={`Walk to ${p.name}`}
        >
          <Footprints size={15} />
        </button>
      )}
    </div>
  );
}
