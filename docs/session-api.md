# Session API

Launched sessions talk back to Agent Wrangler over four HTTP routes, together called the session API:

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /mcp` | the agent's MCP client (Claude, Codex, agy) | the board's MCP tools, acting as the calling session |
| `POST /pr-attach` | the PR-attach hook after `gh pr create` | attaches the new PR to the calling session's card |
| `POST /pr-model` | the PR model footer | answers which model to tag the calling session's PR with |
| `POST /status-event` | the status hooks, on a runtime with `statusEvents: true` | sets the calling session's card status (see [Status events](#status-events)) |

They are served on their own port, `AW_SESSION_API_PORT` (default the deck's port + 1: `AW_PORT` + 2
with a board, `AW_DECK_PORT` + 1 for a deck started with `--deck-only`), bound like the
board (`AW_BIND_HOST`, loopback by default). Running sessions keep the URLs they launched with, so
the server saves the port it bound in `session-api.json` in the data directory and asks for the
same one on its next start. If that port is taken it picks a free one, saves it, and sessions
launched before need a resume to reach it. A port set with `AW_SESSION_API_PORT` is held to: the
server exits if it cannot bind it. The listener serves
nothing else, and refuses any request that carries an `Origin` header, since no browser page has
a reason to call it.

## Session tokens

Every launch of a card (dispatch, resume, fork) gets a fresh random token, `awt_` followed by 32
random bytes in base64url. Launching again retires the card's previous token. The server keeps
only the SHA-256 of each token, in memory and in `session-tokens.json` in the data directory (mode
0600), so a server restart still knows every live session and the file never holds a usable token.
Purging a card from the board drops its token.

The token reaches the session as `AW_SESSION_TOKEN` in its environment. Where the runtime takes
secret variables (the local and devcontainer runtimes do), it travels through the launch-secrets
file, which the pane sources and deletes before the agent starts, so it is never on a command line
or in the tmux pane command. An extension runtime that does not take secret variables gets it as an
ordinary variable on its launch command, like any other. A runtime that builds its own launch gets
no token. An extension's own `AW_SESSION_TOKEN` variable is dropped. Each agent sends it as
`Authorization: Bearer <token>`:

- **Claude**: `--mcp-config` names the header as `Bearer ${AW_SESSION_TOKEN}`, which Claude expands
  from its environment.
- **Codex**: `mcp_servers.agent-wrangler.bearer_token_env_var="AW_SESSION_TOKEN"`.
- **agy**: the board's stdio MCP bridge (`server/agents/agy-mcp-bridge.js`) relays each message
  with `Bearer $AW_SESSION_TOKEN`, as agy expands no variables in MCP headers.
- **PR hooks** (`scripts/pr-attach-hook.mjs`, `scripts/codex-pr-footer-hook.mjs`,
  `server/pr-footer.js`) and the **status hook** (`scripts/status-event-hook.mjs`): read
  `AW_SESSION_TOKEN` and send the same header.

`AW_SESSION_ID` is still the card id. It identifies the session to itself and to other tools, and
it is not a credential.

### What a token does and does not stop

A session can no longer act as another by naming its card id, whether it guessed it, read it from
`list_sessions` or hallucinated it. The token does not separate sessions from each other at the OS
level: every session runs as the same user, and that user can read any of its processes'
environments (`ps -E`). A session set on impersonating another can read that one's
`AW_SESSION_TOKEN`. Keeping sessions apart from each other needs separate OS users or a deployment
with its own check (below).

## The caller check

Every request to the four routes is decided by one function before any handler runs:

```js
resolve(req, { legacy }) -> { cardId } | { refuse, reason }
```

- `req` is the Node `IncomingMessage` (headers only; the body has not been read).
- `{ cardId }` means the request acts as that card, and only that card. The MCP tools get it as
  `caller`, and their per-tool rules (an archive or message to another session, a checklist write
  to the caller's own card) apply to it as before.
- `{ refuse, reason }` is answered `403` with `{"error": refuse, "reason": reason}` and logged.
  `refuse` is one of `missing-token`, `unknown-token`, `archived`, `claim-mismatch`.
- `legacy` is true only on the old routes (see below).

A request may also send `X-AW-Session: <card id>` as a claim. If it does, the claim must name the
token's own card; any other card is refused with `claim-mismatch`. Handlers never read identity
headers themselves.

The single-machine implementation, `createLaptopCheck` in `server/session-api/check.js`, looks the
bearer up in the token store and refuses:

- no bearer: `missing-token`
- a bearer that is no current token: `unknown-token`
- a token whose card is archived: `archived`
- a claim naming another card: `claim-mismatch`

A token whose card the board has not recorded yet is accepted: an agent's MCP client can connect
before its launch has finished recording the card, and only a launch can mint the token.

### Plugging in another check

`createSessionApi({ resolve })` (`server/session-api/index.js`) takes any function with the
contract above in place of the laptop check. A deployment where sessions run as Kubernetes pods,
for example, could have each pod present its projected service-account token as the bearer and
check it with a `TokenReview`:

```js
async function resolveFromTokenReview(req) {
  const bearer = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '')?.[1];
  if (!bearer) return { refuse: 'missing-token', reason: 'missing token' };
  const review = await k8s.createTokenReview({ spec: { token: bearer, audiences: ['agent-wrangler'] } });
  if (!review.status.authenticated) return { refuse: 'unknown-token', reason: 'token not authenticated' };
  const cardId = cardForServiceAccount(review.status.user.username);
  if (!cardId) return { refuse: 'unknown-token', reason: 'no card for this service account' };
  if (isArchived(cardId)) return { refuse: 'archived', reason: 'the card is archived' };
  return { cardId };
}
```

`resolve` may return a promise. Everything after the check is unchanged: handlers only ever see
the resolved `cardId`.

## Status events

A runtime that declares `statusEvents: true` (docs/extensions.md, Runtimes) gets its card status
from events its sessions post, instead of from the agent's status files. Every other runtime,
including `local` and `devcontainer`, keeps file-based status unchanged.

### The route

`POST /status-event` with the session's token as `Authorization: Bearer <token>`, behind the same
caller check as the other routes, so a session can only ever set its own card's status. The body
is JSON (`Content-Type: application/json`), at most 1024 bytes, and exactly:

```json
{ "state": "waiting-permission", "at": 1781000000000, "sessionId": "5f0c…", "detail": "Claude needs your permission to use Bash" }
```

| Field | Required | Meaning |
| --- | --- | --- |
| `state` | yes | `working`, `waiting-permission`, `waiting-input` or `idle` (the turn finished) |
| `at` | no | when the hook ran, in milliseconds since the epoch; defaults to when the server got it |
| `sessionId` | no | the agent's conversation id (1-128 of `A-Za-z0-9_-`); the card follows it, as it follows a `/clear` |
| `detail` | no | what the session waits for, up to 200 characters |

Any other field, another type or another state is refused. The answers:

| Status | `error` | When |
| --- | --- | --- |
| `204` | | recorded, and the board rebuilds |
| `400` | `bad-body` | not JSON, or not the shape above (`reason` says which field) |
| `403` | the caller check's refusal | no token, an unknown token, an archived card, or an `X-AW-Session` claim naming another card |
| `409` | `not-opted-in` | the token's card runs on a runtime without `statusEvents`; its status stays file-based |
| `413` | `too-large` | the body is over 1024 bytes |
| `415` | `bad-content-type` | not `application/json` |

A token whose card the board has not recorded yet is accepted, since a hook can fire before the
launch has recorded the card. An event older (by `at`) than the one the card already has is
dropped, since hooks may run concurrently and arrive out of order. The server keeps the last
event per card in `session-status.json` in the data directory, so a restart shows the same
status. A new launch of the card, and purging it, clear it.

### The card's status

| Last event | Card |
| --- | --- |
| `working` | working |
| `waiting-permission` | needs-you, waiting reason `permission`, waiting for `detail` or "Waiting for permission" |
| `waiting-input` | needs-you, waiting for `detail` or "Waiting for your input" |
| `idle` | idle |
| none yet | unknown |

For these cards the graph tick reads no status file, never calls the runtime's `readLive` and never
reads a Codex rollout for status. Chat, cost, activity and the transcript-based API error check
read the transcript as before.

### The hooks

The deck adds the hooks to the agent's launch command for a session on an opted-in runtime, with
`AW_STATUS_EVENT_URL` (this route's URL) beside `AW_SESSION_TOKEN`. Each runs
`scripts/status-event-hook.mjs <state>`, which reads the hook payload on stdin for the
conversation id and, for a waiting state, a notification's message or the tool a
`PermissionRequest` asks for ("Permission to use Bash"), posts the event with a 2 second timeout, and always
exits 0 with no output, so it never changes what the agent does.

| Agent | Hook (matcher) | State |
| --- | --- | --- |
| Claude | `SessionStart` | `idle` |
| Claude | `UserPromptSubmit` | `working` |
| Claude | `PreToolUse` (`AskUserQuestion`) | `waiting-input` |
| Claude | `PermissionRequest` (`*`) | `waiting-permission` |
| Claude | `PostToolUse` (`*`) | `working` |
| Claude | `Notification` (`permission_prompt`) | `waiting-permission` |
| Claude | `Notification` (`elicitation_dialog`) | `waiting-input` |
| Claude | `Stop` | `idle` |
| Codex | `SessionStart` | `idle` |
| Codex | `UserPromptSubmit` | `working` |
| Codex | `PermissionRequest` | `waiting-permission` |
| Codex | `PostToolUse` | `working` |
| Codex | `Stop` | `idle` |

Claude gets them in `--settings`, after the PR-attach hook. Its `PermissionRequest` fires as the
dialog opens; the `permission_prompt` notification that follows a few seconds later is a fallback. Codex gets them as `-c` hook overrides,
trusted in the same flags as the PR footer's hook (`server/codex-hook-config.js`) and run async.
The runtime's `wrapLaunch` is handed `statusHook: { script }`, the script's host path, so a runtime
whose agent runs somewhere else can copy that one self-contained file in. A session interrupted
mid-turn (Esc) fires no hook, so its card shows working until its next event.

## The old routes on the deck and board ports

Before the session API had its own port, sessions called `POST /mcp`, `/pr-attach` and `/pr-model`
on the board's port, which forwards them to the deck. `/status-event` is served only on the session
API's port. The old routes still work, as an adapter onto
the session API: the same caller check decides every request, and handlers see only the resolved
card. The first call to any of them logs one deprecation warning naming the session API's address:

```
[agent-wrangler] POST /mcp, /pr-attach and /pr-model on the deck's or board's port is deprecated and kept working through an adapter; use the session API at http://127.0.0.1:7880 (sessions launched before it move there when resumed) instead.
```

A session moves to the session API's own port when it is resumed or relaunched.

### Sessions launched before tokens

A session launched by an older server has no token. Its MCP config and hooks still send the card
id (`X-AW-Session`, or as Codex's bearer) to the board's port. Only on the old routes, the check
accepts a bare card id when the card is on the board, is not archived, its pane is running and it
has never been issued a token. The first such call per card is logged (`called without a session
token`). Every launch issues a token, so once the session is resumed or relaunched its card id
stops working there too. The session API's own port never accepts a card id.

## The deck takes no session token

A session token is for the session API only. The deck's own surfaces, `GET /deck`, the `/ws` action
channel and `/pty`, refuse any request that carries one, as an `Authorization: Bearer` header or an
`X-AW-Session` header, whether it reaches the deck's port directly or through the board's
forwarder. `GET /deck` answers `403` with `{"error": "session-credential", ...}`; a `/ws` or `/pty`
upgrade is answered `403` and never opens, so no action frame or pty input can follow. The board
itself never sends either header. A session therefore acts only through the session API, as its
token's card, under the per-tool rules there, and never as the board's user.

## Starting it

`server/index.js` builds the session API once (`createSessionApi`) and calls `start({ port, host,
fixed })` before the deck and board bind, so every launch names the port it actually got, and
logs `session API at http://<host>:<port>`. A deck started with `--deck-only` runs the same
startup with no board, so it serves its session API too. Another startup needs only the same two
calls plus the handlers.

## Requests during restart draining

During a graceful restart, new `/mcp`, `/pr-attach` and `/status-event` requests
receive HTTP 503 with `Retry-After: 1` and a JSON body containing
`error: 'restarting'` and `retryable: true`. An admitted MCP tool or write keeps
running, even if its client disconnects, and connected clients have their responses flushed before
core exits. If draining times out after 30 seconds, the restart remains pending
and requests are accepted again. A retryable refusal means the handler did not
run; a disconnected admitted request still needs its normal outcome check
before a caller repeats a mutation.
