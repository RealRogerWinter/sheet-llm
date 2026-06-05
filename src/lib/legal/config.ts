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
// Two more values are substituted into the text but NOT required (they have
// sensible defaults at the site's own domain, so the pages stay publishable):
//
//   SL_LEGAL_CONTACT_EMAIL  support/general contact (default support@sheetllm.com)
//   SL_LEGAL_PRIVACY_EMAIL  privacy/data-rights contact (default privacy@sheetllm.com)
//
// Read fresh per request (the pages set `dynamic = 'force-dynamic'`), so a
// change in /opt/sheet-llm/.env takes effect on the next request after the
// container reloads the env — no image rebuild. Reads happen at RUNTIME, not
// build time (CI has no env), mirroring the Turnstile runtime-config pattern.

const DEFAULT_CONTACT_EMAIL = 'support@sheetllm.com'
const DEFAULT_PRIVACY_EMAIL = 'privacy@sheetllm.com'

export interface LegalConfig {
  entity: string
  address: string
  jurisdiction: string
  contactEmail: string
  privacyEmail: string
}

/**
 * Returns the resolved legal config, or `null` if any REQUIRED value (entity,
 * address, jurisdiction) is missing. `null` means: do not surface the legal
 * pages or their links. The two contact emails fall back to their defaults.
 */
export function getLegalConfig(): LegalConfig | null {
  const entity = process.env.SL_LEGAL_ENTITY?.trim()
  const address = process.env.SL_LEGAL_ADDRESS?.trim()
  const jurisdiction = process.env.SL_LEGAL_JURISDICTION?.trim()
  if (!entity || !address || !jurisdiction) return null
  return {
    entity,
    address,
    jurisdiction,
    contactEmail: process.env.SL_LEGAL_CONTACT_EMAIL?.trim() || DEFAULT_CONTACT_EMAIL,
    privacyEmail: process.env.SL_LEGAL_PRIVACY_EMAIL?.trim() || DEFAULT_PRIVACY_EMAIL,
  }
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
    .split('{{CONTACT_EMAIL}}')
    .join(cfg.contactEmail)
    .split('{{PRIVACY_EMAIL}}')
    .join(cfg.privacyEmail)
}
