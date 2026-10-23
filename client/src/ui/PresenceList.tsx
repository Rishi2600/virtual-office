import { useStore } from "../store.js";

export function PresenceList() {
  const players = useStore((s) => s.players);
  const peers = useStore((s) => s.peers);
  const list = Object.values(players).sort((a, b) => {
    if (a.isSelf !== b.isSelf) return a.isSelf ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <section className="presence">
      <div className="presence-head">
        In this space <span className="presence-count">{list.length}</span>
      </div>
      <ul>
        {list.map((p) => {
          const inCall = !!peers[p.sessionId];
          return (
            <li key={p.sessionId} className={p.connected ? "" : "offline"}>
              <span className={`dot ${p.status === "focus" ? "dot-focus" : "dot-available"}`} />
              <span className="presence-name">
                {p.name}
                {p.isSelf && <span className="presence-you"> (you)</span>}
              </span>
              <span className="presence-tags">
                {!p.connected && <em>reconnecting</em>}
                {p.connected && p.status === "focus" && <em>focus</em>}
                {p.lockGroup && <em className="tag-locked">private</em>}
                {p.sharing && <em>sharing</em>}
                {p.camOn && <em>video</em>}
                {!p.micOn && <em>muted</em>}
                {inCall && <em className="tag-live">in call</em>}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
