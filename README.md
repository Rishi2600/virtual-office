# Virtual Office

A lightweight, self-hosted Gather.town-style virtual office for a small team (~20 people).

Walk your avatar around a 2D pixel-art office. When you get close to someone, **text chat and voice
open automatically** — walk away and they close. **Video is opt-in**: nobody's camera turns on just
because someone walked past. Share your screen while you're talking, and lock a conversation when
you don't want to be interrupted.

**No conversation is ever recorded.** Audio and video travel peer-to-peer and never touch the
server; chat is relayed and never stored. See [Privacy](#privacy).

---

## Run it locally

```bash
npm install && npm run dev
```

That's it — no database, no Docker, no `.env` required. Open <http://localhost:5173>.

- Client: <http://localhost:5173>
- Server: <http://localhost:2567>

### Try it with two people

Real sign-in needs OAuth credentials (see [below](#sign-in-providers)), so local dev ships a
**dev sign-in**: type any name to enter. To simulate two colleagues in one browser:

1. Open <http://localhost:5173/?dev=Alice> in one tab.
2. Open <http://localhost:5173/?dev=Bob> in a second tab.
3. Click the Alice tab (it needs keyboard focus) and walk into Bob with the arrow keys or WASD.

`?dev=<name>` signs that tab in and keeps its identity in `sessionStorage`, which is per-tab — so
the two tabs stay two different people instead of sharing one cookie. The parameter is stripped
from the URL immediately. Plain tabs without the parameter share a session, as you'd expect.

When they get within ~120px, the **Nearby** chat tab becomes live and voice connects. Walk apart and
it tears down. The faint ring around your avatar shows how close you need to be.

> The browser asks for your **microphone** on load — that's the only device requested up front, and
> the "mic live" pill in the corner shows whenever it's actually in use. The **camera is never
> touched** until you click *Turn on video*. If you deny either, the app says so explicitly and
> still connects you receive-only, so you can hear the other person and use chat.

Dev sign-in is disabled whenever `NODE_ENV=production`, and the server **refuses to start** if you
try to enable it there anyway.

---

## Controls

| Action | Key / control |
| --- | --- |
| Move | Arrow keys or WASD |
| Chat with people near you | **Nearby** tab in the sidebar |
| Chat with the whole office | **Everyone** tab |
| Mute / unmute | **Mic** button |
| Start / stop your camera | **Turn on video** button |
| Share screen | **Share screen** button |
| Keep others out of your conversation | **Lock conversation** button |
| Do not disturb entirely | **Available / Focus mode** toggle |

Muting flips the track's `enabled` flag — it never tears down the call.

**Video is opt-in.** Proximity connects audio only; the camera is acquired the first time you click
*Turn on video*, and turning it off releases the device. Peers see an initial instead of a video
tile until someone turns their camera on.

**Two different ways to not be disturbed**, because they solve different problems:

- **Lock conversation** — for "we two are busy". Anyone already in the huddle can lock it. People
  walking past are not connected and see a *private* badge on the avatars; the people already
  talking are unaffected. It releases automatically once the participants separate, so you can't
  strand yourself in a lock nobody else holds.
- **Focus mode** — for "leave me alone entirely". The server refuses to pair you with anyone at
  all, so no offer is ever made. The greyed-out avatar and sidebar badge are additional signal, not
  the mechanism.

Both are enforced server-side, so a patched client can't force its way into either.

---

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Shared watcher + server + client, all three |
| `npm run build` | Type-check and build every workspace |
| `npm start` | Run the production server (serves the built client) |
| `npm test` | End-to-end server test (48 checks — see below) |
| `npm run gen:tileset` | Regenerate `tiles.png` / `avatars.png` |
| `node scripts/gen-map.mjs` | Regenerate the office map |

### `npm test`

Boots the real server in-process and drives it with real Colyseus clients over real WebSockets,
covering: auth handshake rejection, movement, collision, wall-sliding, proximity enter/exit,
hysteresis, signaling authorization, chat scoping, conversation locking, focus-mode suppression,
reconnect-with-position, and clean leave. Run it after touching anything in `shared/` or `server/`.

---

## Configuration

Everything has a working dev default. Copy `.env.example` to `.env` to change any of it.

### Sign-in providers

**Microsoft (Outlook / Entra ID)** is the primary provider; **GitHub** is the secondary. Configure
either or both — at least one is required in production, or the server refuses to start. Secrets go
in `.env`, which is gitignored; never commit them.

**Microsoft** — Azure Portal → **Microsoft Entra ID → App registrations → New registration**.
Platform **Web**, with a redirect URI matching `MICROSOFT_CALLBACK_URL` exactly. Then
**Certificates & secrets → New client secret** — copy the secret's **Value** (not its Secret ID,
which is the usual mix-up). Grant the delegated Graph permission `User.Read`.

- local: `http://localhost:5173/auth/microsoft/callback`
- production: `https://your-domain/auth/microsoft/callback`

**GitHub** — **Settings → Developer settings → OAuth Apps → New OAuth App**. The *Authorization
callback URL* must match exactly:

- local: `http://localhost:5173/auth/github/callback`
- production: `https://your-domain/auth/github/callback`

```ini
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=...
MICROSOFT_CALLBACK_URL=http://localhost:5173/auth/microsoft/callback
MICROSOFT_TENANT_ID=common          # your tenant GUID in production

GITHUB_CLIENT_ID=...
GITHUB_CLIENT_SECRET=...
GITHUB_CALLBACK_URL=http://localhost:5173/auth/github/callback

ALLOWED_EMAIL_DOMAIN=               # optional; leave blank while testing
```

> `.env` is read once at startup. **Restart `npm run dev` after editing it**, or the buttons won't
> appear and it'll look broken.

**`MICROSOFT_TENANT_ID` is the real access control.** Set it to your Entra directory (tenant) GUID
and Microsoft simply won't issue a token to anyone outside your organisation — a genuine boundary,
not a string match after the fact. `common` accepts any Microsoft account including personal ones,
so it's for testing only; the server refuses to start in production while it's set to `common`.

Two things worth knowing:

- **Email is the identity anchor.** The same person signing in with Microsoft and with GitHub on
  one address resolves to a single account. If their GitHub email differs from their work address,
  they'll get two accounts — linking identities is a follow-up.
- **`ALLOWED_EMAIL_DOMAIN` applies to GitHub too**, and GitHub accounts often use a personal email,
  so setting it will lock those people out. Prefer the tenant restriction and leave this blank
  unless you want belt-and-braces. Gating GitHub by *organisation membership* is the cleaner
  equivalent and a natural follow-up.

### Database

Unset `DATABASE_URL` and the server uses a local JSON file (`.data/dev.json`) so a fresh clone runs
with zero setup. Set it and it uses PostgreSQL instead — same interface, tables created on boot:

```ini
DATABASE_URL=postgres://vo:vo@localhost:5432/virtual_office
```

Only users and space metadata are stored. Nothing about calls is persisted.

### TURN (for restrictive networks)

STUN alone covers most networks. If people behind symmetric NAT or strict corporate firewalls
can't connect, add a TURN server (e.g. [coturn](https://github.com/coturn/coturn)) — **env only,
no code change and no client rebuild**:

```ini
TURN_URLS=turn:turn.yourcompany.com:3478
TURN_USERNAME=...
TURN_CREDENTIAL=...
```

The client fetches ICE configuration from `/api/config` at startup.

---

## Deploying

A single VPS is plenty for 20 people.

```bash
cp .env.example .env      # set JWT_SECRET, OAuth credentials, NODE_ENV=production
docker compose up -d --build
```

`docker-compose.yml` runs the app plus PostgreSQL. The app serves the built client and the game
server from one origin on port 2567 — put nginx or Caddy in front for TLS.

**HTTPS is not optional in production.** Browsers only grant camera, microphone, and screen
capture on a secure origin (`localhost` is the sole exception).

Without Docker: `npm ci && npm run build && npm start`.

---

## How it works

```
client/                     React + Phaser 3
  game/OfficeScene.ts       tilemap, avatars, prediction, interpolation
  net/session.ts            connect, reconnect, state mirror
  webrtc/PeerManager.ts     perfect negotiation, screen share, teardown
server/                     Node + Express + Colyseus
  rooms/OfficeRoom.ts       authoritative state, 20Hz tick
  rooms/proximity.ts        distance + hysteresis, enter/exit events
  rooms/signaling.ts        SDP/ICE relay (no media)
  auth/                     Microsoft + GitHub OAuth -> JWT -> WS handshake
  db/                       Repository: Postgres or JSON file
shared/                     imported by BOTH sides
  movement.ts               the one simulation step
  collision.ts, map.ts      tile collision
  maps/office.json          Tiled map — server AND client read this file
```

**Movement is server-authoritative with client-side prediction.** The client sends input intents
(never positions), predicts locally with the same `applyInput()` the server runs, and replays
unacknowledged inputs against the server's position each patch. Remote avatars are drawn 100ms in
the past and interpolated, which turns 20Hz patches into smooth motion.

**Proximity is computed on the server**, not the client. Clients render interpolated, delayed
positions, so two clients would disagree about the moment they overlap and you'd get half-open
calls. Deciding server-side also lets it name the offerer deterministically (killing offer glare)
and makes focus-mode suppression impossible for a patched client to bypass. Enter at 120px, exit at
160px — the gap stops a call thrashing when you stand on the boundary.

**Signaling is authorized.** The server only relays SDP/ICE between two people it currently
considers adjacent, so a client can't open a peer connection to someone across the map.

**Locks are computed against the proximity graph.** A locked huddle is a group id shared by everyone
in it; pairing is refused whenever two people's lock groups differ. Each tick the server drops
anyone who is no longer within reach of another member — otherwise two people who locked and then
walked apart would both stay silently un-callable.

**Nearby chat follows the huddle, not the pair.** It's delivered to the connected component of the
proximity graph, so a chain A–B–C is one conversation rather than two.

**Reconnect** keeps your seat for 30 seconds. Drop your WiFi and the client resumes the same
session at the same position — no page reload. Past that window it rejoins as a new session.
Peers see you greyed out and your calls tear down immediately rather than freezing.

### Notable choices

- **Colyseus pinned to the 0.16 line.** The published `colyseus` 0.18 server expects
  `@colyseus/schema` v5, while the newest browser client (`colyseus.js` 0.16.x) still expects v3 —
  mixing them silently breaks state sync. `server/src/smoke/colyseus-compat.ts` (`npm run smoke`)
  asserts the pairing still works; run it before upgrading either package.
- **Screen share uses `replaceTrack`**, so it needs no renegotiation. Trade-off: peers see your
  screen *instead of* your camera while sharing.
- **The map is generated** by `scripts/gen-map.mjs` rather than hand-authored, so the floor and
  collision layers can't drift apart. The output is ordinary Tiled JSON — open and edit it in
  [Tiled](https://www.mapeditor.org/) if you prefer.

---

## Privacy

- **Nothing is recorded.** No audio, video, screen content, transcripts, or chat are captured,
  buffered, or persisted — anywhere. There is no `MediaRecorder`, no canvas capture, no upload path,
  and no media endpoint in this codebase.
- **Media never reaches the server.** Calls are a peer-to-peer WebRTC mesh; the server relays only
  SDP and ICE candidates (`server/src/rooms/signaling.ts`).
- **Chat is relay-only.** Messages are never written to the database and never put into the
  synchronised room state — the server forwards them and forgets them, and they live in browser
  memory until you reload.
- **The camera is only ever opened by an explicit click**, never by proximity.
- **Stored data** is limited to user profile (name, email, avatar URL, timestamps) and space
  metadata.

The guarantee is asserted in a comment at the top of `client/src/webrtc/PeerManager.ts`, next to
the only media APIs the app calls.

---

## Scope and limits

Deliberately **not** built: multi-tenancy, billing, an admin dashboard, an in-app map editor,
password auth, and any SFU / room sharding / autoscaling.

Stubbed for later, with the seams already in place:

| | Status |
| --- | --- |
| **TURN** | Env-driven; only Google STUN populated. Add URLs, no code change. |
| **Redis presence** | Single process, in-memory. Drop-in at the `new Server({...})` call in `server/src/index.ts` (marked with a TODO). |
| **Postgres** | Written and used when `DATABASE_URL` is set; JSON file is the dev default. |
| **SFU** | All signaling is behind `rooms/signaling.ts` + `webrtc/PeerManager.ts`; game logic never touches it. |

**Mesh ceiling.** Every participant connects directly to every other participant *in their
proximity cluster*. Clusters of 2–6 are comfortable. A single huddle of ~10+ people will strain
browsers' upstream bandwidth — that's the point at which you'd want an SFU. Twenty people spread
across the office is fine; twenty people standing in one spot is not.
