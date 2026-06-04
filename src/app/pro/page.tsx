import type { Metadata } from 'next'
import ProWaitlistContent from './ProWaitlistContent'

// noindex, like /signup — a transient "coming soon" surface, not a marketing page.
export const metadata: Metadata = {
  title: 'Pro is coming — sheet-llm',
  robots: { index: false, follow: false },
}

export default function ProPage() {
  return <ProWaitlistContent />
}
