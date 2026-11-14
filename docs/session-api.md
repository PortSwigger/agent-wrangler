# Session API

Launched sessions talk back to Agent Wrangler over three HTTP routes, together called the session API:

| Route | Who calls it | What it does |
| --- | --- | --- |
| `POST /mcp` | the agent's MCP client (Claude, Codex, Gemini) | the board's MCP tools, acting as the calling session |
| `POST /pr-attach` | the PR-attach hook after `gh pr create` | attaches the new PR to the calling session's card |
| `POST /pr-model` | the PR model footer | answers which model to tag the calling session's PR with |

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
- **Gemini**: the board's Gemini settings name the header as `Bearer $AW_SESSION_TOKEN`, which
  Gemini expands.
- **PR hooks** (`scripts/pr-attach-hook.mjs`, `scripts/codex-pr-footer-hook.mjs`,
  `server/pr-footer.js`): read `AW_SESSION_TOKEN` and send the same header.

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

Every request to the three routes is decided by one function before any handler runs:

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

## Sessions launched before tokens

A session launched by an older server has no token. Its MCP config and hooks still send the card
id (`X-AW-Session`, or as Codex's bearer) to the board's port, which forwards `/mcp`, `/pr-attach`
and `/pr-model` to the deck. Only on those deck routes, the check accepts a bare card id when the
card is on the board, is not archived, its pane is running and it has never been issued a token. The first such call per
card is logged (`called without a session token`). Every launch issues a token, so once the
session is resumed or relaunched its card id stops working there too. The session API's own port
never accepts a card id.

## Starting it

`server/index.js` builds the session API once (`createSessionApi`) and calls `start({ port, host,
fixed })` before the deck and board bind, so every launch names the port it actually got, and
logs `session API at http://<host>:<port>`. A deck started with `--deck-only` runs the same
startup with no board, so it serves its session API too. Another startup needs only the same two
calls plus the handlers.
