const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { BTP_EXE } = require("./btp-exe.cts");

const COOKIE_NAME = "bdmsid";
const SESSION_ID_PATTERN = /^[0-9a-f-]{36}$/;
const SESSIONS_ROOT = path.join(os.tmpdir(), "btp-drift-monitor-sessions");

interface HttpRequestLike {
  headers: { cookie?: string };
}

interface HttpResponseLike {
  setHeader(name: string, value: string): void;
}

function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * Identifies the caller's isolated btp CLI session: reads the session id from a cookie, or mints
 * and sets a new one. Every browser tab/user gets its own id, so two people using this app at the
 * same time never share a `btp login` identity (see getSessionConfigPath below).
 */
function getSessionId(req: HttpRequestLike, res: HttpResponseLike): string {
  const existing = parseCookie(req.headers.cookie, COOKIE_NAME);
  if (existing && SESSION_ID_PATTERN.test(existing)) return existing;

  const sessionId = crypto.randomUUID();
  res.setHeader("Set-Cookie", `${COOKIE_NAME}=${sessionId}; Path=/; HttpOnly; SameSite=Lax`);
  return sessionId;
}

const initializedSessions = new Set<string>();

/**
 * Path to this session's own `btp` CLI config file (`--config <path>` on every invocation) — never
 * shared with any other session, so each browser session's `btp login` state, target global
 * account, and provisioned credentials stay fully isolated from every other user of this app.
 */
function getSessionConfigPath(sessionId: string): string {
  const dir = path.join(SESSIONS_ROOT, sessionId);
  const configPath = path.join(dir, "config.json");

  if (!initializedSessions.has(sessionId)) {
    fs.mkdirSync(dir, { recursive: true });
    if (!fs.existsSync(configPath)) {
      // Force the OS-level secure store off for this config — otherwise the login token could land
      // in a shared OS credential store instead of staying isolated inside this session's own file.
      spawnSync(BTP_EXE, ["--config", configPath, "set", "config", "--login.securestore", "false"], {
        timeout: 10000,
        windowsHide: true,
      });
    }
    initializedSessions.add(sessionId);
  }
  return configPath;
}

module.exports = { getSessionId, getSessionConfigPath };
