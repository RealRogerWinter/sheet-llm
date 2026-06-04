import { NextResponse } from 'next/server'

/**
 * Liveness probe for the container HEALTHCHECK, the Caddy reverse proxy, and
 * external uptime monitors.
 *
 * Intentionally STATIC — it does NOT touch the database. DB readiness is already
 * enforced at process boot by the FATAL migration + WAL-replication gate in
 * `src/lib/db` (the server refuses to start, and crash-loops, if the database or
 * its replication is unhealthy). So a 200 here means "the Node server is up and
 * serving"; an unhealthy DB never reaches a serving state in the first place.
 *
 * Kept uncached (`force-dynamic`) and excluded from Cloudflare's cache so the
 * probe always hits the origin.
 */
export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export function GET() {
  return NextResponse.json({ status: 'ok' }, { status: 200 })
}
