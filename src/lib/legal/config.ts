// Server-only runtime configuration for the legal pages (/terms, /privacy).
//
// The Terms of Service and Privacy Policy can only be published once the
// operator's identifying details are known, so they are driven by three
// REQUIRED environment variables. If any is unset/blank the pages 404 and the
// UI links are hidden — we never want to surface a legal document that still
// says "[LEGAL ENTITY]".
//
//   SL_LEGAL_ENTITY        e.g. "Jane Doe" or "Acme GmbH" — the operator's
//                          registered legal name (controller under GDPR).
//   SL_LEGAL_ADDRESS       the operator's business/registered address.
//   SL_LEGAL_JURISDICTION  governing law / forum, e.g. "Germany" — also used
//                          for the tax-records retention reference.
//
// Read fresh per request (the pages set `dynamic = 'force-dynamic'`), so a
// change in /opt/sheet-llm/.env takes effect on the next request after the
// container reloads the env — no image rebuild. Reads happen at RUNTIME, not
// build time (CI has no env), mirroring the Turnstile runtime-config pattern.

export interface LegalConfig {
  entity: string
  address: string
  jurisdiction: string
}

/**
 * Returns the resolved legal config, or `null` if any required value is
 * missing. `null` means: do not surface the legal pages or their links.
 */
export function getLegalConfig(): LegalConfig | null {
  const entity = process.env.SL_LEGAL_ENTITY?.trim()
  const address = process.env.SL_LEGAL_ADDRESS?.trim()
  const jurisdiction = process.env.SL_LEGAL_JURISDICTION?.trim()
  if (!entity || !address || !jurisdiction) return null
  return { entity, address, jurisdiction }
}

/** True iff all three required SL_LEGAL_* values are set. */
export function isLegalEnabled(): boolean {
  return getLegalConfig() !== null
}

/**
 * Substitute the operator details into a legal-document Markdown template.
 * Uses split/join (not String.replaceAll) to stay within the repo's ES2017
 * lib target.
 */
export function renderLegalDoc(markdown: string, cfg: LegalConfig): string {
  return markdown
    .split('{{LEGAL_ENTITY}}')
    .join(cfg.entity)
    .split('{{BUSINESS_ADDRESS}}')
    .join(cfg.address)
    .split('{{JURISDICTION}}')
    .join(cfg.jurisdiction)
}
