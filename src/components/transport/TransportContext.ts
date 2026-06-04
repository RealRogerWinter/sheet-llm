'use client'

import { createContext, useContext } from 'react'
import type { TransportState } from './useTransport'

export const TransportContext = createContext<TransportState | null>(null)

export function useTransportContext(): TransportState {
  const v = useContext(TransportContext)
  if (!v) {
    throw new Error('useTransportContext must be used within a TransportHost')
  }
  return v
}
