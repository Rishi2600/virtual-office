import {
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { X } from "lucide-react";
import "./primitives.css";

// ------------------------------------------------------------------- Button
type Variant = "default" | "primary" | "ghost" | "danger";

export function Button({
  variant = "default",
  size = "md",
  className = "",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: "sm" | "md" | "lg" }) {
  return <button type="button" className={`btn btn-${variant} btn-${size} ${className}`} {...rest} />;
}

// -------------------------------------------------------------------- Kbd
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

// ------------------------------------------------------------- IconButton
/**
 * An icon-only button that is never unlabelled: `label` is its accessible
 * name and also shown as a tooltip (with the keyboard shortcut, if any) on
 * hover and keyboard focus.
 */
export function IconButton({
  label,
  shortcut,
  tone,
  pressed,
  tipSide = "top",
  className = "",
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  label: string;
  shortcut?: string;
  tone?: "on" | "off" | "warn" | "active";
  /** For toggles: exposed as aria-pressed. */
  pressed?: boolean;
  tipSide?: "top" | "bottom" | "left";
}) {
  const tipId = useId();
  return (
    <span className={`tip-host tip-${tipSide}`}>
      <button
        type="button"
        aria-label={label}
        aria-describedby={shortcut ? tipId : undefined}
        aria-pressed={pressed}
        className={`icon-btn ${tone ? `tone-${tone}` : ""} ${className}`}
        {...rest}
      >
        {children}
      </button>
      <span role="tooltip" id={tipId} className="tooltip">
        {label}
        {shortcut && <Kbd>{shortcut}</Kbd>}
      </span>
    </span>
  );
}

// -------------------------------------------------------------------- Tabs
export interface TabItem<K extends string> {
  key: K;
  label: string;
  badge?: number;
}

/** WAI-ARIA tabs: arrow keys move between tabs, the selected one is focusable. */
export function Tabs<K extends string>({
  items,
  value,
  onChange,
  label,
}: {
  items: TabItem<K>[];
  value: K;
  onChange: (key: K) => void;
  label: string;
}) {
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const i = items.findIndex((t) => t.key === value);
    const next = items[(i + (e.key === "ArrowRight" ? 1 : items.length - 1)) % items.length]!;
    onChange(next.key);
    (e.currentTarget.querySelector(`[data-key="${next.key}"]`) as HTMLElement | null)?.focus();
  };
  return (
    <div role="tablist" aria-label={label} className="tabs" onKeyDown={onKey}>
      {items.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          data-key={t.key}
          aria-selected={t.key === value}
          tabIndex={t.key === value ? 0 : -1}
          className={`tab ${t.key === value ? "on" : ""}`}
          onClick={() => onChange(t.key)}
        >
          {t.label}
          {!!t.badge && (
            <span className="tab-badge" aria-label={`${t.badge} unread`}>
              {t.badge > 99 ? "99+" : t.badge}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Switch
export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <div>
        <div id={id} className="switch-label">{label}</div>
        {description && <div className="help">{description}</div>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={id}
        disabled={disabled}
        className={`switch ${checked ? "on" : ""}`}
        onClick={() => onChange(!checked)}
      />
    </div>
  );
}

// ------------------------------------------------------------------ Dialog
/**
 * Modal dialog on the native <dialog> element, which gives focus trapping,
 * Esc to close and focus return to the opener for free.
 */
export function Dialog({
  open,
  onClose,
  title,
  children,
  footer,
  width = 640,
  testId,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
  testId?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      // Start on the dialog itself (announced by its title) rather than on the
      // first button, which is the close button and would pop its tooltip.
      // Dialogs that want a field focused do that themselves.
      d.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);
  const titleId = useId();
  return (
    <dialog
      ref={ref}
      className="dialog"
      tabIndex={-1}
      style={{ width }}
      aria-labelledby={titleId}
      data-testid={testId}
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose(); // click on the backdrop
      }}
    >
      {open && (
        <div className="dialog-inner">
          <header className="dialog-head">
            <h2 id={titleId}>{title}</h2>
            <IconButton label="Close" tipSide="left" onClick={onClose}>
              <X size={18} />
            </IconButton>
          </header>
          <div className="dialog-body">{children}</div>
          {footer && <footer className="dialog-foot">{footer}</footer>}
        </div>
      )}
    </dialog>
  );
}

// -------------------------------------------------------------------- Menu
export interface MenuItem {
  label: string;
  icon?: ReactNode;
  onSelect: () => void;
  tone?: "danger";
}

/**
 * A button that opens a small menu (WAI-ARIA menu button): arrow keys move,
 * Enter selects, Esc or a click outside closes and returns focus.
 */
export function MenuButton({
  label,
  trigger,
  items,
  align = "right",
  placement = "down",
  className = "",
}: {
  label: string;
  trigger: ReactNode;
  items: MenuItem[];
  align?: "left" | "right";
  placement?: "down" | "up";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const first = wrap.current?.querySelector<HTMLElement>("[role=menuitem]");
    first?.focus();
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const close = () => {
    setOpen(false);
    button.current?.focus();
  };
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const items = [...(wrap.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === "Escape") close();
    else if (e.key === "ArrowDown") items[(i + 1) % items.length]?.focus();
    else if (e.key === "ArrowUp") items[(i - 1 + items.length) % items.length]?.focus();
    else return;
    e.preventDefault();
  };

  return (
    <div className="menu-wrap" ref={wrap} onKeyDown={onKey}>
      <button
        ref={button}
        type="button"
        className={`menu-trigger ${className}`}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((o) => !o)}
      >
        {trigger}
      </button>
      {open && (
        <div id={menuId} role="menu" aria-label={label} className={`menu align-${align} place-${placement}`}>
          {items.map((it) => (
            <button
              key={it.label}
              type="button"
              role="menuitem"
              className={`menu-item ${it.tone === "danger" ? "danger" : ""}`}
              onClick={() => {
                setOpen(false);
                it.onSelect();
              }}
            >
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Select
export function Select({
  label,
  value,
  options,
  onChange,
  help,
}: {
  label: string;
  value: string;
  options: Array<{ value: string; label: string }>;
  onChange: (v: string) => void;
  help?: string;
}) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {help && <div className="help">{help}</div>}
    </div>
  );
}
