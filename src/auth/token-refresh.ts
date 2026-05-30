/**
 * Token refresh for Kiro — social (Google/GitHub) and AWS SSO OIDC (Builder ID).
 *
 * Both flows verified against kiro-gateway's KiroAuthManager and kiro-auto's
 * auth.ts. Consensus on endpoints, headers, and body format is documented in
 * the implementation plan.
 *
 * IMPORTANT for anti-detection:
 * - Social refresh uses KiroIDE User-Agent with fingerprint
 * - OIDC refresh uses plain Content-Type (no KiroIDE branding)
 * - Both use JSON body with camelCase field names
 */


const DEFAULT_REGION = "us-east-1"

// ---------------------------------------------------------------------------
// Internal credentials type (full form with method/clientId/region)
// ---------------------------------------------------------------------------

export interface RefreshCredentials {
  access: string
  refresh: string
  expiresAt: number
  method: string
  clientId?: string
  clientSecret?: string
  region?: string
  profileArn?: string
}

// ---------------------------------------------------------------------------
// Social refresh (Google / GitHub login)
// ---------------------------------------------------------------------------

async function refreshSocialToken(
  credentials: RefreshCredentials,
): Promise<RefreshCredentials> {
  const region = credentials.region ?? DEFAULT_REGION
  const url = `https://prod.${region}.auth.desktop.kiro.dev/refreshToken`

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": `aws-sdk-js/3.0.0 KiroIDE-0.1.0 os/linux lang/js md/nodejs/18.0.0`,
    },
    body: JSON.stringify({ refreshToken: credentials.refresh }),
  })
  if (!response.ok) {
    const text = await response.text().catch(() => "")
    if (text.includes("TEMPORARILY_SUSPENDED")) {
      throw new Error("Kiro account suspended. Check your Kiro account status.")
    }
    throw new Error(`Kiro social refresh failed (${response.status}): ${text.slice(0, 200)}`)
  }

  const data = await response.json() as {
    accessToken: string
    refreshToken?: string
    expiresIn?: number
    profileArn?: string
  }

  if (!data.accessToken) {
    throw new Error("Kiro social refresh returned no accessToken")
  }

  return {
    ...credentials,
    access: data.accessToken,
    refresh: data.refreshToken ?? credentials.refresh,
    expiresAt: Date.now() + (data.expiresIn ?? 3600) * 1000 - 60_000,
    profileArn: data.profileArn ?? credentials.profileArn,
  }
}

// ---------------------------------------------------------------------------
// AWS SSO OIDC refresh (Builder ID / IAM Identity Center)
// ---------------------------------------------------------------------------

async function refreshOidcToken(
  credentials: RefreshCredentials,
): Promise<RefreshCredentials> {
  if (!credentials.clientId || !credentials.clientSecret) {
    throw new Error("OIDC refresh requires clientId and clientSecret in credentials")
  }

  const region = credentials.region ?? DEFAULT_REGION
  const url = `https://oidc.${region}.amazonaws.com/token`

  const payload = {
    grantType: "refresh_token",
    clientId: credentials.clientId,
    clientSecret: credentials.clientSecret,
    refreshToken: credentials.refresh,
  }

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "aws-sdk-js/3.738.0 ua/2.1 os/other lang/js md/browser#unknown_unknown api/sso-oidc#3.738.0 m/E KiroIDE",
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const text = await response.text().catch(() => "")
    if (text.includes("TEMPORARILY_SUSPENDED")) {
      throw new Error("Kiro account suspended. Check your Kiro account status.")
    }
    throw new Error(`Kiro OIDC refresh failed (${response.status}): ${text.slice(0, 200)}`)
  }

  const data = await response.json() as {
    accessToken: string
    refreshToken?: string
    expiresIn?: number
  }

  if (!data.accessToken) {
    throw new Error("Kiro OIDC refresh returned no accessToken")
  }

  return {
    ...credentials,
    access: data.accessToken,
    refresh: data.refreshToken ?? credentials.refresh,
    expiresAt: Date.now() + (data.expiresIn ?? 3600) * 1000 - 60_000,
  }
}

// ---------------------------------------------------------------------------
// Unified refresh — routes by method
// ---------------------------------------------------------------------------

export async function refreshKiroToken(
  credentials: RefreshCredentials,
): Promise<RefreshCredentials> {
  if (credentials.method === "apikey") return credentials
  if (credentials.method === "idc") return refreshOidcToken(credentials)
  return refreshSocialToken(credentials)
}
