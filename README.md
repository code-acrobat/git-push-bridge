# git-push-bridge

A loopback git **push** bridge: plain `git push` gets a credential it must never
see. One node file, no dependencies, token fetched on the host per request.

Works for **either GitHub or GitLab** — defaults are GitHub, the knobs in
*Knobs* retarget it (the GitLab example below). Other forges and any further
magic: point your own agent at the Knobs table; this stays a two-file PoC.

## The problem

This only makes sense for sandboxes. On a normal host you don't need it:
credential helpers, `gh` / `glab` — git gets a token the direct way. The
moment the client is a sandbox that must never see the secret, every
client-side option is out: credential helpers, `GIT_ASKPASS`,
`http.extraHeader` all put the token inside the sandboxed environment, which
is exactly what the sandbox forbids. (`http.extraHeader` is how this is
normally solved in CI and in custom MCPs — fine when the client is trusted;
the sandbox exists because here it isn't.) The credential has to enter at the
host boundary instead. See *Sandboxes* below for how a sandbox gets wired to
the bridge.

## Why the GitHub / GitLab MCP servers don't cover this

- **They are API-shaped, not git-shaped.** `push_files` / `create_or_update_file`
  (GitHub) and the commits API (GitLab) take file *contents* as JSON arguments.
  The model has to inline every byte through its own context: 10 files is
  already ~253 KB.
- **They create new server-side commits, they cannot transmit yours.** No local
  history (merges, rebases), no original author dates, no GPG signatures, no
  force-with-lease. What lands on the remote is an API reconstruction, not the
  objects in your `.git`.
- **No push/fetch/pull verbs at all** in either toolset. The dedicated
  `mcp-server-git` is no better: add/commit/diff/log/branch, zero network verbs.
- **Tool arguments run inside the agent session** — an MCP configured with a
  PAT hands the token to the session. The bridge fetches its token host-side
  and the session only ever sees `http://127.0.0.1:3721/`.

So: reads, issues, PRs, branches → MCP. Moving objects → real git, real
smart-HTTP, credential injected at the host boundary.

## How it works

```
host (trusted)                          client / sandbox (never sees the token)

git push
  └─ pushInsteadOf rewrite
     http://127.0.0.1:3721/owner/repo.git ──► git-push-bridge
                                               ├─ strip client headers (incl. Authorization)
                                               ├─ token = $(TOKEN_CMD)      fresh per request
                                               ├─ Authorization: Basic base64(USER:token)
                                               └─ https://github.com/owner/repo.git
                                                  TLS ends here ◄── pack streams both ways
```

- **Streaming**: request and response are piped, a pack is never buffered.
- **Token lifetime**: fetched per request — rotation picked up automatically,
  never written to disk, never logged (log = timestamp, method, path, status).
- **Browser guard**: requests carrying `Origin` / `Sec-Fetch-Site` → 403; a web
  page must not be able to drive an authenticated push.
- **Push-scoped rewrite**: `pushInsteadOf`, not `insteadOf` — fetch, clone and
  `ls-remote` keep going direct (or through the MCP), only push is redirected.

## Install

```sh
cp git-push-bridge.mjs git-push-bridge.sh ~/.local/bin/
git-push-bridge.sh up      # nohup; log /tmp/opencode/git-push-bridge.log
git-push-bridge.sh status  # up (pid N), port 3721: 200
```

### Optional: systemd user unit

Documented, not installed — `nohup` (above) is the default and is enough while
you are around. To outlive reboots:

```ini
# ~/.config/systemd/user/git-push-bridge.service
[Unit]
Description=git-push-bridge - loopback git push credential bridge

[Service]
ExecStart=/usr/bin/env node %h/.local/bin/git-push-bridge.mjs
Restart=on-failure

[Install]
WantedBy=default.target
```

```sh
systemctl --user daemon-reload
systemctl --user enable --now git-push-bridge
systemctl --user status git-push-bridge
journalctl --user -u git-push-bridge -f   # unit owns stdout/stderr now
```

- A unit does not inherit your shell `PATH`: if node is version-managed
  (mise, nvm), add its bin dir via `Environment=PATH=...` or point
  `ExecStart` at node's absolute path (`command -v node`).
- Extra instances (e.g. GitLab on 3722) = their own unit file with
  `Environment=PORT=3722` / `TARGET=gitlab.com` / `TOKEN_CMD=...` lines.
- Once the unit exists, drive it with `systemctl` — `git-push-bridge.sh
  status` still works (it only probes the port), `up`/`down` would fight it.

## Example: GitHub (`gh`)

Default configuration, no env needed — `TARGET=github.com`, `TOKEN_CMD='gh auth token'`,
`BASIC_USER=x-access-token`, `PORT=3721`.

```sh
git-push-bridge.sh up && git-push-bridge.sh status   # expect 200

# point one repo at the bridge (rewrite travels with the repo)
git -C <repo> config --local \
  url."http://127.0.0.1:3721/".pushInsteadOf https://github.com/

git push origin main
# To http://127.0.0.1:3721/<owner>/<repo>.git
```

Session-scoped alternative — no repo config change, rewrite only lives in the
launch environment (this is how a sandbox receives it, see *Sandboxes*):

```sh
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='url.http://127.0.0.1:3721/.pushInsteadOf'
export GIT_CONFIG_VALUE_0='https://github.com/'
```

Host-wide alternative — no repo config, no exports, set once; every push
from that host goes through the bridge (so keep it up, or `--unset`):

```sh
git config --global url."http://127.0.0.1:3721/".pushInsteadOf https://github.com/
```

Check auth without pushing anything:

```sh
# unauthenticated: 401, via bridge (token injected): 200
curl -s -o /dev/null -w '%{http_code}\n' 'https://github.com/<o>/<r>.git/info/refs?service=git-receive-pack'
curl -s -o /dev/null -w '%{http_code}\n' 'http://127.0.0.1:3721/<o>/<r>.git/info/refs?service=git-receive-pack'
```

## Example: GitLab (`gitlab.com`)

Same bridge, three env knobs. No PAT required: **any command that prints the
token works**, and git's credential store already holds yours (glab's web
login wrote it there).

```sh
# one instance per forge — port must differ from the github one
export TOKEN_CMD="printf 'protocol=https\nhost=gitlab.com\n\n' | git credential fill | sed -n 's/^password=//p'"
nohup env PORT=3722 TARGET=gitlab.com BASIC_USER=oauth2 TOKEN_CMD="$TOKEN_CMD" \
  node ~/.local/bin/git-push-bridge.mjs >/tmp/opencode/gitlab-bridge.log 2>&1 &

git -C <repo> config --local url."http://127.0.0.1:3722/".pushInsteadOf https://gitlab.com/
git push origin main
# To http://127.0.0.1:3722/<owner>/<repo>.git
```

Notes: `BASIC_USER=oauth2` is GitLab's documented username for OAuth tokens
(your own username also works). Against a repo you may not push, GitLab
answers `403 You are not allowed to push code to this project` with valid
creds vs `401` with bad ones.

## Knobs

| env        | default         | meaning                                  |
|------------|-----------------|------------------------------------------|
| `PORT`     | `3721`          | loopback port the rewrite must point at  |
| `TARGET`   | `github.com`    | forge host, TLS terminated there         |
| `TOKEN_CMD`| `gh auth token` | any command printing the token           |
| `BASIC_USER`| `x-access-token`| username half of the Basic header        |
| `DENY_REFS` | *(off)*         | refs to refuse pushes to (see *Hardening*) |

`git-push-bridge.sh` pins `PORT=3721` for its own instance — ambient env can't
move the port the rewrite points at.

## Gotchas

- **Bridge down = push hangs** (on this WSL box a closed loopback port drops
  instead of refusing). `git-push-bridge.sh status` first, always.
- Repo-local rewrite also redirects pushes you run **on the host** — keep the
  bridge up, or use the session-env variant if you only want it inside a session.
- `502` = `TOKEN_CMD` failed or upstream error; the log has the reason.
- Started with `nohup`: survives nothing (run `up` again after reboot/logout).
  For reboots, see the optional unit under *Install* — documented, not installed.

## Sandboxes

**Not an MCP server** — nothing registers in any config, no tools appear in
the agent's toolset; the client is plain `git`. A sandbox can push the
moment three things hold: the bridge is up on the host (`up`), the port is
granted (`open_port`), and the URL rewrite reaches git's environment (the
`allow_vars` entries + exports below). Then `git push` just works.

The whole point: the bridge lives on the host, the sandbox only needs to
*reach* the loopback port and *receive* the URL rewrite. The token itself
never crosses that boundary — `TOKEN_CMD` runs host-side in the bridge.

**omac** — sandbox network/env policy lives in the machine-global file
`~/.config/omac/sandbox-profiles/default.json` (not in any profile's config):

```json
{
  "open_port": [3719, 3721],
  "environment": {
    "allow_vars": ["GIT_CONFIG_COUNT", "GIT_CONFIG_KEY_0", "GIT_CONFIG_VALUE_0"]
  }
}
```

- `open_port: [3721]` lets the sandbox talk to the bridge;
  `allow_vars` passes exactly the three rewrite vars in — exact names, not
  a `GIT_CONFIG_*` wildcard, so nothing else from the host env can ride
  along (add `GIT_CONFIG_KEY_1` / `_VALUE_1` if you ever need a second
  rewrite slot):

```sh
export GIT_CONFIG_COUNT=1
export GIT_CONFIG_KEY_0='url.http://127.0.0.1:3721/.pushInsteadOf'
export GIT_CONFIG_VALUE_0='https://github.com/'
```

- The sandboxed `git config` stays untouched (omac grants repo config
  read-only), the token stays host-side, and only push is redirected.

Any other sandboxed setup needs the same two things: outbound access to
`127.0.0.1:3721` and the rewrite passed via environment.

## Security notes (honest)

This is two files of PoC plumbing, not a hardened product:

- **The listener is unauthenticated.** Anything that can reach
  `127.0.0.1:3721` can push wherever the token may push. The mitigations
  are loopback binding, the browser guard, and the sandbox port grant —
  there is no per-repo or per-caller check inside the bridge.
- **If the bridge process is compromised, the token is too** — it shells
  out to `TOKEN_CMD` on the host. Same trust level as running `gh` there.
- Loopback traffic is plain HTTP (local only); TLS to the forge terminates
  in the bridge.
- Token handling is the one hardened part: fetched per request, lives only
  in the outbound `Authorization` header, never logged, never returned.
- No audits, no authz tests. Keep the port on loopback.

## Hardening: protect `main` (optional)

Ships **off** — a hobby setup wants pushes to `main` to just work. One knob
flips it, e.g. when the corporate hat goes on:

```sh
export DENY_REFS='refs/heads/main'   # in the environment `up` runs in
git-push-bridge.sh down && git-push-bridge.sh up   # restart picks it up
```

The gate parses only the command section of a push request, refuses a
listed ref with `403` *before* the token is fetched, and fails closed
(oversized or unparsable = refuse); everything else streams through
unchanged. Entries are exact ref names, comma/space separated.

Scope of the gate: pushes that **route through the bridge** — i.e. the
agent's session. A human pushing straight at the forge never crosses the
bridge and keeps full `gh` / `glab` power; that human-vs-agent split is
the point. Need `main` protected against everyone, including direct
pushes: forge-side branch protection in the web UI is the only layer that
binds those (no MCP tool configures it).

## Scope

Push-only plumbing: no rules file, no caching, reads never touch this listener.
