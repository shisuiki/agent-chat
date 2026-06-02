# Matrix federation and bridge audit

Date: 2026-06-02
Owner: agentchat-develop
Scope: Osaka Palpo Matrix federation, room joins, and Agent Chat Matrix bridge hidden risks.

## Executive summary

Osaka Matrix is not failing at DNS, TLS, or nginx reachability for its own server name. Public discovery for `matrix.osaka.ananthe.party` reaches `206.190.235.83:443`, TLS validates, and `/_matrix/key/v2/server` signs as `matrix.osaka.ananthe.party`.

The strongest Osaka-side federation defect is that `GET /_matrix/federation/v1/version` returns `404 M_UNRECOGNIZED`. The latest Palpo source still documents this as a GET endpoint but routes `v1/version` and `v2/version` with `post(version)`, so the deployed behavior matches a Palpo route-method bug rather than an nginx split.

The concrete room-join failure found in production logs is a separate outbound federation failure against `matrix.kusuri.ai`: Palpo tried `https://matrix.kusuri.ai:8448/_matrix/federation/v1/query/directory?...`, retried, and failed. Public probes show `matrix.kusuri.ai` has no `.well-known/matrix/server`, so standard discovery falls back to `:8448`; that port serves a Cloudflare Origin CA certificate and fails public CA validation. `matrix.kusuri.ai:443` works, but without `.well-known` a normal homeserver will not use it for federation.

The Matrix bridge has several hidden correctness and security risks that are independent of Palpo federation. The highest priority is command ACL fail-open: when both Matrix operator/admin allowlists are empty, privileged commands, including tmux injection, are allowed for any Matrix sender who can reach a command-capable room.

## Evidence

External Osaka probes:

```text
dig +short A matrix.osaka.ananthe.party
206.190.235.83

curl https://matrix.osaka.ananthe.party/.well-known/matrix/server
{"m.server":"matrix.osaka.ananthe.party:443"}

curl https://matrix.osaka.ananthe.party/_matrix/key/v2/server
server_name: "matrix.osaka.ananthe.party"

curl https://matrix.osaka.ananthe.party/_matrix/federation/v1/version
404 {"errcode":"M_UNRECOGNIZED","error":"The requested resource could not be found."}
```

Matrix Federation Tester:

```text
matrix.osaka.ananthe.party:
  FederationOK=false
  TLS/server-key checks=true
  Version failure: GET /_matrix/federation/v1/version -> 404 M_UNRECOGNIZED

matrix.kusuri.ai:
  FederationOK=false
  no .well-known
  falls back to 218.250.97.9:8448
  Version failure: x509 certificate signed by unknown authority
```

Osaka production:

```text
palpo.service: active
bridge-matrix.service: active
nginx.service: active
Palpo config: server_name = "matrix.osaka.ananthe.party"; [federation] enable = true
Palpo listens on 127.0.0.1:8008
nginx SNI routes matrix.osaka.ananthe.party / palpo.osaka.ananthe.party to 127.0.0.1:8445, then proxies to Palpo
no public :8448 listener
```

Production join failure from Palpo logs:

```text
WARN palpo::federation: could not send request to matrix.kusuri.ai at
https://matrix.kusuri.ai:8448/_matrix/federation/v1/query/directory?room_alias=%23crosstest%3Amatrix.kusuri.ai:
Request failed after 2 retries

ERROR palpo::room::alias::remote:
Failed to query for "#crosstest:matrix.kusuri.ai" from matrix.kusuri.ai

POST /_matrix/client/v3/join/%23crosstest%3Amatrix.kusuri.ai -> 404 Not Found
```

Palpo route evidence:

```text
Installed binary strings include:
  #GET /_matrix/federation/v1/version
  palpo::routing::federation::version

Latest upstream route shape:
  Router::with_path("v1").push(Router::with_path("version").post(version))
  Router::with_path("v2").push(Router::with_path("version").post(version))

Osaka local Palpo:
  GET  http://127.0.0.1:8008/_matrix/federation/v1/version -> 404
  POST http://127.0.0.1:8008/_matrix/federation/v1/version -> 401 M_MISSING_TOKEN
```

External sources:

- Matrix Server-Server API: https://spec.matrix.org/latest/server-server-api/
- Palpo upstream repo: https://github.com/palpo-matrix-server/palpo/
- Palpo site states Palpo is under active development: https://palpo.chat/

## Findings

- [P0] Osaka federation health is broken by Palpo federation version route method mismatch.
  Impact: Matrix Federation Tester reports `FederationOK=false`; strict homeservers and operators see Osaka as non-federating even though TLS and keys pass.
  Evidence: `GET /_matrix/federation/v1/version` returns 404 through nginx and directly on `127.0.0.1:8008`; Palpo source/binary indicate the route exists but is registered as POST.
  Fix: Patch/rebuild Palpo so `/_matrix/federation/{v1,v2}/version` accepts GET without auth. Short-term nginx exact-location synthetic JSON is possible for the version probe only, but it does not fix deeper join behavior.

- [P0] The observed `#crosstest:matrix.kusuri.ai` room join failure is caused by remote homeserver discovery/TLS.
  Impact: Osaka cannot resolve that remote room alias because Palpo discovers `matrix.kusuri.ai:8448`, then TLS verification fails/retries out.
  Evidence: `matrix.kusuri.ai/.well-known/matrix/server` returns 404, so default federation goes to `:8448`; `:8448` presents a Cloudflare Origin CA certificate; Federation Tester reports x509 unknown authority.
  Fix: On `matrix.kusuri.ai`, either install a publicly trusted cert on `:8448`, or serve `.well-known/matrix/server` pointing to `matrix.kusuri.ai:443`.

- [P0] Matrix command ACL fails open when ACL env is empty.
  Impact: Any Matrix sender in a command-capable room can run privileged commands. The worst case is `!ctl send/key`, which writes directly into an agent tmux pane.
  Evidence: [lib/bot-commands.js](/home/shisui/laplace/agent-chat/lib/bot-commands.js:41) allows all tiers with reason `no_acl` when both allowlists are empty; [lib/bot-commands.js](/home/shisui/laplace/agent-chat/lib/bot-commands.js:1154) performs tmux `send-keys`.
  Fix: Fail closed for tier >= 1 if operator/admin ACL is empty, or make bridge startup fail unless ACL is configured for internet Matrix deployments. Add no-ACL tests proving only `!help` works.

- [P0] Matrix ingress retry is not idempotent across timeout or restart.
  Impact: If backend persists a Matrix-origin message but the bridge times out, retry creates a second backend message and can duplicate push/SSE/agent-visible delivery.
  Evidence: [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:1869) retries POST; [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:1898) dedupes Matrix event IDs only in memory; [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js:9777) accepts `source_room`/`sender_mxid` but no persisted `source_event_id`.
  Fix: Persist a unique source key such as `matrix:${source_room}:${event_id}` and return the existing message on duplicate. Test backend partial success followed by retry and bridge restart replay.

- [P1] Newly greeted bot-DM rooms are untrusted until restart in enforce mode.
  Impact: With `MATRIX_TRUST_MODE=enforce`, a human can receive a greeting DM but their immediate reply can be rejected until the bridge restarts.
  Evidence: startup seeds existing `botDmRooms` into `trustedManagedRooms`, but [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:1772) only writes `state.botDmRooms` and does not call `markRoomTrusted`.
  Fix: Mark bot-DM rooms trusted at creation. Add enforce-mode greeting/reply regression coverage.

- [P1] Matrix membership removals while the bridge is down are lost.
  Impact: Backend group membership can retain users who left or were kicked from Matrix while bridge was offline.
  Evidence: [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:2037) ignores historical events before startup; [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:2307) periodic reconcile only adds Matrix members and explicitly does not remove backend-only members.
  Fix: Store Matrix sync cursor and replay membership deltas, or add explicit pending/invited state so full reconcile can remove safely.

- [P1] Bridge state corruption silently resets ownership.
  Impact: A truncated `bridge-state.json` can erase tokens, room maps, trusted rooms, greeted users, and cause duplicate rooms/greetings or login churn.
  Evidence: [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:257) catches any load error and returns empty state; [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:264) writes JSON directly.
  Fix: Atomic write with backup/schema version; fail closed or recover backup on corrupt primary. Test truncated state does not start as empty.

- [P1] Outbound Matrix sends lack durable idempotency and delivery observability.
  Impact: Duplicate SSE, bridge restart, or ambiguous send timeout can duplicate Matrix messages with no durable sent/failed record.
  Evidence: [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:2872) uses in-memory `recentBridgedIds`; [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:3293) uses random transaction IDs; SSE has no replay cursor.
  Fix: Derive Matrix transaction IDs from Agent Chat message ID and attachment part, persist Matrix event IDs, and record bridge delivery attempt/sent/failed events.

- [P1] SSE async handlers can reject outside local error handling.
  Impact: An async failure in group creation, membership sync, or message send can become an unhandled rejection instead of a logged bridge warning.
  Evidence: [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:2450) calls async handlers without `.catch()`; the surrounding `try/catch` only covers parsing and synchronous throw.
  Fix: Wrap all async SSE handlers with `void handler(...).catch(...)`; add tests for rejected `onGroupCreated` and `onAgentMessage`.

- [P2] Federated human identity still collides by localpart in some state paths.
  Impact: `@alice:a` and `@alice:b` can share greeting or membership identity in bridge/backend-facing paths.
  Evidence: full MXIDs are accepted for explicit targets, but [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:1740) extracts localpart for greeting and [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:2137) maps non-agent room members to localpart.
  Fix: Use full MXID as canonical identity for federated humans; localpart only for display.

- [P2] Formatted reply links can still lead to 401.
  Impact: The top-level Matrix `View formatted` link carries `?view=...`, but the HTML page's `Reply to` link does not carry the replied message's view token.
  Evidence: [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:2912) includes view token for the main message; [backend-v2.js](/home/shisui/laplace/agent-chat/backend-v2.js:10218) renders reply links without a token.
  Fix: For token-view pages, render reply IDs as text or include a policy-approved scoped token for the referenced message.

- [P2] Inbound Matrix media cache is unbounded.
  Impact: A large Matrix media event can consume bridge memory/disk before backend attachment limits apply.
  Evidence: [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:1504) fetches media with bot auth and [bridge-matrix.js](/home/shisui/laplace/agent-chat/bridge-matrix.js:1511) writes it to `data/matrix/media` without size guard.
  Fix: Add max bytes, content-length guard, bounded streaming, and an explicit not-cached notice.

## Repair plan

1. Federation health batch:
   - Patch Palpo or deploy an upstream build where `GET /_matrix/federation/v1/version` works without auth.
   - Validate with local Palpo, public curl, and Matrix Federation Tester.
   - Do not treat this as proof that arbitrary joins work; run a signed join after version passes.

2. Remote room join batch:
   - Fix `matrix.kusuri.ai` federation discovery/TLS if that room remains the E2E target.
   - Re-run join for `#crosstest:matrix.kusuri.ai` from Osaka and capture Palpo `query/directory`, `make_join`, and `send_join` logs.

3. Bridge safety batch:
   - Fail closed for empty Matrix command ACL, or make ACL required at bridge startup for internet-facing deployments.
   - Add tests for no-ACL privileged command rejection.

4. Bridge delivery correctness batch:
   - Add persisted Matrix source event idempotency for inbound messages.
   - Add deterministic Matrix transaction IDs and sent/failed delivery state for outbound messages.

5. Bridge state and trust batch:
   - Atomic bridge state writes with backup/recovery.
   - Trust newly created bot-DM rooms immediately.
   - Wrap async SSE handlers.

6. Federation identity and media hardening:
   - Preserve full MXID for federated humans in greeting, membership, backend payloads, and DM keys.
   - Bound Matrix media cache size and streaming.

## Verification already run

- Public DNS, TLS, well-known, key, client version, and federation version probes for Osaka.
- Matrix Federation Tester reports for `matrix.osaka.ananthe.party`, `palpo.osaka.ananthe.party`, and `matrix.kusuri.ai`.
- Osaka read-only service/config/log checks for `palpo`, `bridge-matrix`, `nginx`, and `agent-chat-v2`.
- Public and Osaka probes against `matrix.kusuri.ai:8448` and `:443`.
- Palpo upstream source route inspection.
- Agent Chat bridge source audit with file/line evidence.

No production service was restarted and no runtime config was changed in this audit.
