import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import LegalContent from '@/components/legal/LegalContent'
import { PRIVACY_MARKDOWN } from '@/lib/legal/content'
import { getLegalConfig, renderLegalDoc } from '@/lib/legal/config'

// Read SL_LEGAL_* from the runtime env (not build time — CI has no env).
export const dynamic = 'force-dynamic'

// Public, indexable legal page (like /help).
export const metadata: Metadata = {
  title: 'Privacy Policy — sheet-llm',
  description:
    'How sheet-llm collects, uses, and shares your data: what we store, our subprocessors (including the AI provider), international transfers, retention, and your GDPR/CCPA rights.',
}

export default function PrivacyPage() {
  const cfg = getLegalConfig()
  // Don't surface the document until the operator details are configured.
  if (!cfg) notFound()
  return <LegalContent crumb="Privacy Policy" markdown={renderLegalDoc(PRIVACY_MARKDOWN, cfg)} />
}
