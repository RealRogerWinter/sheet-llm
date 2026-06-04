import type { Metadata } from 'next'
import { Suspense } from 'react'
import VerifyEmailContent from './VerifyEmailContent'

export const metadata: Metadata = {
  title: 'Verify email — sheet-llm',
  robots: { index: false, follow: false },
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <VerifyEmailContent />
    </Suspense>
  )
}
