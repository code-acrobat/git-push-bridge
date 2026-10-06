# AGENTS.md

Guidance for agents working on / installing this repository. User-facing
documentation is [README.md](./README.md) (motivation, GitLab example,
knobs, sandbox wiring); this file is the agent runbook. Both stand alone —
link across instead of copying text.

## Repo map

| path | what it is |
|------|------------|
| `git-push-bridge.mjs` | the bridge: node, zero dependencies, stdlib only |
| `git-push-bridge.sh` | `up` / `down` / `status`; `up` runs `~/.local/bin/git-push-bridge.mjs` |
| `README.md` | user-facing docs (GitLab, systemd, sandboxes live there) |

## Install — run this for "install the github bridge"

```sh
# 1. prereqs: node; gh logged in on the host (default TOKEN_CMD)
gh auth status

# 2. install + start + check
cp git-push-bridge.mjs git-push-bridge.sh ~/.local/bin/
git-push-bridge.sh up
git-push-bridge.sh status        # expect: up (pid N), port 3721: 200

# 3. wire the session (push only; fetch/clone stay direct, repo config untouched)
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='url.http://127.0.0.1:3721/.pushInsteadOf'
export GIT_CONFIG_VALUE_0='https://github.com/'
# (host-wide or repo-local variants: README "Example: GitHub")

# 4. verify auth without pushing anything
curl -s -o /dev/null -w '%{http_code}\n' \
  'http://127.0.0.1:3721/<owner>/<repo>.git/info/refs?service=git-receive-pack'
# expect 200 via the bridge (the direct https://github.com URL answers 401)

# Nothing to register anywhere: this is not an MCP server, no config entry,
# no tools — the client stays plain git pointed at loopback by the rewrite.
```

- Target is a sandbox (omac): do the two extra steps in README
  *Sandboxes* — `open_port: [3721]` + the three exact `GIT_CONFIG_COUNT` /
  `GIT_CONFIG_KEY_0` / `GIT_CONFIG_VALUE_0` names in `allow_vars` of
  `~/.config/omac/sandbox-profiles/default.json`, pass the three
  `GIT_CONFIG_*` exports to the session. Never pass the token itself.
- GitLab or a second forge: separate instance on another port, see README
  *Example: GitLab*.
- Something wrong: `status` first (WSL drops closed loopback ports, so git
  *hangs* rather than failing); `502` = `TOKEN_CMD` failed → `gh auth status`.

## Invariants (do not regress)

- Both directions stream (`req.pipe` / `ures.pipe`) — a pack is never buffered.
- Token comes from `TOKEN_CMD` per request: never persisted, never logged,
  never handed to the client; the client's `Authorization` is stripped first.
- Browser guard (`Origin` / `Sec-Fetch-Site` → 403) stays.
- `pushInsteadOf`, not `insteadOf` — fetch and `ls-remote` must stay direct.
- `DENY_REFS` gates only POST `.../git-receive-pack`, decides from the
  command section **before** any token lookup or upstream contact, and
  fails closed (oversized / unparsable = refuse). Default off.
- `pid()` in the control script stays anchored on argv[1] (unanchored
  matched shells running `node --check`).
- No dependencies, no rules file, no config file — env knobs only.

## Verify before committing

```sh
node --check git-push-bridge.mjs
node git-push-bridge.mjs --selftest
bash -n git-push-bridge.sh
```

## House rules

- No new dependencies, no speculative structure — one file doing the
  minimum is the point.
- Keep personal and machine-specific paths out of the repo; grep the diff
  before committing.
- Push only on explicit request.
- README owns user-facing facts, this file owns agent workflow — update
  the one that owns a changed fact and cross-reference the other.
