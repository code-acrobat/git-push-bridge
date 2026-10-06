#!/usr/bin/env node
// git smart-HTTP -> loopback push bridge. The client only ever sees
// http://127.0.0.1:<PORT>/ (url.*.pushInsteadOf); the token is fetched on the
// host per request and injected here, so it never reaches the client.
// Defaults = GitHub via `gh`; for GitLab: TARGET=gitlab.com BASIC_USER=oauth2
// and a TOKEN_CMD that prints the token (see README.md).
// DENY_REFS='refs/heads/main' refuses pushes naming those refs with 403
// before any token lookup or upstream contact (agents route through here,
// humans don't — see README "Hardening").
// ponytail: plain nohup start; promote to a systemd user unit if it must survive reboots.
import http from "node:http"
import https from "node:https"
import { execSync } from "node:child_process"

const PORT = Number(process.env.PORT || 3721)
const TARGET = process.env.TARGET || "github.com"
const TOKEN_CMD = process.env.TOKEN_CMD || "gh auth token"
const BASIC_USER = process.env.BASIC_USER || "x-access-token"
const DENY_SPEC = process.env.DENY_REFS || ""
const MAX_CMDS = 1 << 20 // command sections are tiny; 1 MB of one is an attack, not a push
const HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "proxy-authorization",
  "proxy-connection",
])

const token = () => execSync(TOKEN_CMD, { encoding: "utf8" }).trim()

// exact names or `*`-prefix globs, comma/space separated; empty spec = never matches
function makeDenier(spec) {
  const pats = spec.split(/[\s,]+/).filter(Boolean)
  return (ref) => pats.some((p) => (p.endsWith("*") ? ref.startsWith(p.slice(0, -1)) : ref === p))
}
const denyRef = makeDenier(DENY_SPEC)

// Push command section: pkt-lines up to the flush-pkt. Returns the ref names,
// null while more bytes are needed, false if malformed (caller fails closed).
// v0 form `<old> SP <new> SP <refname>` (optional capability list); `refname=` also parsed.
function parseCommands(buf) {
  const refs = []
  let i = 0
  while (i + 4 <= buf.length) {
    const head = buf.toString("ascii", i, i + 4)
    if (!/^[0-9a-f]{4}$/i.test(head)) return false
    const len = parseInt(head, 16)
    if (len === 0) return refs // flush-pkt: end of the command section
    if (len === 1) { i += 4; continue } // delimiter-pkt
    if (len < 4) return false
    const end = i + len
    if (end > buf.length) return null // incomplete pkt-line, wait for more
    const line = buf.toString("utf8", i + 4, end).replace(/\n$/, "")
    if (line.startsWith("refname=")) refs.push(line.slice(8).trim())
    else {
      const f = line.split(" ")
      if (f.length >= 3 && f[2].startsWith("refs/")) refs.push(f[2])
    }
    i = end
  }
  return null
}

// Read only the command section, decide, then either refuse (nothing leaves
// this process) or hand the buffered prefix + the rest of the stream to forward().
function gate(req, res, next) {
  let buf = Buffer.alloc(0)
  let settled = false
  const settle = () => {
    settled = true
    req.removeListener("data", onData)
    req.removeListener("end", onEnd)
  }
  const refuse = (why) => {
    settle()
    console.log(`${new Date().toISOString()} DENIED ${req.url} (${why})`)
    if (!res.headersSent) res.writeHead(403, { "content-type": "text/plain" })
    res.end(`push-bridge: ${why}\n`)
    req.resume() // drain whatever else the client keeps sending
  }
  const onData = (chunk) => {
    if (settled) return
    buf = Buffer.concat([buf, chunk])
    if (buf.length > MAX_CMDS) return refuse(`command section over ${MAX_CMDS} bytes`)
    const refs = parseCommands(buf)
    if (refs === null) return // need more bytes
    settle()
    if (refs === false) return refuse("unparseable command section")
    const hit = refs.find(denyRef)
    if (hit) return refuse(`DENY_REFS matched ${hit}`)
    next(buf)
  }
  const onEnd = () => {
    if (!settled) refuse("no command section")
  }
  req.on("data", onData)
  req.on("end", onEnd)
}

function forward(req, res, prefix) {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) {
    const key = k.toLowerCase()
    if (key === "host" || key === "authorization" || HOP.has(key)) continue
    headers[k] = v
  }
  try {
    headers.authorization = `Basic ${Buffer.from(`${BASIC_USER}:${token()}`).toString("base64")}`
  } catch (e) {
    res.writeHead(502, { "content-type": "text/plain" })
    res.end(`token lookup failed: ${e.message}`)
    return
  }
  headers["user-agent"] = "push-bridge"

  const up = https.request(
    { hostname: TARGET, port: 443, path: req.url, method: req.method, headers },
    (ures) => {
      const rh = {}
      for (const [k, v] of Object.entries(ures.headers)) {
        if (!HOP.has(k.toLowerCase())) rh[k] = v
      }
      console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${ures.statusCode}`)
      res.writeHead(ures.statusCode ?? 502, rh)
      ures.pipe(res) // pack data; never buffer
    },
  )
  up.on("error", (e) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" })
    res.end(String(e))
  })
  if (prefix && prefix.length) up.write(prefix) // command section already read by gate()
  req.pipe(up) // streams the pack; never buffer
  if (req.readableEnded) up.end() // tiny body fully read before pipe attached
}

if (process.argv.includes("--selftest")) {
  const pkt = (s) => Buffer.from((s.length + 4).toString(16).padStart(4, "0") + s)
  const flush = Buffer.from("0000")
  const oid1 = "0".repeat(40)
  const oid2 = "1".repeat(40)
  const eq = (got, want, msg) => {
    if (JSON.stringify(got) !== JSON.stringify(want)) {
      console.error(`FAIL ${msg}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`)
      process.exit(1)
    }
  }
  eq(parseCommands(Buffer.concat([pkt(`${oid1} ${oid2} refs/heads/main\n`), flush])),
    ["refs/heads/main"], "v0 create")
  eq(parseCommands(pkt(`${oid1} ${oid2} refs/heads/main report-status-v2\n`)), null,
    "incomplete until flush")
  eq(parseCommands(Buffer.concat([
      pkt(`${oid1} ${oid2} refs/heads/a\n`),
      pkt(`${oid1} ${oid2} refs/heads/main\n`),
      flush])),
    ["refs/heads/a", "refs/heads/main"], "two updates")
  eq(parseCommands(Buffer.concat([pkt("refname=refs/heads/main\n"), flush])),
    ["refs/heads/main"], "refname= form")
  eq(parseCommands(Buffer.from("zzzz")), false, "malformed header")
  eq(parseCommands(pkt("garbage\n")), null, "non-pkt garbage without flush")
  const d = makeDenier("refs/heads/main, refs/heads/release-*")
  eq([d("refs/heads/main"), d("refs/heads/main2"), d("refs/heads/release-1"), d("refs/heads/feature")],
    [true, false, true, false], "denier exact + glob")
  eq(makeDenier("")("refs/heads/main"), false, "empty spec = off")
  console.log("selftest ok")
  process.exit(0)
}

http.createServer((req, res) => {
  // Browsers are not clients here: block requests carrying fetch metadata.
  // (An unauthenticated web page must not be able to drive an authenticated push.)
  if (req.headers.origin || req.headers["sec-fetch-site"]) {
    res.writeHead(403, { "content-type": "text/plain" })
    res.end("browser requests are not allowed")
    return
  }
  if (DENY_SPEC && req.method === "POST" && req.url.split("?")[0].endsWith("/git-receive-pack")) {
    gate(req, res, (buf) => forward(req, res, buf))
    return
  }
  forward(req, res)
}).listen(PORT, "127.0.0.1", () => {
  console.log(`push-bridge on 127.0.0.1:${PORT} -> https://${TARGET}/ ${DENY_SPEC ? `DENY_REFS=${DENY_SPEC}` : ""}`)
})
