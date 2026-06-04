'use client'

import { useCurrentVisualObj } from '../editor/useVisualObjRegistry'
import { TransportContext } from './TransportContext'
import TransportBar from './TransportBar'
import { useTransport } from './useTransport'

export default function TransportHost() {
  const visualObj = useCurrentVisualObj()
  const transport = useTransport(visualObj)

  return (
    <TransportContext.Provider value={transport}>
      <TransportBar />
    </TransportContext.Provider>
  )
}
