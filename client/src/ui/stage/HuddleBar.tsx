import { useCallback, useRef } from "react";
import { Lock, LockOpen, Maximize2, MicOff, MonitorUp } from "lucide-react";
import { useStore, type CallQuality, type CallStatus, type PeerView, type PlayerView } from "../../store.js";
import type { Session } from "../../net/session.js";
import { AvatarImage } from "../avatar/AvatarImage.js";
import { SpeakingBars } from "../people/PeoplePanel.js";
import { IconButton } from "../primitives/primitives.js";
import "./stage.css";

/** Attaches a stream to a <video> whenever the element mounts or the stream changes. */
function useStream(stream: MediaStream | null) {
  return useCallback(
    (el: HTMLVideoElement | null) => {
      if (el && el.srcObject !== stream) el.srcObject = stream;
    },
    [stream],
  );
}

const STATUS_TEXT: Record<Exclude<CallStatus, "connected">, string> = {
  connecting: "connecting…",
  reconnecting: "reconnecting…",
  failed: "can't connect",
};

function StatusOverlay({ status }: { status: CallStatus }) {
  if (status === "connected") return null;
  return (
    <div className="tile-overlay" role="status">
      <span>{STATUS_TEXT[status]}</span>
      {status === "failed" && <span className="tile-overlay-hint">network may be blocking calls · still trying</span>}
    </div>
  );
}

function QualityDot({ quality }: { quality: CallQuality }) {
  const parts = [
    `connection ${quality.level}`,
    quality.rttMs !== null ? `${quality.rttMs} ms` : null,
    quality.lossPct !== null ? `${quality.lossPct}% loss` : null,
    quality.relayed ? "via relay" : null,
  ].filter(Boolean);
  const text = parts.join(", ");
  return <span className="tile-quality" data-quality={quality.level} aria-label={text} title={text} />;
}

/** One person in the huddle bar. */
function Tile({
  player,
  peer,
  stream,
  mirrored,
  speaking,
  self,
  small,
}: {
  player: PlayerView;
  peer?: PeerView;
  stream: MediaStream | null;
  mirrored?: boolean;
  speaking: boolean;
  self?: boolean;
  small?: boolean;
}) {
  // A received video track outlives the sender turning their camera off, so
  // their camOn/sharing flags decide whether to show video.
  const showVideo = (player.camOn || player.sharing) && !!stream?.getVideoTracks().length;
  const video = useStream(showVideo ? stream : null);
  const status = peer?.callStatus ?? "connected";
  return (
    <div
      className={`tile ${speaking ? "speaking" : ""} ${small ? "small" : ""}`}
      data-testid={self ? "self-tile" : "tile"}
      data-peer={player.sessionId}
      data-status={status}
    >
      {showVideo ? (
        <video ref={video} autoPlay playsInline muted className={mirrored ? "mirrored" : ""} />
      ) : (
        <div className="tile-avatar">
          <AvatarImage look={player.avatar} size={small ? 56 : 76} variant="full" />
        </div>
      )}
      <StatusOverlay status={status} />
      {status === "connected" && peer?.quality && <QualityDot quality={peer.quality} />}
      <div className="tile-label">
        <span className="tile-name">
          {!player.micOn && <MicOff size={13} className="ic-danger" aria-label="muted" />}
          {speaking && player.micOn && <SpeakingBars />}
          {self ? "You" : player.name}
        </span>
      </div>
    </div>
  );
}

/** A screen someone in your huddle is sharing, big, with a full-screen button. */
function Spotlight({ player, stream }: { player: PlayerView; stream: MediaStream }) {
  const box = useRef<HTMLDivElement>(null);
  const video = useStream(stream);
  return (
    <div className="spotlight" ref={box} data-testid="spotlight">
      <div className="spotlight-bar">
        <MonitorUp size={16} />
        <b>{player.name}'s screen</b>
        <span className="spotlight-note">Only your huddle can see this</span>
        <IconButton label="Full screen" tipSide="left" onClick={() => void box.current?.requestFullscreen()}>
          <Maximize2 size={18} />
        </IconButton>
      </div>
      <video ref={video} autoPlay playsInline muted />
    </div>
  );
}

export function HuddleBar({ session }: { session: Session | null }) {
  const peers = useStore((s) => s.peers);
  const players = useStore((s) => s.players);
  const speaking = useStore((s) => s.speaking);
  const sessionId = useStore((s) => s.sessionId);
  const localStream = useStore((s) => s.localStream);
  const screenStream = useStore((s) => s.screenStream);
  const camOn = useStore((s) => s.camOn);

  const me = sessionId ? players[sessionId] : undefined;
  const others = Object.values(peers)
    .map((peer) => ({ peer, player: players[peer.peerId] }))
    .filter((x): x is { peer: PeerView; player: PlayerView } => !!x.player)
    .sort((a, b) => a.player.name.localeCompare(b.player.name));
  if (!me) return null;
  // Alone, the bar only appears as a preview of your own camera or screen.
  const alone = others.length === 0;
  if (alone && !camOn && !screenStream) return null;

  const locked = !!me.lockGroup;
  const sharer = others.find((o) => o.player.sharing && o.peer.stream?.getVideoTracks().length);
  const small = !!sharer;

  return (
    <>
      {sharer && <Spotlight player={sharer.player} stream={sharer.peer.stream!} />}
      <div className="huddle" aria-label={alone ? "Your preview" : `Your huddle, ${others.length + 1} people`} data-testid="huddle">
        {!alone && (
          <div className="huddle-chip">
            <b>Huddle · {others.length + 1}</b>
            {locked ? (
              <button type="button" className="huddle-lock on" onClick={() => session?.setLocked(false)}>
                <Lock size={13} /> Private · unlock
              </button>
            ) : (
              <button type="button" className="huddle-lock" onClick={() => session?.setLocked(true)}>
                <LockOpen size={13} /> Lock to make private
              </button>
            )}
          </div>
        )}
        <Tile
          player={{ ...me, camOn, sharing: !!screenStream }}
          stream={screenStream ?? (camOn ? localStream : null)}
          mirrored={!screenStream}
          speaking={!!speaking[me.sessionId]}
          self
          small={small}
        />
        {others.map(({ peer, player }) => (
          <Tile key={peer.peerId} player={player} peer={peer} stream={peer.stream} speaking={!!speaking[player.sessionId]} small={small} />
        ))}
      </div>
    </>
  );
}
