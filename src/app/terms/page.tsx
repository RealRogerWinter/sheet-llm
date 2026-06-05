import type { Metadata } from 'next'
import LegalContent from '@/components/legal/LegalContent'
import { TERMS_MARKDOWN } from '@/lib/legal/content'

// Public, indexable legal page (like /help).
export const metadata: Metadata = {
  title: 'Terms of Service — sheet-llm',
  description:
    'The terms governing your use of sheet-llm: accounts, acceptable use, AI output disclaimers, credits and payments, refunds, and your rights.',
}

export default function TermsPage() {
  return <LegalContent crumb="Terms of Service" markdown={TERMS_MARKDOWN} />
}
