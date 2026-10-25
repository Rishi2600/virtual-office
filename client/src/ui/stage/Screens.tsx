import { DoorOpen, MonitorSmartphone } from "lucide-react";
import { logout } from "../../net/api.js";
import { Button } from "../primitives/primitives.js";
import "./stage.css";

/** Phones are out of scope (owner decision): say so kindly, no way past it. */
export function PhoneBlock() {
  return (
    <div className="screen" data-testid="phone-block">
      <div className="screen-card">
        <MonitorSmartphone size={40} color="var(--accent)" />
        <h1>Lamports needs a bigger screen</h1>
        <p>Open it on a laptop, desktop or tablet. On a tablet, turning it sideways helps.</p>
      </div>
    </div>
  );
}

/** After "Leave office": you're out of the space, with a one-click way back. */
export function LeftScreen({ onRejoin }: { onRejoin: () => void }) {
  return (
    <div className="screen" data-testid="left-screen">
      <div className="screen-card">
        <DoorOpen size={40} color="var(--accent)" />
        <h1>You left the office</h1>
        <p>Nobody can see or hear you. Come back whenever you like.</p>
        <div className="screen-actions">
          <Button variant="primary" onClick={onRejoin}>
            Rejoin
          </Button>
          <Button variant="ghost" onClick={() => void logout().finally(() => (location.href = "/"))}>
            Sign out
          </Button>
        </div>
      </div>
    </div>
  );
}
