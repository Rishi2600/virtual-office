import { useEffect, useState, type KeyboardEvent } from "react";
import { Shuffle } from "lucide-react";
import { AVATAR_PARTS, encodeLook, parseLook, resolveLook, type AvatarLook } from "@vo/shared";
import { useStore } from "../../store.js";
import type { Session } from "../../net/session.js";
import { saveAvatar } from "../../net/api.js";
import { BOTTOMS, DIRS, EXTRAS, HAIR_COLORS, HAIR_STYLES, SKINS, TOPS, WALK_FRAMES, type Dir } from "../../game/avatarArt.js";
import { AvatarImage } from "./AvatarImage.js";
import { Button, Dialog } from "../primitives/primitives.js";
import { toast } from "../primitives/toasts.js";
import "./avatar.css";

type Part = keyof AvatarLook;

/** One row of choices, as a radio group (arrow keys move between options). */
function Choices({
  label,
  part,
  look,
  onPick,
  colors,
  names,
}: {
  label: string;
  part: Part;
  look: AvatarLook;
  onPick: (part: Part, v: number) => void;
  colors?: string[];
  names?: string[];
}) {
  const count = AVATAR_PARTS[part];
  const onKey = (e: KeyboardEvent) => {
    const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
    if (!step) return;
    e.preventDefault();
    const next = (look[part] + step + count) % count;
    onPick(part, next);
    (e.currentTarget.querySelectorAll<HTMLButtonElement>("[role=radio]")[next])?.focus();
  };
  return (
    <div className="choices">
      <div className="choices-label" id={`lbl-${part}`}>
        {label}
      </div>
      <div className="choices-row" role="radiogroup" aria-labelledby={`lbl-${part}`} onKeyDown={onKey}>
        {Array.from({ length: count }, (_, i) => {
          const on = look[part] === i;
          const name = names?.[i] ?? `${label} ${i + 1}`;
          return (
            <button
              key={i}
              type="button"
              role="radio"
              aria-checked={on}
              aria-label={name}
              tabIndex={on ? 0 : -1}
              className={colors ? `swatch ${on ? "on" : ""}` : `chip-btn ${on ? "on" : ""}`}
              style={colors ? { background: colors[i] } : undefined}
              onClick={() => onPick(part, i)}
            >
              {colors ? null : name}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** Turns on the spot while walking, so you see every side of your character. */
function WalkingPreview({ look }: { look: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const t = setInterval(() => setTick((n) => n + 1), 200);
    return () => clearInterval(t);
  }, []);
  const order: Dir[] = ["down", "right", "up", "left"];
  return <AvatarImage look={look} variant="full" size={156} dir={order[Math.floor(tick / 8) % 4]} frame={tick % WALK_FRAMES} />;
}

const random = (): AvatarLook => {
  const r = (n: number) => Math.floor(Math.random() * n);
  return {
    skin: r(AVATAR_PARTS.skin),
    hairStyle: r(AVATAR_PARTS.hairStyle),
    hairColor: r(AVATAR_PARTS.hairColor),
    top: r(AVATAR_PARTS.top),
    bottom: r(AVATAR_PARTS.bottom),
    extra: r(AVATAR_PARTS.extra),
  };
};

/**
 * Build your own character (owner decision). Opens by itself the first time
 * someone signs in; later from "Edit avatar". Saved to your profile, then
 * shown to everyone at once.
 */
export function AvatarBuilder({ session }: { session: Session | null }) {
  const open = useStore((s) => s.dialog === "avatar");
  const me = useStore((s) => s.me);
  const current = useStore((s) => (s.sessionId ? s.players[s.sessionId]?.avatar : undefined));
  const firstRun = !!me && me.avatar === "";
  const [draft, setDraft] = useState<AvatarLook | null>(null);
  const [saving, setSaving] = useState(false);

  // First sign-in: open the builder once you're in the office.
  const connected = useStore((s) => s.connection === "connected");
  useEffect(() => {
    if (firstRun && connected && !useStore.getState().dialog) useStore.getState().set({ dialog: "avatar" });
  }, [firstRun, connected]);

  const base = parseLook(current ?? (me ? resolveLook(me.avatar, me.id) : "")) ?? random();
  const look = draft ?? base;
  const encoded = encodeLook(look);
  const pick = (part: Part, v: number) => setDraft({ ...look, [part]: v });

  const close = () => {
    setDraft(null);
    useStore.getState().set({ dialog: null });
  };
  const save = async (value: string) => {
    setSaving(true);
    try {
      await saveAvatar(value);
      session?.setAvatar(value);
      const s = useStore.getState();
      if (s.me) s.set({ me: { ...s.me, avatar: value } });
      close();
    } catch {
      toast({ text: "Couldn't save your avatar. Please try again.", tone: "warn" });
    } finally {
      setSaving(false);
    }
  };
  // Closing the first-run builder keeps the look you were shown, so it
  // doesn't pop up again next time.
  const dismiss = () => (firstRun ? void save(encodeLook(base)) : close());

  return (
    <Dialog
      open={open}
      onClose={dismiss}
      title={firstRun ? "Make your avatar" : "Edit your avatar"}
      width={720}
      testId="avatar-builder"
      footer={
        <>
          <Button variant="ghost" onClick={() => setDraft(random())}>
            <Shuffle size={16} /> Surprise me
          </Button>
          <span style={{ flex: 1 }} />
          <Button onClick={dismiss} disabled={saving}>
            {firstRun ? "Keep this one" : "Cancel"}
          </Button>
          <Button variant="primary" onClick={() => void save(encoded)} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </>
      }
    >
      <div className="builder">
        <div className="builder-preview">
          {open && <WalkingPreview look={encoded} />}
          <div className="builder-dirs" aria-hidden>
            {DIRS.map((d) => (
              <AvatarImage key={d} look={encoded} variant="full" size={60} dir={d} />
            ))}
          </div>
          <div className="help">This is how everyone sees you on the map.</div>
        </div>
        <div className="builder-options">
          <Choices label="Skin" part="skin" look={look} onPick={pick} colors={SKINS} />
          <Choices label="Hair" part="hairStyle" look={look} onPick={pick} names={HAIR_STYLES} />
          <Choices label="Hair colour" part="hairColor" look={look} onPick={pick} colors={HAIR_COLORS} />
          <Choices label="Top" part="top" look={look} onPick={pick} colors={TOPS} />
          <Choices label="Trousers" part="bottom" look={look} onPick={pick} colors={BOTTOMS} />
          <Choices label="Extra" part="extra" look={look} onPick={pick} names={EXTRAS} />
        </div>
      </div>
    </Dialog>
  );
}
