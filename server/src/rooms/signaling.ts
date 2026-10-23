import type { Client, Room } from "@colyseus/core";
import {
  S2C,
  type RtcFailureMessage,
  type SignalInMessage,
  type SignalOutMessage,
} from "@vo/shared";
import { rtcLog } from "../log.js";
import type { ProximityTracker } from "./proximity.js";

/**
 * WebRTC signaling relay — deliberately isolated from all game logic.
 *
 * NO MEDIA PASSES THROUGH HERE. This module forwards SDP offers/answers and ICE
 * candidates between two peers and nothing else; audio and video travel directly
 * peer-to-peer over the mesh. Nothing is recorded, buffered or persisted.
 *
 * This is the seam to replace if the mesh is ever outgrown: swapping to an SFU
 * means reimplementing this class and the client's PeerManager against the SFU's
 * signaling protocol. OfficeRoom's movement/proximity code does not change.
 */
export class SignalingRelay {
  constructor(
    private readonly room: Room,
    private readonly proximity: ProximityTracker,
  ) {}

  relay(from: Client, message: SignalOutMessage): void {
    const to = message?.to;
    if (typeof to !== "string" || !message?.payload) {
      rtcLog.warn({ from: from.sessionId }, "signal dropped: malformed message");
      return;
    }

    // Authorization: you may only signal someone the SERVER agrees you are
    // standing next to. Without this a client could open a peer connection to
    // anyone in the space, which would defeat proximity entirely.
    if (!this.proximity.isActive(from.sessionId, to)) {
      rtcLog.warn({ from: from.sessionId, to }, "signal dropped: peers are not in proximity");
      return;
    }

    const target = this.room.clients.getById(to);
    if (!target) {
      rtcLog.warn({ from: from.sessionId, to }, "signal dropped: target not connected");
      return;
    }

    const relayed: SignalInMessage = { from: from.sessionId, payload: message.payload };
    target.send(S2C.Signal, relayed);
  }

  /** Clients report ICE failures here so every failed call is visible in one
   *  server-side log rather than scattered across browser consoles. */
  reportFailure(from: Client, message: RtcFailureMessage): void {
    rtcLog.error(
      {
        from: from.sessionId,
        peerId: message?.peerId,
        state: message?.state,
        detail: message?.detail,
      },
      "webrtc connection failed (client-reported)",
    );
  }
}
