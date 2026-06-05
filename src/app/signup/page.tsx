import type { Metadata } from 'next'
import SignupContent from './SignupContent'
import { isLegalEnabled } from '@/lib/legal/config'

// Read SL_LEGAL_* at runtime so the legal links reflect the live env.
export const dynamic = 'force-dynamic'

export const metadata: Metadata = {
  title: 'Sign up — sheet-llm',
  robots: { index: false, follow: false },
}

export default function SignupPage() {
  return <SignupContent legalEnabled={isLegalEnabled()} />
}
