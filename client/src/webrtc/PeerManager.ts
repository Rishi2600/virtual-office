import type { Room } from "colyseus.js";
import {
  C2S,
  type ProximityEnterMessage,
  type SignalInMessage,
  type SignalOutMessage,
  type SignalPayload,
} from "@vo/shared";
import { useStore, type CallStatus } from "../store.js";
import { ensureCamera, getVideoTrack, stopCamera } from "./media.js";
import { summarize, type QualitySample } from "./callQuality.js";

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
  /** True while an answer is being applied: an offer arriving then is not a collision. */
  isSettingRemoteAnswerPending: boolean;
  /** Incoming signals, applied strictly in arrival order (see onSignal). */
  signalQueue: Promise<void>;
  remoteStream: MediaStream;
  /**
   * Exactly one audio and one video transceiver per call, so two m-lines. The
   * impolite peer creates them and makes the first offer; the polite peer
   * adopts the ones that offer creates (adoptTransceivers). The two sides never
   * both add media at once, so call setup can't glare.
   *
   * Both start receive-only. Turning your mic or camera on points the existing
   * sender at a track and flips it to sendrecv rather than adding m-lines.
   */
  audioTransceiver: RTCRtpTransceiver | null;
  videoTransceiver: RTCRtpTransceiver | null;

  // ---- recovery (see onConnectionState)
  /** Pending check after a "disconnected" (which often heals on its own). */
  graceTimer: ReturnType<typeof setTimeout> | null;
  /** Next scheduled ICE restart while recovering. */
  restartTimer: ReturnType<typeof setTimeout> | null;
  recovering: boolean;
  /** ICE restarts in the current recovery; reset once connected again. */
  restarts: number;
  /** The server has been told about this failure (once per episode). */
  failureReported: boolean;
  /** Previous getStats() counters, for packet loss since the last sample. */
  qualitySample: QualitySample | null;
}

/** A "disconnected" connection often recovers by itself within a few seconds. */
const DISCONNECTED_GRACE_MS = 4_000;
/** Pause before each ICE restart: quick at first, then every 30s for as long
 *  as the two people are still near each other. */
const RESTART_DELAYS_MS = [0, 2_000, 4_000, 8_000, 15_000, 30_000];
/** After this many restarts the tile says "can't connect" (it keeps trying). */
const RESTARTS_BEFORE_FAILED = 3;
const STATS_INTERVAL_MS = 2_000;

export class PeerManager {
  /** Exposed (not private) so live connections can be inspected from the
   *  devtools console while diagnosing a call that won't connect. */
  readonly peers = new Map<string, Peer>();
  private localStream: MediaStream | null = null;
  private screenTrack: MediaStreamTrack | null = null;
  private readonly statsTimer: ReturnType<typeof setInterval>;

  constructor(
    private readonly room: Room,
    private iceServers: RTCIceServer[],
  ) {
    this.statsTimer = setInterval(() => void this.sampleQuality(), STATS_INTERVAL_MS);
  }

  // --------------------------------------------------------------- local media
  /** Called once the microphone is (or isn't) available. Safe to call with null. */
  setLocalStream(stream: MediaStream | null): void {
    this.localStream = stream;
    this.applyLocalMediaToAll();
  }

  private applyLocalMediaToAll(): void {
    for (const peer of this.peers.values()) this.applyLocalMedia(peer);
  }

  /** Points a peer's transceivers at whatever we're currently sending. A peer
   *  whose transceivers don't exist yet picks this up when it adopts them. */
  private applyLocalMedia(peer: Peer): void {
    const audio = this.localStream?.getAudioTracks()[0] ?? null;
    const audioT = peer.audioTransceiver;
    if (audio && audioT && audioT.sender.track !== audio) {
      void audioT.sender.replaceTrack(audio);
      audioT.direction = "sendrecv";
    }

    const videoT = peer.videoTransceiver;
    if (videoT) {
      const video = this.outgoingVideo();
      if (videoT.sender.track !== video) void videoT.sender.replaceTrack(video);
      const direction = video ? "sendrecv" : "recvonly";
      if (videoT.direction !== direction) videoT.direction = direction;
    }
  }

  /** Polite side: take over the transceivers the impolite peer's first offer created. */
  private adoptTransceivers(peer: Peer): void {
    const transceivers = peer.pc.getTransceivers();
    peer.audioTransceiver = transceivers.find((t) => t.receiver.track.kind === "audio") ?? null;
    peer.videoTransceiver = transceivers.find((t) => t.receiver.track.kind === "video") ?? null;
    this.applyLocalMedia(peer);
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
      useStore.getState().set({ camOn: true });
      this.applyLocalMediaToAll();
      this.room.send(C2S.SetMedia, { camOn: true });
      return true;
    }

    // Repoint the senders first (to the screen if sharing, else nothing), then
    // release the device.
    useStore.getState().set({ camOn: false });
    this.applyLocalMediaToAll();
    stopCamera();
    this.room.send(C2S.SetMedia, { camOn: false });
    return true;
  }

  /**
   * The one rule for what peers see: your screen while you share, otherwise
   * your camera if it's on, otherwise nothing. Every toggle goes through this,
   * so turning the camera on or off mid-share never replaces or kills the share.
   */
  private outgoingVideo(): MediaStreamTrack | null {
    return this.screenTrack ?? (useStore.getState().camOn ? getVideoTrack() : null);
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
    this.applyLocalMediaToAll();

    useStore.getState().set({ sharing: true, screenStream: display });
    this.room.send(C2S.SetMedia, { sharing: true });
  }

  async stopScreenShare(): Promise<void> {
    const screen = this.screenTrack;
    if (!screen) return;
    // Falls back to the camera if it's on, otherwise to nothing.
    this.screenTrack = null;
    this.applyLocalMediaToAll();

    screen.stop();
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
      isSettingRemoteAnswerPending: false,
      signalQueue: Promise.resolve(),
      remoteStream: new MediaStream(),
      audioTransceiver: null,
      videoTransceiver: null,
      graceTimer: null,
      restartTimer: null,
      recovering: false,
      restarts: 0,
      failureReported: false,
      qualitySample: null,
    };
    this.peers.set(peerId, peer);
    useStore.getState().upsertPeer(peerId, { stream: peer.remoteStream, connectionState: "new" });

    pc.onicecandidate = (ev) => {
      this.signal(peerId, { kind: "candidate", candidate: ev.candidate ? ev.candidate.toJSON() : null });
    };

    pc.ontrack = (ev) => {
      peer.remoteStream.addTrack(ev.track);
      useStore.getState().upsertPeer(peerId, {
        stream: peer.remoteStream,
        // A fresh stream that already holds the track: see PeerView.audio.
        ...(ev.track.kind === "audio" ? { audio: new MediaStream([ev.track]) } : {}),
      });
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

    pc.onconnectionstatechange = () => this.onConnectionState(peer);

    // Only the impolite peer creates media here, which fires negotiationneeded
    // and makes it the first offerer. The polite peer adds nothing until that
    // offer arrives. Without a mic we stay receive-only and can still hear.
    if (!polite) {
      peer.audioTransceiver = pc.addTransceiver("audio", { direction: "recvonly" });
      peer.videoTransceiver = pc.addTransceiver("video", { direction: "recvonly" });
      this.applyLocalMedia(peer);
    }
  }

  /** Fresh ICE servers (TURN credentials expire): used for new calls, and given
   *  to live ones so a later ICE restart doesn't use expired credentials. */
  setIceServers(iceServers: RTCIceServer[]): void {
    this.iceServers = iceServers;
    for (const peer of this.peers.values()) {
      try {
        peer.pc.setConfiguration({ ...peer.pc.getConfiguration(), iceServers });
      } catch { /* closed */ }
    }
  }

  // ------------------------------------------------------------------ recovery
  /**
   * Keeps a call alive through network trouble, and tells the user what's
   * happening instead of failing silently:
   *  - connected: all good, recovery state reset.
   *  - disconnected: often heals by itself, so wait a moment before acting.
   *  - failed: ICE restarts with back-off (RESTART_DELAYS_MS) for as long as
   *    the two are still near each other; the server's proximity exit ends it.
   */
  private onConnectionState(peer: Peer): void {
    const state = peer.pc.connectionState;
    useStore.getState().upsertPeer(peer.id, { connectionState: state });

    if (state === "connected") {
      this.clearRecoveryTimers(peer);
      peer.recovering = false;
      peer.restarts = 0;
      peer.failureReported = false;
      this.setCallStatus(peer, "connected");
    } else if (state === "disconnected") {
      peer.graceTimer ??= setTimeout(() => {
        peer.graceTimer = null;
        if (peer.pc.connectionState !== "connected") this.recover(peer);
      }, DISCONNECTED_GRACE_MS);
    } else if (state === "failed") {
      if (peer.graceTimer) clearTimeout(peer.graceTimer);
      peer.graceTimer = null;
      this.recover(peer);
    }
  }

  private recover(peer: Peer): void {
    if (peer.recovering || this.peers.get(peer.id) !== peer) return;
    peer.recovering = true;
    this.setCallStatus(peer, "reconnecting");
    this.scheduleRestart(peer);
  }

  private scheduleRestart(peer: Peer): void {
    const delay = RESTART_DELAYS_MS[Math.min(peer.restarts, RESTART_DELAYS_MS.length - 1)]!;
    peer.restartTimer = setTimeout(() => {
      peer.restartTimer = null;
      if (this.peers.get(peer.id) !== peer || !peer.recovering) return; // gone, or recovered
      peer.restarts++;
      if (peer.restarts > RESTARTS_BEFORE_FAILED) this.markFailed(peer);
      try {
        // New ICE credentials and candidates, renegotiated through the usual
        // perfect-negotiation path.
        peer.pc.restartIce();
      } catch { /* closed meanwhile */ }
      this.scheduleRestart(peer);
    }, delay);
  }

  private markFailed(peer: Peer): void {
    this.setCallStatus(peer, "failed");
    if (peer.failureReported) return;
    peer.failureReported = true;
    console.warn("[webrtc] call still not connected after ICE restarts", peer.id, peer.restarts);
    // Once per failure episode, so every failed call shows up in ONE
    // server-side log rather than only in whichever console happened to be open.
    this.room.send(C2S.RtcFailure, {
      peerId: peer.id,
      state: peer.pc.connectionState,
      detail: `not connected after ${peer.restarts - 1} ICE restarts`,
    });
  }

  private clearRecoveryTimers(peer: Peer): void {
    if (peer.graceTimer) clearTimeout(peer.graceTimer);
    if (peer.restartTimer) clearTimeout(peer.restartTimer);
    peer.graceTimer = null;
    peer.restartTimer = null;
  }

  private setCallStatus(peer: Peer, callStatus: CallStatus): void {
    if (useStore.getState().peers[peer.id]?.callStatus !== callStatus) {
      useStore.getState().upsertPeer(peer.id, { callStatus });
    }
  }

  // ------------------------------------------------------------------- quality
  /** Samples every connected call's stats into a good/fair/poor quality. */
  private async sampleQuality(): Promise<void> {
    for (const peer of this.peers.values()) {
      if (peer.pc.connectionState !== "connected") continue;
      try {
        const { quality, sample } = summarize(await peer.pc.getStats(), peer.qualitySample);
        peer.qualitySample = sample;
        const current = useStore.getState().peers[peer.id]?.quality;
        if (JSON.stringify(current) !== JSON.stringify(quality)) {
          useStore.getState().upsertPeer(peer.id, { quality });
        }
      } catch { /* closed between the check and getStats() */ }
    }
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

  /**
   * Signals are applied one at a time, in arrival order. Handled concurrently,
   * an offer could be judged against a signaling state that an earlier answer
   * was still in the middle of changing — and wrongly ignored, which left the
   * polite peer stuck in have-local-offer for the rest of the call.
   */
  onSignal({ from, payload }: SignalInMessage): Promise<void> {
    const peer = this.peers.get(from);
    if (!peer) return Promise.resolve(); // not a peer we are in proximity with — ignore
    peer.signalQueue = peer.signalQueue.then(() => this.handleSignal(peer, payload));
    return peer.signalQueue;
  }

  /** Perfect negotiation (W3C pattern): handles offer glare without an extra round trip. Never throws. */
  private async handleSignal(peer: Peer, payload: SignalPayload): Promise<void> {
    const { pc, id: from } = peer;
    if (pc.signalingState === "closed") return; // peer torn down while this was queued

    try {
      if (payload.kind === "description") {
        const description = payload.description as RTCSessionDescriptionInit;
        const readyForOffer =
          !peer.makingOffer && (pc.signalingState === "stable" || peer.isSettingRemoteAnswerPending);
        const offerCollision = description.type === "offer" && !readyForOffer;

        peer.ignoreOffer = !peer.polite && offerCollision;
        if (peer.ignoreOffer) return;

        peer.isSettingRemoteAnswerPending = description.type === "answer";
        try {
          await pc.setRemoteDescription(description);
        } finally {
          peer.isSettingRemoteAnswerPending = false;
        }
        if (description.type === "offer") {
          // The first offer is what creates the polite side's transceivers.
          if (!peer.audioTransceiver) this.adoptTransceivers(peer);
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

    this.clearRecoveryTimers(peer);
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
    clearInterval(this.statsTimer);
    for (const id of [...this.peers.keys()]) this.destroyPeer(id);
    if (this.screenTrack) {
      this.screenTrack.stop();
      this.screenTrack = null;
      useStore.getState().set({ sharing: false, screenStream: null });
    }
  }
}
