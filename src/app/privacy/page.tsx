import type { Metadata } from 'next'
import LegalContent from '@/components/legal/LegalContent'
import { PRIVACY_MARKDOWN } from '@/lib/legal/content'

// Public, indexable legal page (like /help).
export const metadata: Metadata = {
  title: 'Privacy Policy — sheet-llm',
  description:
    'How sheet-llm collects, uses, and shares your data: what we store, our subprocessors (including the AI provider), international transfers, retention, and your GDPR/CCPA rights.',
}

export default function PrivacyPage() {
  return <LegalContent crumb="Privacy Policy" markdown={PRIVACY_MARKDOWN} />
}
