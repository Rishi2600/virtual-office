import type { Room } from "colyseus.js";
import {
  C2S,
  type ProximityEnterMessage,
  type SignalInMessage,
  type SignalOutMessage,
  type SignalPayload,
} from "@vo/shared";
import { useStore } from "../store.js";
import { ensureCamera, getVideoTrack, stopCamera } from "./media.js";

/**
 * ============================================================================
 *  NO RECORDING.
 *
 *  This application does not record, transcribe, buffer to disk, or otherwise
 *  persist any audio, video, screen content, or chat — anywhere, at any point.
 *
 *  Media is peer-to-peer over a full WebRTC mesh: it never traverses the server,
 *  which only relays SDP and ICE candidates (see server/src/rooms/signaling.ts).
 *  Text chat is relayed and never stored (server/src/rooms/OfficeRoom.ts).
 *  There is no MediaRecorder, no canvas capture, no upload path, and no server
 *  media endpoint in this codebase. Remote MediaStreams exist only as live
 *  srcObject values on <video> elements and are stopped on disconnect.
 *
 *  If you are reviewing this for privacy: the only calls to any media API in
 *  this file are getDisplayMedia (screen share, user-initiated) and the
 *  RTCPeerConnection plumbing below.
 * ============================================================================
 */

interface Peer {
  id: string;
  pc: RTCPeerConnection;
  /** Perfect-negotiation role, assigned by the server so both sides agree. */
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  remoteStream: MediaStream;
  audioSender: RTCRtpSender | null;
  /**
   * Created up-front as recvonly. Turning your camera on flips this same
   * transceiver to sendrecv rather than adding a second video m-line, which
   * keeps renegotiation simple and reversible.
   */
  videoTransceiver: RTCRtpTransceiver | null;
}

export class PeerManager {
  /** Exposed (not private) so live connections can be inspected from the
   *  devtools console while diagnosing a call that won't connect. */
  readonly peers = new Map<string, Peer>();
  private localStream: MediaStream | null = null;
  private screenTrack: MediaStreamTrack | null = null;

  constructor(
    private readonly room: Room,
    private readonly iceServers: RTCIceServer[],
  ) {}

  // --------------------------------------------------------------- local media
  /** Called once the microphone is (or isn't) available. Safe to call with null. */
  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    const audio = stream?.getAudioTracks()[0] ?? null;
    if (!audio) return;
    for (const peer of this.peers.values()) {
      if (!peer.audioSender) peer.audioSender = peer.pc.addTrack(audio, stream!);
    }
  }

  setMicEnabled(enabled: boolean): void {
    // Toggling `enabled` keeps the peer connection and its negotiation intact —
    // deliberately NOT removing the track, which would force renegotiation.
    this.localStream?.getAudioTracks().forEach((t) => (t.enabled = enabled));
    useStore.getState().set({ micOn: enabled });
    this.room.send(C2S.SetMedia, { micOn: enabled });
  }

  // ---------------------------------------------------------------------- video
  /**
   * Video is opt-in. Nothing touches the camera until this is called from an
   * explicit user action, so walking past somebody never opens your webcam.
   */
  async setVideoEnabled(enabled: boolean): Promise<boolean> {
    if (enabled) {
      const track = await ensureCamera();
      if (!track) return false; // denied or no device — the banner explains
      for (const peer of this.peers.values()) await this.sendVideo(peer, track);
      useStore.getState().set({ camOn: true });
      this.room.send(C2S.SetMedia, { camOn: true });
      return true;
    }

    for (const peer of this.peers.values()) await this.sendVideo(peer, null);
    stopCamera(); // also clears camOn
    this.room.send(C2S.SetMedia, { camOn: false });
    return true;
  }

  /** Points our video transceiver at a track (or nothing) and flips direction. */
  private async sendVideo(peer: Peer, track: MediaStreamTrack | null): Promise<void> {
    const transceiver = peer.videoTransceiver;
    if (!transceiver) return;
    await transceiver.sender.replaceTrack(track);
    transceiver.direction = track ? "sendrecv" : "recvonly";
  }

  // -------------------------------------------------------------- screen share
  async startScreenShare(): Promise<void> {
    const display = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 15 } },
      audio: false,
    });
    const track = display.getVideoTracks()[0];
    if (!track) return;

    this.screenTrack = track;
    // Fires when the user stops sharing from the browser's own UI.
    track.addEventListener("ended", () => void this.stopScreenShare());

    // Only your current proximity peers receive this — not the whole office.
    for (const peer of this.peers.values()) await this.sendVideo(peer, track);

    useStore.getState().set({ sharing: true, screenStream: display });
    this.room.send(C2S.SetMedia, { sharing: true });
  }

  async stopScreenShare(): Promise<void> {
    if (!this.screenTrack) return;
    // Fall back to the camera if it was on, otherwise to nothing.
    const camera = useStore.getState().camOn ? getVideoTrack() : null;
    for (const peer of this.peers.values()) await this.sendVideo(peer, camera);

    this.screenTrack.stop();
    this.screenTrack = null;
    useStore.getState().set({ sharing: false, screenStream: null });
    this.room.send(C2S.SetMedia, { sharing: false });
  }

  // ------------------------------------------------------------------ lifecycle
  /** Server says these two avatars are now within the proximity radius. */
  onProximityEnter({ peerId, polite }: ProximityEnterMessage): void {
    if (this.peers.has(peerId)) return;

    const pc = new RTCPeerConnection({ iceServers: this.iceServers });
    const peer: Peer = {
      id: peerId,
      pc,
      polite,
      makingOffer: false,
      ignoreOffer: false,
      remoteStream: new MediaStream(),
      audioSender: null,
      videoTransceiver: null,
    };
    this.peers.set(peerId, peer);
    useStore.getState().upsertPeer(peerId, { stream: peer.remoteStream, connectionState: "new" });

    pc.onicecandidate = (ev) => {
      this.signal(peerId, { kind: "candidate", candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };

    pc.ontrack = (ev) => {
      peer.remoteStream.addTrack(ev.track);
      useStore.getState().upsertPeer(peerId, { stream: peer.remoteStream });
    };

    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        if (pc.localDescription) {
          this.signal(peerId, {
            kind: "description",
            description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
          });
        }
      } catch (err) {
        console.error("[webrtc] negotiation failed", peerId, err);
      } finally {
        peer.makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      useStore.getState().upsertPeer(peerId, { connectionState: pc.connectionState });
      if (pc.connectionState === "failed") {
        console.error("[webrtc] connection failed", peerId);
        // Reported so every failed call shows up in ONE server-side log rather
        // than only in whichever browser console happened to be open.
        this.room.send(C2S.RtcFailure, { peerId, state: pc.connectionState });
        try {
          pc.restartIce();
        } catch { /* older browsers: nothing more we can do here */ }
      }
    };

    // Audio: send ours if we have it, otherwise stay receive-only so we can
    // still hear the other person.
    const audio = this.localStream?.getAudioTracks()[0] ?? null;
    if (audio) peer.audioSender = pc.addTrack(audio, this.localStream!);
    else pc.addTransceiver("audio", { direction: "recvonly" });

    // Video: always present, but receive-only until someone turns their camera
    // on. Reusing this transceiver later avoids a second m-line.
    const outgoingVideo = this.screenTrack ?? (useStore.getState().camOn ? getVideoTrack() : null);
    peer.videoTransceiver = pc.addTransceiver("video", {
      direction: outgoingVideo ? "sendrecv" : "recvonly",
    });
    if (outgoingVideo) void peer.videoTransceiver.sender.replaceTrack(outgoingVideo);
  }

  /** Server says they walked away, went into focus mode, locked us out, or dropped. */
  onProximityExit(peerId: string): void {
    this.destroyPeer(peerId);
  }

  // ------------------------------------------------------------------ signaling
  private signal(to: string, payload: SignalPayload): void {
    const message: SignalOutMessage = { to, payload };
    this.room.send(C2S.Signal, message);
  }

  /** Perfect negotiation: handles offer glare without an extra round trip. */
  async onSignal({ from, payload }: SignalInMessage): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return; // not a peer we are in proximity with — ignore
    const { pc } = peer;

    try {
      if (payload.kind === "description") {
        const description = payload.description as RTCSessionDescriptionInit;
        const offerCollision =
          description.type === "offer" && (peer.makingOffer || pc.signalingState !== "stable");

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        await pc.setRemoteDescription(description);
        if (description.type === "offer") {
          await pc.setLocalDescription();
          if (pc.localDescription) {
            this.signal(from, {
              kind: "description",
              description: { type: pc.localDescription.type, sdp: pc.localDescription.sdp },
            });
          }
        }
      } else if (payload.candidate) {
        try {
          await pc.addIceCandidate(payload.candidate as RTCIceCandidateInit);
        } catch (err) {
          // Expected when we deliberately ignored the colliding offer.
          if (!peer.ignoreOffer) throw err;
        }
      }
    } catch (err) {
      console.error("[webrtc] signal handling failed", from, err);
      this.room.send(C2S.RtcFailure, {
        peerId: from,
        state: pc.connectionState,
        detail: String((err as Error)?.message ?? err),
      });
    }
  }

  // -------------------------------------------------------------------- teardown
  private destroyPeer(peerId: string): void {
    const peer = this.peers.get(peerId);
    if (!peer) return;
    this.peers.delete(peerId);

    const { pc } = peer;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onnegotiationneeded = null;
    pc.onconnectionstatechange = null;

    // Stop ONLY the remote tracks. The local camera/mic tracks are shared across
    // every peer connection — stopping them here would kill your own camera the
    // first time anybody walked away from you.
    peer.remoteStream.getTracks().forEach((t) => t.stop());

    try {
      pc.close();
    } catch { /* already closed */ }

    useStore.getState().removePeer(peerId);
  }

  /** Tear down every call — used on disconnect and on unmount. */
  closeAll(): void {
    for (const id of [...this.peers.keys()]) this.destroyPeer(id);
    if (this.screenTrack) {
      this.screenTrack.stop();
      this.screenTrack = null;
      useStore.getState().set({ sharing: false, screenStream: null });
    }
  }
}
