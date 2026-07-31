import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { shellQuote, PR_HOOK_PATH, PR_HOOK_DEP_PATH, ISSUE_TO_PR_SKILL_DIR } from '../agents/claude.js';
import { AGENT_SKILLS_PLUGIN_DIR } from '../agent-skills.js';
import { addDirFor } from '../memory-store.js';
import { analyzeLines, usageSince } from '../transcript-reader.js';
import { statusOf } from '../claude-paths.js';

const DEFAULT_HOST_ADDR = 'host.docker.internal';

// Raised maxBuffer so a large transcript piped through `docker exec ... cat`
// isn't truncated (execFile's default is 1MB).
const defaultRun = (cmd, args) => promisify(execFile)(cmd, args, { maxBuffer: 64 * 1024 * 1024 });

// Shared with Task B3 (dormant-card resolution): the running container whose
// devcontainer label matches this host workspace dir, or '' when none/not running.
export async function containerIdFor(hostDir, run) {
  const { stdout } = await run('docker', ['ps', '--filter', `label=devcontainer.local_folder=${hostDir}`, '-q']);
  return (stdout || '').trim().split('\n')[0] || '';
}

// The two config paths `devcontainer up --workspace-folder <dir>` resolves by
// default (no --config): .devcontainer/devcontainer.json, then .devcontainer.json.
// A subfolder config (.devcontainer/<name>/devcontainer.json) is NOT picked up
// without --config, so treating that as "no default config" matches what the launch
// would actually do. Sync fs is fine — this runs once at dispatch, off the hot path.
export function hasDevcontainerConfig(cwd) {
  return fs.existsSync(path.join(cwd, '.devcontainer', 'devcontainer.json'))
    || fs.existsSync(path.join(cwd, '.devcontainer.json'));
}

// Stop the container the wrangler brought up for this workspace dir (the one
// containerIdFor resolves by the devcontainer.local_folder label) — offered on
// archive so a dormant devcontainer session stops leaving its container `Up`
// indefinitely. Returns the stopped container id, or null when there was nothing
// to stop (no devcontainer running for this dir) or docker errored. Null-degrades
// like readLive/analyze (try/catch → null): a best-effort reclaim must never
// break the archive it rides on. `run` is injectable for tests.
//
// Deliberately `docker stop <cid>` of the SINGLE workspace container, never
// `docker compose -p <project> down`: a compose-based devcontainer brings up
// sidecars (a shared DB, etc.) under one project that other work — or other
// tracked sessions — may rely on, so we stop only the container the label points
// at and leave any sidecars running. The same-container reuse guard (a
// dispatch/resume/fork against the same repo share ONE container) lives in the
// callers, mirroring the worktree-deletion "withheld while another session shares
// the cwd" rule.
export async function stopContainer(cwd, { run = defaultRun } = {}) {
  try {
    const cid = await containerIdFor(cwd, run);
    if (!cid) return null;
    await run('docker', ['stop', cid]);
    return cid;
  } catch {
    return null;
  }
}

// The inline --mcp-config and AW_PR_ATTACH_URL point at 127.0.0.1 (the loopback
// the host server advertises). From inside a container that address is the
// container itself, so rewrite it to a host-reachable name/IP settled by the
// Phase 0 spike (host.docker.internal on Docker Desktop). String-level: the URLs
// ride inside already-shell-quoted inline JSON, so a substitution is exact.
export function rewriteHostUrls(inner, hostAddr = DEFAULT_HOST_ADDR) {
  return inner.split('127.0.0.1').join(hostAddr);
}

// Container-side destinations for the host dirs we docker cp in (Task 1.3). Under
// /tmp, which managed-settings.json already grants as an additional directory.
export function containerInputPaths(sessionId) {
  return { skillsDir: `/tmp/aw-${sessionId}/skills`, notesDir: `/tmp/aw-${sessionId}/notes` };
}

// The host paths a devcontainer Claude launch injects that must be copied into the
// container. Each: { src, dest, substitute?, chmodX? }. `substitute` (default true)
// rewrites the host path → its /tmp/aw-<sid> dest inside the inner command; it's
// false ONLY for the PR-hook's parser (server/pr-hook.js), whose path never appears
// in the command — node resolves the .mjs's `../server/pr-hook.js` relative import at
// runtime, so the file just has to sit at the sibling container location. The two
// PR-hook files preserve that scripts/ ↔ server/ relative layout; pr-hook.js is
// dependency-free, so those two files are the whole hook. chmodX marks the .mjs so
// its shebang stays executable after copy. issue-to-pr rides only workflow launches
// (buildInnerCommand adds its --plugin-dir only then).
export function launchInputs(sessionId, { workflow = false } = {}) {
  const base = `/tmp/aw-${sessionId}`;
  const { skillsDir, notesDir } = containerInputPaths(sessionId);
  const inputs = [
    { src: AGENT_SKILLS_PLUGIN_DIR, dest: skillsDir },
    { src: addDirFor(sessionId), dest: notesDir },
    { src: PR_HOOK_PATH, dest: `${base}/scripts/pr-attach-hook.mjs`, chmodX: true },
    { src: PR_HOOK_DEP_PATH, dest: `${base}/server/pr-hook.js`, substitute: false },
  ];
  if (workflow) inputs.push({ src: ISSUE_TO_PR_SKILL_DIR, dest: `${base}/issue-to-pr` });
  return inputs;
}

// The whole launch as ONE shell script the tmux pane runs (the pane is a host tmux,
// so docker/devcontainer resolve on the host — which is why input copy works on a
// COLD dispatch: `up` first, then discover the container id by label, copy each input
// in, exec). Each manifest input → one `docker cp -L` + (unless substitute:false) one
// src→dest substitution in the inner command. `-L` follows the notes symlink; parents
// are mkdir'd because docker cp won't create the destination parent. The URL rewrite
// (127.0.0.1 → host.docker.internal) runs last, over the already-path-translated inner.
export function buildPaneScript({
  inner, hostDir, sessionId, workflow = false, hostAddr = DEFAULT_HOST_ADDR,
  inputs = launchInputs(sessionId, { workflow }),
}) {
  const wf = shellQuote(hostDir);
  let translated = inner;
  // Order-independent today: every input's src is a distinct, non-prefixing path. If a src ever became a prefix of another, translate longest-first to avoid a partial-match corruption.
  for (const { src, dest, substitute = true } of inputs) {
    if (substitute) translated = translated.split(src).join(dest);
  }
  translated = rewriteHostUrls(translated, hostAddr);
  const parents = [...new Set(inputs.map(({ dest }) => dest.slice(0, dest.lastIndexOf('/'))))];
  return [
    `devcontainer up --workspace-folder ${wf}`,
    `CID=$(docker ps -q --filter label=devcontainer.local_folder=${wf} | head -1)`,
    `docker exec "$CID" mkdir -p ${parents.map(shellQuote).join(' ')}`,
    ...inputs.map(({ src, dest }) => `docker cp -L ${shellQuote(src)} "$CID":${shellQuote(dest)}`),
    // chmod as root: `docker cp` preserves the HOST file's uid (e.g. 501 on macOS),
    // which is neither the container's default exec user (often a non-root `vscode`)
    // nor root, so a plain `docker exec chmod` hits EPERM and — being `&&`-chained —
    // aborts the whole launch before claude ever starts. Root can always chmod.
    ...inputs.filter((i) => i.chmodX).map(({ dest }) => `docker exec -u root "$CID" chmod +x ${shellQuote(dest)}`),
    `devcontainer exec --workspace-folder ${wf} sh -lc ${shellQuote(translated)}`,
  ].join(' && ');
}

export const devcontainer = {
  id: 'devcontainer',
  skipsHostResumeGuard: true,
  async wrapLaunch({ inner, cwd, sessionId, workflow = false }) {
    return buildPaneScript({ inner, hostDir: cwd, sessionId, workflow });
  },
  // Dispatch preflight: refuse when the target repo has no devcontainer config,
  // rather than let `devcontainer up` try to synthesize one and die with an opaque
  // error inside the pane (a dead card). Returns null when OK, else a board-surfaced
  // message the dispatch handler relays as a toast. A blank/scratch cwd can't be a
  // devcontainer target (nothing to mount, no config).
  async preflight({ cwd } = {}) {
    if (!cwd) return 'A devcontainer session needs a real repo folder (one with a .devcontainer config), not a blank or scratch cwd.';
    if (!hasDevcontainerConfig(cwd)) {
      return `No devcontainer config in ${cwd} — add a .devcontainer/devcontainer.json (or .devcontainer.json) before running this repo in a devcontainer.`;
    }
    return null;
  },
  // NOTE: docker exec user/home RESOLVED (E2E-verified in Group G) — a raw
  // `docker exec` (no `-u`) runs as the container's DEFAULT user, which for a
  // devcontainer is root (`.Config.User`; `remoteUser` is applied only by
  // `devcontainer exec`, not raw `docker exec`), so `~` is /root and empty:
  // claude actually runs as the devcontainer's remoteUser and writes under
  // /home/<user>/.claude. Root can read any user's home, and there's no clean
  // universal way to learn the remoteUser from a raw docker exec — so instead
  // of resolving it, glob both /home/*/.claude and /root/.claude.
  // NOTE (Task G-cat-exit, live-verified): when one glob doesn't match (e.g.
  // root has no .claude), sh leaves that path literal and `cat` fails on it —
  // exiting non-zero even though the OTHER path matched and stdout is valid.
  // promisify(execFile) rejects on any non-zero exit regardless of stdout, so
  // without `|| true` a matched transcript was dropped by the try/catch below.
  // `|| true` forces exit 0; we still rely on empty stdout → null. A real
  // `docker exec` failure (container gone) still rejects — that failure is in
  // starting the exec itself, before this `sh -c` string ever runs.
  async analyze({ entry, liveSid }, { run = defaultRun } = {}) {
    try {
      const cid = await containerIdFor(entry.cwd, run);
      if (!cid) return null;
      // Glob, not a hardcoded `-workspace` bucket: the container's mount point
      // varies by image, but liveSid is a unique uuid so the glob matches exactly
      // one transcript wherever its project bucket landed.
      const result = await run('docker', ['exec', cid, 'sh', '-lc', `cat /home/*/.claude/projects/*/${liveSid}.jsonl /root/.claude/projects/*/${liveSid}.jsonl 2>/dev/null || true`]);
      const out = (result.stdout || '').trim();
      if (!out) return null;
      return analyzeLines(out.split('\n').filter(Boolean), { since: usageSince(entry) });
    } catch {
      return null;
    }
  },
  // NOTE: a container-side Claude writes its hook status file keyed by ITS OWN
  // pid, which the host can't map to a tmux pane — so instead of reading one
  // file by pid (host claude-paths.liveState), cat ALL session files and pick
  // the blob whose sessionId matches entry.liveSessionId (Claude presets this
  // id at launch, so it's pid-independent and stable across restarts within the
  // container). The line-oriented parse assumes each session file is single-line
  // JSON (as claude-paths writes them), E2E-verified in Group G. Docker
  // exec user/home RESOLVED (see the analyze NOTE above for the full
  // reasoning): a raw docker exec runs as root, whose `~` is empty, so glob
  // /home/*/.claude and /root/.claude rather than rely on $HOME.
  // NOTE (Task G-cat-exit): same unmatched-glob exit-code tolerance as
  // analyze's cat above — `|| true` forces exit 0 so a matched session file
  // isn't dropped just because the OTHER glob had nothing to match.
  async readLive({ entry }, { run = defaultRun } = {}) {
    try {
      const cid = await containerIdFor(entry.cwd, run);
      if (!cid) return null;
      // Emit one status file per line. The files are single-line JSON but NOT
      // newline-terminated, so a bare `cat a.json b.json` glues them into one
      // unparseable line (`{…}{…}`) the moment a session has >1 status file (a login
      // relaunch spawns a second) — which then parses to nothing and reads as dead.
      // `echo` after each cat forces the per-file split.
      const { stdout } = await run('docker', ['exec', cid, 'sh', '-lc', 'for f in /home/*/.claude/sessions/*.json /root/.claude/sessions/*.json; do [ -f "$f" ] && { cat "$f"; echo; }; done 2>/dev/null || true']);
      const blobs = [];
      for (const line of (stdout || '').split('\n')) {
        if (!line.trim()) continue;
        try {
          blobs.push(JSON.parse(line));
        } catch {
          // garbage/partial line — skip
        }
      }
      // >1 file can share the sessionId (a relaunch leaves a stale one behind);
      // prefer the freshest so status/name aren't read off a corpse.
      const match = blobs
        .filter((obj) => obj.sessionId === entry.liveSessionId)
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      if (!match) return null;
      return {
        liveSid: match.sessionId,
        status: statusOf(match.status),
        rawStatus: match.status ?? null,
        waitingFor: match.waitingFor || null,
        name: match.name || null,
        updatedAt: match.updatedAt || null,
      };
    } catch {
      return null;
    }
  },
};
