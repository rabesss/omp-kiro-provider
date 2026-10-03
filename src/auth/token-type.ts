/**
 * Kiro credential types.
 *
 * Kiro API keys (`ksk_…`) must be declared with `TokenType: API_KEY`, as kiro-cli does. Without it
 * the API treats the key as an OAuth access token and rejects it (403 "The bearer token included
 * in the request is invalid."). OAuth access tokens must not carry the header.
 */

export function isKiroApiKey(token: string): boolean {
  return token.startsWith("ksk_")
}

export function kiroTokenTypeHeaders(token: string): Record<string, string> {
  return isKiroApiKey(token) ? { TokenType: "API_KEY" } : {}
}
