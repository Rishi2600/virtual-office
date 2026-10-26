/**
 * Unit tests for the client-message checks (shared/src/validate.ts) and the
 * rate limiter (rooms/rateLimit.ts): what a real client sends passes, and
 * malformed, oversized or hostile messages don't (audit SEC-7, SEC-8, PRIV-3).
 *
 * Run: npm test.
 */
import {
  CHAT_MAX_LENGTH,
  SDP_MAX_LENGTH,
  parseChat,
  parseInput,
  parseLock,
  parseMedia,
  parseRtcFailure,
  parseSignal,
  parseStatus,
} from "@vo/shared";
import { FLOOD_DROPS, LIMITS, RateLimiter } from "../rooms/rateLimit.js";

let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) passed++;
  else failed++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${!ok && detail ? ` — ${detail}` : ""}`);
}

console.log("\nclient message checks\n");

check("a normal input passes", JSON.stringify(parseInput({ seq: 7, dx: 1, dy: -1, dt: 0.033 })) === '{"seq":7,"dx":1,"dy":-1,"dt":0.033}');
check("dt NaN / Infinity / negative is refused", [NaN, Infinity, -1, "0.1"].every((dt) => parseInput({ seq: 1, dx: 1, dy: 0, dt }) === null));
check("dx/dy other than -1, 0, 1 is refused", parseInput({ seq: 1, dx: 5, dy: 0, dt: 0.03 }) === null && parseInput({ seq: 1, dx: 0.5, dy: 0, dt: 0.03 }) === null);
check("a fractional or negative seq is refused", parseInput({ seq: 1.5, dx: 0, dy: 0, dt: 0 }) === null && parseInput({ seq: -1, dx: 0, dy: 0, dt: 0 }) === null);

check("status: only available/focus", parseStatus({ status: "focus" }) === "focus" && parseStatus({ status: "admin" }) === null);
check("media: booleans pass, anything else refuses the message", JSON.stringify(parseMedia({ micOn: false, extra: 1 })) === '{"micOn":false}' && parseMedia({ camOn: "yes" }) === null);
check("lock: a boolean only", parseLock({ locked: true }) === true && parseLock({ locked: 1 }) === null);

check("chat: trimmed and capped", parseChat({ scope: "room", text: "  hi  " })?.text === "hi" && parseChat({ scope: "room", text: "x".repeat(CHAT_MAX_LENGTH + 5) })?.text.length === CHAT_MAX_LENGTH);
check("chat: empty, unknown scope or absurdly long is refused", parseChat({ scope: "room", text: "   " }) === null && parseChat({ scope: "all", text: "hi" }) === null && parseChat({ scope: "room", text: "x".repeat(CHAT_MAX_LENGTH * 3) }) === null);

const offer = parseSignal({ to: "peer1", payload: { kind: "description", description: { type: "offer", sdp: "v=0\r\n", evil: "<script>" } }, extra: 1 });
check("signal: a real SDP passes, rebuilt without extra fields", JSON.stringify(offer) === '{"to":"peer1","payload":{"kind":"description","description":{"type":"offer","sdp":"v=0\\r\\n"}}}', JSON.stringify(offer));
check("signal: an oversized SDP is refused", parseSignal({ to: "p", payload: { kind: "description", description: { type: "offer", sdp: "x".repeat(SDP_MAX_LENGTH + 1) } } }) === null);
check("signal: an unknown SDP type or payload kind is refused", parseSignal({ to: "p", payload: { kind: "description", description: { type: "hack" } } }) === null && parseSignal({ to: "p", payload: { kind: "chat" } }) === null);
const cand = parseSignal({ to: "p", payload: { kind: "candidate", candidate: { candidate: "candidate:1 1 udp 1 1.2.3.4 5 typ host", sdpMid: "0", sdpMLineIndex: 0, usernameFragment: "ab", junk: true } } });
check("signal: an ICE candidate passes, rebuilt", JSON.stringify(cand?.payload) === '{"kind":"candidate","candidate":{"candidate":"candidate:1 1 udp 1 1.2.3.4 5 typ host","sdpMid":"0","sdpMLineIndex":0,"usernameFragment":"ab"}}', JSON.stringify(cand));
check("signal: end-of-candidates (null) passes", parseSignal({ to: "p", payload: { kind: "candidate", candidate: null } })?.payload.kind === "candidate");
check("signal: a missing or huge recipient id is refused", parseSignal({ payload: { kind: "candidate", candidate: null } }) === null && parseSignal({ to: "x".repeat(100), payload: { kind: "candidate", candidate: null } }) === null);

const report = parseRtcFailure({ peerId: "p1", state: "failed", detail: `ICE failed via 192.168.1.20 and 2001:db8::1 ${"x".repeat(500)}`, sdp: "leak" });
check("rtc-failure: detail capped at 200 and IPs scrubbed", !!report && report.detail!.length <= 200 && !report.detail!.includes("192.168") && !report.detail!.includes("2001:db8") && !("sdp" in report), JSON.stringify(report));
check("rtc-failure: an unknown state is refused", parseRtcFailure({ peerId: "p1", state: "pwned" }) === null);

console.log("\nrate limits\n");
let t = 0;
const limiter = new RateLimiter(() => t);
const burst = Array.from({ length: LIMITS.chat.burst + 5 }, () => limiter.allow("chat")).filter(Boolean).length;
check("chat: a burst of 8 goes through, the rest is dropped", burst === LIMITS.chat.burst, `${burst}`);
t += 3000;
check("…and it refills at about one a second", [1, 2, 3, 4].map(() => limiter.allow("chat")).filter(Boolean).length === 3);
check("limits are per type: chat being spent doesn't block movement", limiter.allow("input"));
for (let i = 0; i < FLOOD_DROPS + 50; i++) limiter.allow("report");
check("hundreds of dropped messages in 10 s count as flooding", limiter.flooding());
t += 11_000;
check("…which wears off once it stops", !limiter.flooding());

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
