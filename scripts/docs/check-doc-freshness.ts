/**
 * Documentation freshness checker.
 *
 * Usage:
 *   pnpm docs:check [--report-only] [--json]
 *
 * Every doc under `docs/**​/*.md` carries YAML frontmatter pinning it to
 * the source files it describes:
 *
 *   ---
 *   source_paths:
 *     - src/lib/orchestrator/index.ts
 *   last_verified: 2026-05-30
 *   verified_against: 4359406      # git short SHA
 *   ---
 *
 * This script asks git whether any listed `source_path` has commits in
 * the range `verified_against..HEAD`. If so, the doc is STALE: the code
 * it documents moved on but the prose wasn't re-verified. It also flags
 * docs whose `source_paths` point at files that no longer exist, and
 * docs missing the required frontmatter fields.
 *
 * Why hand-rolled YAML: the frontmatter we emit is a fixed, tiny shape
 * (a few scalars plus one list of strings). Pulling a YAML dependency
 * for that would be the only runtime use of one in the repo, so we parse
 * the slice ourselves. The parser is intentionally strict and supports
 * only what the doc frontmatter actually uses.
 *
 * Exit code: non-zero when any stale or broken doc is found, so CI can
 * gate on it. `--report-only` always exits 0 (used by the informational
 * weekly/PR workflow). `--json` emits a machine-readable report instead
 * of the human ledger.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { readdirSync } from 'node:fs'
import { join, relative, sep, posix } from 'node:path'

interface CliArgs {
  reportOnly: boolean
  json: boolean
}

function parseArgs(argv: string[]): CliArgs {
  let reportOnly = false
  let json = false
  for (const a of argv) {
    if (a === '--report-only') {
      reportOnly = true
    } else if (a === '--json') {
      json = true
    } else if (a === '--help' || a === '-h') {
      printUsageAndExit(0)
    } else if (a.startsWith('--')) {
      console.error(`unknown flag: ${a}`)
      printUsageAndExit(1)
    }
  }
  return { reportOnly, json }
}

function printUsageAndExit(code: number): never {
  console.error('Usage: pnpm docs:check [--report-only] [--json]')
  process.exit(code)
}

// Repo root is the parent of scripts/docs/ (this file's directory).
const REPO_ROOT = join(import.meta.dirname, '..', '..')

const REQUIRED_FIELDS = ['source_paths', 'last_verified', 'verified_against'] as const

interface DocFrontmatter {
  source_paths?: string[]
  last_verified?: string
  verified_against?: string
}

interface DocReport {
  /** Doc path, repo-relative, POSIX separators. */
  doc: string
  missingFields: string[]
  /** source_paths that don't resolve to an existing file/dir on disk. */
  missingSources: string[]
  /** source_paths with commits since verified_against, + their commit count. */
  staleSources: Array<{ path: string; commits: number }>
}

/**
 * Recursively collect *.md files under `dir`, skipping node_modules and
 * any dot-directory (.claude, .git, .github is not under docs/ anyway).
 * Returns repo-relative POSIX paths.
 */
function globDocs(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const name = entry.name
    if (entry.isDirectory()) {
      if (name === 'node_modules' || name.startsWith('.')) continue
      out.push(...globDocs(join(dir, name)))
    } else if (entry.isFile() && name.endsWith('.md')) {
      out.push(toRepoPosix(join(dir, name)))
    }
  }
  return out
}

function toRepoPosix(absPath: string): string {
  return relative(REPO_ROOT, absPath).split(sep).join(posix.sep)
}

/**
 * Extract and parse the leading `---`-fenced YAML frontmatter block.
 * Returns null when the file has no frontmatter at all (the caller treats
 * that as "all required fields missing").
 *
 * Supported shapes only:
 *   key: scalar
 *   key:
 *     - item
 *     - item
 * Inline `#` comments and surrounding quotes are stripped. Anything more
 * exotic is out of scope by design — the doc template is fixed.
 */
function parseFrontmatter(raw: string): DocFrontmatter | null {
  // Normalize CRLF (Windows checkouts) so line splitting is uniform.
  const text = raw.replace(/\r\n/g, '\n')
  if (!text.startsWith('---\n')) return null
  const end = text.indexOf('\n---', 3)
  if (end === -1) return null
  const body = text.slice(4, end)
  const lines = body.split('\n')

  const fm: DocFrontmatter = {}
  let listTarget: string[] | null = null

  for (const rawLine of lines) {
    const line = stripComment(rawLine)
    if (line.trim() === '') continue

    // A `  - value` line continues the most-recently-opened list.
    const listMatch = /^\s*-\s+(.*)$/.exec(line)
    if (listMatch && listTarget) {
      listTarget.push(unquote(listMatch[1].trim()))
      continue
    }

    // A `key:` or `key: value` line.
    const kvMatch = /^([A-Za-z0-9_]+):\s*(.*)$/.exec(line)
    if (kvMatch) {
      const key = kvMatch[1]
      const value = kvMatch[2].trim()
      if (value === '') {
        // Opens a block list (e.g. `source_paths:`).
        if (key === 'source_paths') {
          fm.source_paths = []
          listTarget = fm.source_paths
        } else {
          listTarget = null
        }
      } else {
        listTarget = null
        if (key === 'last_verified') fm.last_verified = unquote(value)
        else if (key === 'verified_against') fm.verified_against = unquote(value)
        // Other scalar keys (title, status, ...) are ignored.
      }
      continue
    }

    // Unrecognized line — close any open list to avoid mis-attribution.
    listTarget = null
  }

  return fm
}

function stripComment(line: string): string {
  // Strip a trailing `# comment`. Frontmatter values here never contain
  // a literal '#', so a naive strip is safe and avoids a quote-state
  // machine.
  const idx = line.indexOf('#')
  return idx === -1 ? line : line.slice(0, idx)
}

function unquote(s: string): string {
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1)
  }
  return s
}

/**
 * Count commits touching `sourcePath` in the range
 * `verifiedAgainst..HEAD`. Uses `git log --oneline -- <path>`; the path
 * is passed after `--` so it's unambiguously a pathspec. Returns the
 * number of commits (0 = up to date).
 *
 * Throws if git itself errors (e.g. the SHA is unknown) — the caller
 * surfaces that as a per-doc error rather than silently treating the doc
 * as fresh.
 */
function countCommitsSince(verifiedAgainst: string, sourcePath: string): number {
  const out = execFileSync(
    'git',
    ['log', '--oneline', `${verifiedAgainst}..HEAD`, '--', sourcePath],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  const trimmed = out.trim()
  return trimmed === '' ? 0 : trimmed.split('\n').length
}

function buildReport(docPath: string): DocReport {
  const abs = join(REPO_ROOT, docPath)
  const raw = readFileSync(abs, 'utf8')
  const fm = parseFrontmatter(raw)

  const report: DocReport = {
    doc: docPath,
    missingFields: [],
    missingSources: [],
    staleSources: [],
  }

  if (!fm) {
    report.missingFields = [...REQUIRED_FIELDS]
    return report
  }

  for (const field of REQUIRED_FIELDS) {
    const v = fm[field]
    if (v === undefined || (Array.isArray(v) && v.length === 0)) {
      report.missingFields.push(field)
    }
  }

  const sourcePaths = fm.source_paths ?? []

  // Existence check is independent of the freshness check so a doc with a
  // renamed/deleted source still surfaces even if verified_against is
  // also missing.
  for (const sp of sourcePaths) {
    if (!existsSync(join(REPO_ROOT, sp))) {
      report.missingSources.push(sp)
    }
  }

  // Freshness only runs when we have a SHA to diff against.
  if (fm.verified_against) {
    for (const sp of sourcePaths) {
      // Skip non-existent sources — already reported above, and git would
      // just return 0 for a path with no history in range, masking it.
      if (report.missingSources.includes(sp)) continue
      let commits: number
      try {
        commits = countCommitsSince(fm.verified_against, sp)
      } catch (e) {
        // Surface an unknown SHA / git failure as a stale-style finding
        // so the doc isn't silently passed.
        report.staleSources.push({ path: sp, commits: -1 })
        if (process.env.SL_DOCS_DEBUG) {
          console.error(`[docs:check] git error for ${docPath} :: ${sp}:`, e)
        }
        continue
      }
      if (commits > 0) {
        report.staleSources.push({ path: sp, commits })
      }
    }
  }

  return report
}

function isClean(r: DocReport): boolean {
  return (
    r.missingFields.length === 0 &&
    r.missingSources.length === 0 &&
    r.staleSources.length === 0
  )
}

function main() {
  const args = parseArgs(process.argv.slice(2))

  const docsDir = join(REPO_ROOT, 'docs')
  if (!existsSync(docsDir)) {
    console.error(`[docs:check] no docs/ directory at ${docsDir}`)
    process.exit(args.reportOnly ? 0 : 1)
  }

  const docPaths = globDocs(docsDir).sort()
  const reports = docPaths.map(buildReport)

  const stale = reports.filter((r) => r.staleSources.length > 0)
  const broken = reports.filter((r) => r.missingSources.length > 0)
  const missingFm = reports.filter((r) => r.missingFields.length > 0)
  const hasProblems = stale.length > 0 || broken.length > 0 || missingFm.length > 0

  if (args.json) {
    const payload = {
      checked: reports.length,
      ok: reports.filter(isClean).length,
      stale: stale.map((r) => ({ doc: r.doc, sources: r.staleSources })),
      brokenSources: broken.map((r) => ({ doc: r.doc, sources: r.missingSources })),
      missingFrontmatter: missingFm.map((r) => ({ doc: r.doc, fields: r.missingFields })),
    }
    console.log(JSON.stringify(payload, null, 2))
  } else {
    console.log(`# Doc freshness — checked ${reports.length} doc(s)`)
    console.log('')

    if (missingFm.length > 0) {
      console.log(`## MISSING FRONTMATTER (${missingFm.length})`)
      for (const r of missingFm) {
        console.log(`  ${r.doc}`)
        console.log(`    missing: ${r.missingFields.join(', ')}`)
      }
      console.log('')
    }

    if (broken.length > 0) {
      console.log(`## BROKEN source_paths (${broken.length}) — file does not exist`)
      for (const r of broken) {
        console.log(`  ${r.doc}`)
        for (const sp of r.missingSources) {
          console.log(`    missing file: ${sp}`)
        }
      }
      console.log('')
    }

    if (stale.length > 0) {
      console.log(`## STALE (${stale.length}) — source changed since verified_against`)
      for (const r of stale) {
        console.log(`  ${r.doc}`)
        for (const s of r.staleSources) {
          if (s.commits < 0) {
            console.log(`    git error (bad verified_against SHA?): ${s.path}`)
          } else {
            console.log(`    ${s.commits} commit(s) since verified: ${s.path}`)
          }
        }
      }
      console.log('')
    }

    if (!hasProblems) {
      console.log('All docs fresh. ✔')
      console.log('')
    } else {
      console.log(
        'Re-read the changed source, update the doc prose, then bump ' +
          '`last_verified` (today) and `verified_against` (current HEAD short SHA).',
      )
      console.log('')
    }
  }

  if (hasProblems && !args.reportOnly) {
    process.exit(1)
  }
}

main()
