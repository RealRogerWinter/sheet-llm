import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import LegalContent from '@/components/legal/LegalContent'
import { TERMS_MARKDOWN } from '@/lib/legal/content'
import { getLegalConfig, renderLegalDoc } from '@/lib/legal/config'

// Read SL_LEGAL_* from the runtime env (not build time — CI has no env).
export const dynamic = 'force-dynamic'

// Public, indexable legal page (like /help).
export const metadata: Metadata = {
  title: 'Terms of Service — sheet-llm',
  description:
    'The terms governing your use of sheet-llm: accounts, acceptable use, AI output disclaimers, credits and payments, refunds, and your rights.',
}

export default function TermsPage() {
  const cfg = getLegalConfig()
  // Don't surface the document until the operator details are configured.
  if (!cfg) notFound()
  return <LegalContent crumb="Terms of Service" markdown={renderLegalDoc(TERMS_MARKDOWN, cfg)} />
}
