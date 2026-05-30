/**
 * Machine fingerprint generation for Kiro API anti-detection.
 *
 * Generates a stable SHA-256 hash from hostname + username, matching
 * the pattern used by kiro-gateway and the real Kiro IDE.
 *
 * This fingerprint is included in User-Agent and x-amz-user-agent headers
 * to identify a specific installation — identical to how Kiro IDE does it.
 */

import { createHash } from "node:crypto"
import { hostname } from "node:os"

let _cached: string | undefined

export function getMachineFingerprint(): string {
  if (_cached) return _cached

  try {
    const host = hostname()
    const user = process.env.USER ?? process.env.LOGNAME ?? "unknown"
    const raw = `${host}-${user}-kiro`
    _cached = createHash("sha256").update(raw).digest("hex")
  } catch {
    _cached = createHash("sha256").update("default-omp-kiro").digest("hex")
  }

  return _cached!
}
