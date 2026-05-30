/**
 * Kiro OAuth provider for OMP's /login flow.
 *
 * OMP's OAuthCredentials uses `expires` (not `expiresAt`) and has no
 * method/clientId/region fields. We store Kiro-specific auth metadata
 * in a sidecar JSON file at ~/.omp/agent/kiro-auth-meta.json.
 *
 * Auth sources (in preference order):
 * 1. kiro-cli SQLite database (preferred — always fresh, actively maintained)
 * 2. Kiro IDE ~/.aws/sso/cache/kiro-auth-token.json (fallback)
 * 3. API Key (ksk_xxx)
 * 4. OIDC device code flow (Builder ID browser login)
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import { join, dirname } from "node:path"
import { homedir } from "node:os"
import { execFileSync } from "node:child_process"

import type { KiroAuthMeta } from "./types.ts"
import { runDeviceCodeFlow } from "./auth/device-flow.ts"
import { refreshKiroToken } from "./auth/token-refresh.ts"

export type { OAuthLoginCallbacks } from "./types.ts"

const FAR_FUTURE_MS = 10 * 365 * 24 * 60 * 60 * 1000
const DEFAULT_REGION = "us-east-1"
const META_PATH = join(homedir(), ".omp", "agent", "kiro-auth-meta.json")

// ---------------------------------------------------------------------------
// Sidecar metadata persistence
// ---------------------------------------------------------------------------

function readMeta(): KiroAuthMeta | null {
  try {
    if (!existsSync(META_PATH)) return null
    return JSON.parse(readFileSync(META_PATH, "utf-8")) as KiroAuthMeta
  } catch {
    return null
  }
}

function writeMeta(meta: KiroAuthMeta): void {
  try {
    const dir = dirname(META_PATH)
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
    writeFileSync(META_PATH, JSON.stringify(meta, null, 2), { mode: 0o600 })
  } catch {
    // Best effort
  }
}

// ---------------------------------------------------------------------------
// OMP-compatible credentials shape
// ---------------------------------------------------------------------------

interface OMPCredentials {
  access: string
  refresh: string
  expires: number
}

function credentialsFromApiKey(apiKey: string): OMPCredentials {
  writeMeta({ method: "apikey" })
  return { access: apiKey, refresh: apiKey, expires: Date.now() + FAR_FUTURE_MS }
}

/** Remove terminal paste wrappers, surrounding whitespace, control chars. */
export function sanitizeApiKey(input: string): string {
  return input
    .replace(/^['"`]+|['"`]+$/g, "")
    .replace(/[\x00-\x1F\x7F]/g, "")
    .trim()
}

// ---------------------------------------------------------------------------
// kiro-cli SQLite reader (primary auth source)
// ---------------------------------------------------------------------------

interface CliToken {
  access_token: string
  refresh_token: string
  expires_at: string
  region: string
  start_url: string
}

interface CliRegistration {
  client_id: string
  client_secret: string
  region: string
}

interface CliProfile {
  arn: string
  profileName: string
}

function sqlite3Json(dbPath: string, query: string): unknown | null {
  try {
    const out = execFileSync("sqlite3", [dbPath, "-json", query], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    if (!out.trim()) return null
    const rows = JSON.parse(out) as unknown[]
    return rows.length > 0 ? rows[0] : null
  } catch {
    return null
  }
}

function sqlite3Raw(dbPath: string, query: string): string | null {
  try {
    const out = execFileSync("sqlite3", [dbPath, query], {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    })
    return out.trim() || null
  } catch {
    return null
  }
}

const CLI_DB_PATHS = [
  join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3"),
  join(homedir(), ".local", "share", "amazon-q", "data.sqlite3"),
]

/**
 * Read credentials from kiro-cli's SQLite database.
 * This is the preferred auth source — kiro-cli keeps tokens fresh.
 */
function tryReadCliCredentials(): { creds: OMPCredentials; meta: KiroAuthMeta } | null {
  for (const dbPath of CLI_DB_PATHS) {
    if (!existsSync(dbPath)) continue

    const tokenRaw = sqlite3Raw(dbPath, "SELECT value FROM auth_kv WHERE key='kirocli:odic:token';")
    if (!tokenRaw) continue

    try {
      const token = JSON.parse(tokenRaw) as CliToken
      if (!token.access_token || !token.refresh_token) continue

      const expiresAt = new Date(token.expires_at).getTime()

      // Read OIDC client registration (needed for refresh)
      const regRaw = sqlite3Raw(dbPath, "SELECT value FROM auth_kv WHERE key='kirocli:odic:device-registration';")
      let clientId: string | undefined
      let clientSecret: string | undefined
      if (regRaw) {
        try {
          const reg = JSON.parse(regRaw) as CliRegistration
          clientId = reg.client_id
          clientSecret = reg.client_secret
        } catch { /* skip */ }
      }

      // Read profile ARN
      let profileArn: string | undefined
      const profileRaw = sqlite3Raw(dbPath, "SELECT value FROM state WHERE key='api.codewhisperer.profile';")
      if (profileRaw) {
        try {
          const profile = JSON.parse(profileRaw) as CliProfile
          profileArn = profile.arn
        } catch { /* skip */ }
      }

      const meta: KiroAuthMeta = {
        method: "idc",
        region: token.region ?? DEFAULT_REGION,
        profileArn,
        clientId,
        clientSecret,
      }

      return {
        creds: {
          access: token.access_token,
          refresh: token.refresh_token,
          expires: expiresAt,
        },
        meta,
      }
    } catch {
      continue
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Kiro IDE fallback (reads ~/.aws/sso/cache/kiro-auth-token.json)
// ---------------------------------------------------------------------------

function tryReadIdeToken(): { creds: OMPCredentials; meta: KiroAuthMeta } | null {
  const cachePath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
  if (!existsSync(cachePath)) return null

  try {
    const raw = readFileSync(cachePath, "utf-8")
    const data = JSON.parse(raw) as {
      accessToken?: string
      refreshToken?: string
      expiresAt?: string | number
      region?: string
      profileArn?: string
      clientId?: string
      clientSecret?: string
    }

    if (!data.accessToken && !data.refreshToken) return null

    let expires: number
    if (typeof data.expiresAt === "string") expires = new Date(data.expiresAt).getTime()
    else if (typeof data.expiresAt === "number") expires = data.expiresAt
    else expires = 0

    const method = data.clientId ? "idc" : "social"
    const meta: KiroAuthMeta = {
      method,
      region: data.region ?? DEFAULT_REGION,
      profileArn: data.profileArn,
      clientId: data.clientId,
      clientSecret: data.clientSecret,
    }

    return {
      creds: { access: data.accessToken ?? "", refresh: data.refreshToken ?? "", expires },
      meta,
    }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Internal credentials adapter
// ---------------------------------------------------------------------------

interface FullCredentials {
  access: string
  refresh: string
  expiresAt: number
  method: string
  clientId?: string
  clientSecret?: string
  region?: string
  profileArn?: string
}

function toFull(creds: OMPCredentials, meta: KiroAuthMeta): FullCredentials {
  return {
    access: creds.access,
    refresh: creds.refresh,
    expiresAt: creds.expires,
    method: meta.method,
    clientId: meta.clientId,
    clientSecret: meta.clientSecret,
    region: meta.region,
    profileArn: meta.profileArn,
  }
}

function fromFull(full: FullCredentials): { creds: OMPCredentials; meta: KiroAuthMeta } {
  return {
    creds: { access: full.access, refresh: full.refresh, expires: full.expiresAt },
    meta: {
      method: full.method,
      clientId: full.clientId,
      clientSecret: full.clientSecret,
      region: full.region,
      profileArn: full.profileArn,
    },
  }
}

// ---------------------------------------------------------------------------
// Auto-detect: try CLI first, then IDE
// ---------------------------------------------------------------------------

function tryAutoDetect(): { creds: OMPCredentials; meta: KiroAuthMeta } | null {
  return tryReadCliCredentials() ?? tryReadIdeToken()
}

// ---------------------------------------------------------------------------
// Public: login()
// ---------------------------------------------------------------------------

export async function login(callbacks: import("./types.ts").OAuthLoginCallbacks): Promise<OMPCredentials | string> {
  // Auto-detect existing login
  const existing = tryAutoDetect()

  const autoHint = existing
    ? " (1: existing login detected)" 
    : ""

  const choice = await callbacks.onPrompt({
    message:
      "Choose login method:\n" +
      `1. Reuse existing login (kiro-cli or Kiro IDE)${existing ? " [DETECTED]" : ""}\n` +
      "2. Paste API Key (ksk_xxx)\n" +
      "3. Paste Refresh Token\n" +
      "4. Browser Login (Builder ID)\n" +
      "Enter 1-4:",
  })

  switch (choice.trim()) {
    case "1": {
      const detected = tryAutoDetect()
      if (!detected) {
        const dbPath = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3")
        const idePath = join(homedir(), ".aws", "sso", "cache", "kiro-auth-token.json")
        const details: string[] = []
        if (existsSync(dbPath)) {
          details.push(`kiro-cli DB exists at ${dbPath} but no valid token found (may need to run 'kiro' to log in)`)
        } else {
          details.push(`kiro-cli DB not found at ${dbPath}`)
        }
        if (existsSync(idePath)) {
          details.push(`Kiro IDE token exists at ${idePath} but could not be parsed`)
        } else {
          details.push(`Kiro IDE token not found at ${idePath}`)
        }
        throw new Error(
          "No existing Kiro login found:\n" + details.map(d => `  - ${d}`).join("\n") +
          "\nLog in with kiro-cli or Kiro IDE first, or use another method.",
        )
      }
      writeMeta(detected.meta)

      // If expired, refresh immediately
      if (detected.creds.expires <= Date.now()) {
        const refreshed = await refreshKiroToken(toFull(detected.creds, detected.meta))
        const result = fromFull(refreshed)
        writeMeta(result.meta)
        return result.creds
      }
      return detected.creds
    }

    case "2": {
      const raw = await callbacks.onPrompt({ message: "Paste your Kiro API Key (ksk_xxx):" })
      const apiKey = sanitizeApiKey(raw)
      if (!apiKey) throw new Error("No API key provided")
      return credentialsFromApiKey(apiKey)
    }

    case "3": {
      const raw = await callbacks.onPrompt({ message: "Paste your refresh token:" })
      const refreshToken = sanitizeApiKey(raw)
      if (!refreshToken) throw new Error("No refresh token provided")

      const regionRaw = await callbacks.onPrompt({ message: `Region (default: ${DEFAULT_REGION}):` })
      const region = regionRaw.trim() || DEFAULT_REGION

      writeMeta({ method: "social", region })
      return { access: "", refresh: refreshToken, expires: 0 }
    }

    case "4": {
      const full = await runDeviceCodeFlow(callbacks)
      const result = fromFull(full)
      writeMeta(result.meta)
      return result.creds
    }

    default:
      throw new Error(`Invalid choice: ${choice}`)
  }
}

// ---------------------------------------------------------------------------
// Public: refreshToken()
// ---------------------------------------------------------------------------

export async function refreshToken(credentials: OMPCredentials): Promise<OMPCredentials> {
  // For IDC auth, try to re-read from kiro-cli first (it manages its own refresh)
  const cliCreds = tryReadCliCredentials()
  if (cliCreds && cliCreds.creds.expires > Date.now()) {
    writeMeta(cliCreds.meta)
    return cliCreds.creds
  }

  // Fall back to stored metadata + manual refresh
  const meta = readMeta()
  if (!meta) throw new Error("No Kiro auth metadata found. Run /login first.")

  const refreshed = await refreshKiroToken(toFull(credentials, meta))
  const result = fromFull(refreshed)
  writeMeta(result.meta)
  return result.creds
}

// ---------------------------------------------------------------------------
// Public: getApiKey()
// ---------------------------------------------------------------------------

export function getApiKey(credentials: OMPCredentials): string {
  return credentials.access
}
