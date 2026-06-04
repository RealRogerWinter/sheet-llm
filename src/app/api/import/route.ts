import { NextResponse } from 'next/server'
import { z } from 'zod'
import {
  appendMessages,
  createConversation,
} from '@/lib/llm/conversations'
import { getRequestUser } from '@/lib/auth/session'
import { attachRecoveryHeader } from '@/lib/auth/attachRecovery'
import type { AssistantContentBlock, UserContentBlock } from '@/lib/llm/wrapper'
import { RENDER_SCORE_TOOL_NAME } from '@/lib/llm/renderScoreTool'
import { ValidationError } from '@/lib/music/errors'
import { scoreToAbc } from '@/lib/music/scoreToAbc'
import { BLANK_SCORE } from '@/lib/music/types'
import { validateAbc, validateScore } from '@/lib/music/validateScore'
import {
  detectFormat,
  hasBlockingWarnings,
  importScore,
  type ImportResult,
  type ImportWarning,
} from '@/lib/music/import'
import type { ImportFormat } from '@/lib/shared/types'
import { checkRequestIp, extractClientIp } from '@/lib/orchestrator/requestRateLimit'
import type {
  ImportErrorResponse,
  ImportResponse,
  ImportWarningWire,
} from '@/lib/shared/types'
import {
  checkSameOrigin,
  errorResponse,
  synthToolUseId,
} from '@/app/api/chat/route'

export const runtime = 'nodejs'
export const maxDuration = 30

// Body caps: JSON path covers ABC + Score JSON + pasted MusicXML (verbose
// XML — a real `.musicxml` paste runs hundreds of KB, so the cap is 1 MB).
// Multipart path covers MIDI binaries and uploaded `.musicxml` files up to
// ~2 MB — large enough for full-piece captures / exports without inviting DoS.
const MAX_JSON_BYTES = 1 * 1024 * 1024
const MAX_MULTIPART_BYTES = 2 * 1024 * 1024

const SYNTH_USER_PROMPT_BY_FORMAT: Record<ImportFormat, string> = {
  abc: 'I have an existing ABC score I would like to work with.',
  midi: 'I have an existing MIDI file I would like to work with.',
  json: 'I have an existing score I would like to work with.',
  musicxml: 'I have an existing MusicXML score I would like to work with.',
  blank: 'I am starting a blank score and would like to compose.',
}

function introTextFor(format: ImportFormat, filename: string | undefined): string {
  const source = filename ? `\`${filename}\`` : 'your file'
  switch (format) {
    case 'abc':
      return `Loaded ABC from ${source}.`
    case 'midi':
      return `Loaded MIDI from ${source}.`
    case 'json':
      return `Loaded score from ${source}.`
    case 'musicxml':
      return `Loaded MusicXML from ${source}.`
    case 'blank':
      return 'Started a blank score. Add notes or ask me for help.'
  }
}

const JsonImportSchema = z
  .object({
    format: z.enum(['abc', 'json', 'musicxml', 'blank']),
    text: z.string().max(MAX_JSON_BYTES).optional(),
    filename: z.string().max(255).optional(),
    truncateIfLong: z.boolean().optional(),
    layoutOverride: z.enum(['single', 'grand-staff', 'satb']).optional(),
  })
  .refine(
    // `blank` skips the parser entirely (server seeds with BLANK_SCORE)
    // so it doesn't need `text`. Every other format requires non-empty
    // text.
    (d) => d.format === 'blank' || (typeof d.text === 'string' && d.text.length > 0),
    { message: 'text is required for non-blank formats' },
  )

function warningsToWire(warnings: ImportWarning[]): ImportWarningWire[] {
  return warnings.map((w) => ({
    severity: w.severity,
    code: w.code,
    message: w.message,
    ...(w.meta ? { meta: w.meta } : {}),
  }))
}

function importErrorResponse(warnings: ImportWarning[], primaryMessage: string) {
  const body: ImportErrorResponse = {
    code: 'import_failed',
    error: primaryMessage,
    warnings: warningsToWire(warnings),
  }
  return NextResponse.json(body, { status: 422 })
}

/**
 * Read multipart form-data into the pieces we care about. Next 16
 * request.formData() handles the heavy lifting; we just pluck and
 * type-check.
 */
async function readMultipart(request: Request): Promise<
  | { ok: true; file: File; truncateIfLong: boolean; layoutOverride?: 'single' | 'grand-staff' | 'satb' }
  | { ok: false; res: ReturnType<typeof errorResponse> }
> {
  let fd: FormData
  try {
    fd = await request.formData()
  } catch {
    return { ok: false, res: errorResponse('invalid_request', 400, 'Could not read multipart body') }
  }
  const file = fd.get('file')
  if (!(file instanceof File)) {
    return { ok: false, res: errorResponse('invalid_request', 400, 'Missing or invalid `file` field') }
  }
  if (file.size > MAX_MULTIPART_BYTES) {
    return { ok: false, res: errorResponse('invalid_request', 413, 'File too large') }
  }
  const truncRaw = fd.get('truncateIfLong')
  const truncateIfLong = truncRaw === 'true' || truncRaw === '1'
  const layoutRaw = fd.get('layoutOverride')
  const layoutOverride =
    layoutRaw === 'single' || layoutRaw === 'grand-staff' || layoutRaw === 'satb'
      ? layoutRaw
      : undefined
  return { ok: true, file, truncateIfLong, ...(layoutOverride ? { layoutOverride } : {}) }
}

async function runImportFromFile(
  file: File,
  truncateIfLong: boolean,
  layoutOverride?: 'single' | 'grand-staff' | 'satb',
): Promise<
  | { ok: true; result: ImportResult; format: ImportFormat; filename: string }
  | { ok: false; res: ReturnType<typeof errorResponse> }
  | { ok: false; res: NextResponse }
> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  const sample = bytes.subarray(0, 64)
  // For text-shaped files (.abc / .json) we also peek at the text head
  // for detectFormat's content sniff.
  let textHead: string | undefined
  try {
    textHead = new TextDecoder().decode(sample)
  } catch {
    textHead = undefined
  }
  const detected = detectFormat({ filename: file.name, mime: file.type, bytes, text: textHead })
  if (detected === 'xml-unsupported') {
    return {
      ok: false,
      res: importErrorResponse(
        [
          {
            severity: 'block',
            code: 'parse_failed',
            message:
              'Compressed MusicXML (.mxl) is not supported. Export or save an uncompressed .musicxml file and try again.',
          },
        ],
        'Compressed MusicXML (.mxl) is not supported — use an uncompressed .musicxml file.',
      ),
    }
  }
  if (detected === 'unknown') {
    return {
      ok: false,
      res: importErrorResponse(
        [
          {
            severity: 'block',
            code: 'parse_failed',
            message: `Could not detect format from filename "${file.name}" or content. Use a .abc, .mid, .json, or .musicxml file.`,
          },
        ],
        'Could not detect file format.',
      ),
    }
  }
  const result = importScore(
    detected,
    detected === 'midi' ? { bytes } : { text: new TextDecoder().decode(bytes) },
    { truncateIfLong, ...(layoutOverride ? { layoutOverride } : {}) },
  )
  return { ok: true, result, format: detected, filename: file.name }
}

/**
 * Seed a fresh conversation with the imported score in the same shape
 * a successful LLM turn would produce, so subsequent /api/chat
 * refinements can anchor to the synthetic tool_use_id.
 *
 * Mirrors the fork route's seeding pattern (synthetic user prompt +
 * assistant text+tool_use). The synthetic user prompt is required by
 * the Anthropic Messages API's strict user-first alternation rule —
 * a bare `[assistant]` transcript would be rejected the moment a
 * refinement turn is added.
 */
async function seedConversation(
  userId: string,
  score: ImportResult['score'],
  format: ImportFormat,
  filename: string | undefined,
): Promise<{ chatId: string; toolUseId: string; introText: string }> {
  const introText = introTextFor(format, filename)
  const chatId = await createConversation(userId)
  const toolUseId = synthToolUseId()
  const userContent: UserContentBlock[] = [
    { type: 'text', text: SYNTH_USER_PROMPT_BY_FORMAT[format] },
  ]
  const assistantContent: AssistantContentBlock[] = [
    { type: 'text', text: introText },
    {
      type: 'tool_use',
      id: toolUseId,
      name: RENDER_SCORE_TOOL_NAME,
      input: score as unknown as Record<string, unknown>,
    },
  ]
  await appendMessages(
    userId,
    chatId,
    [
      { role: 'user', content: userContent },
      { role: 'assistant', content: assistantContent },
    ],
    { scoreSource: 'import' },
  )
  return { chatId, toolUseId, introText }
}

/**
 * POST /api/import — parse an uploaded score and seed a fresh chat
 * session with it.
 *
 * - multipart/form-data with `file` (and optional `truncateIfLong=true`):
 *   used for binary MIDI uploads and large ABC files.
 * - application/json `{ format: 'abc'|'json', text, filename?,
 *   truncateIfLong? }`: used for the paste-text and small-text path.
 *
 * Never calls the LLM. Works identically with or without
 * ANTHROPIC_API_KEY — local dev (stub mode) is fully supported.
 */
export async function POST(request: Request) {
  const origin = checkSameOrigin(request)
  if (!origin.ok) return origin.res
  // Per-IP rate limit (import parses uploads; shares the expensive-route budget
  // with /api/chat). The client IP comes from CF-Connecting-IP behind Cloudflare.
  if (!checkRequestIp(extractClientIp(request)).ok) {
    return errorResponse('rate_limited', 429, 'Too many requests — please slow down and try again shortly.')
  }
  const t0 = Date.now()
  // Resolve identity up-front so the seed conversation has an owner.
  const session = await getRequestUser()
  const { userId } = session

  const contentType = request.headers.get('content-type') ?? ''
  const isMultipart = contentType.includes('multipart/form-data')

  let result: ImportResult
  let format: ImportFormat
  let filename: string | undefined

  if (isMultipart) {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > MAX_MULTIPART_BYTES) {
      return errorResponse('invalid_request', 413, 'Request body too large')
    }
    const mp = await readMultipart(request)
    if (!mp.ok) return mp.res
    const parsed = await runImportFromFile(mp.file, mp.truncateIfLong, mp.layoutOverride)
    if (!parsed.ok) return parsed.res
    result = parsed.result
    format = parsed.format
    filename = parsed.filename
  } else {
    const declared = Number(request.headers.get('content-length') ?? '0')
    if (declared > MAX_JSON_BYTES) {
      return errorResponse('invalid_request', 413, 'Request body too large')
    }
    let raw: string
    try {
      raw = await request.text()
    } catch {
      return errorResponse('invalid_request', 400, 'Could not read request body')
    }
    if (raw.length > MAX_JSON_BYTES) {
      return errorResponse('invalid_request', 413, 'Request body too large')
    }
    let parsed
    try {
      parsed = JsonImportSchema.parse(JSON.parse(raw))
    } catch {
      return errorResponse('invalid_request', 400, 'Invalid request body')
    }
    format = parsed.format
    filename = parsed.filename
    if (parsed.format === 'blank') {
      // Skip parsing entirely — seed with the canonical empty score.
      // The downstream validateScore + validateAbc + seedConversation
      // pipeline still runs, mirroring how an LLM/import-produced score
      // would land. The result.format here is a stub (parser-side
      // ImportFormat doesn't include 'blank' — no parser ever produces
      // it); the wire-level `format` variable above is the source of
      // truth for what we report back and what seedConversation uses.
      result = { score: BLANK_SCORE, warnings: [], format: 'json' }
    } else {
      result = importScore(
        parsed.format,
        { text: parsed.text! },
        {
          truncateIfLong: parsed.truncateIfLong ?? false,
          ...(parsed.layoutOverride ? { layoutOverride: parsed.layoutOverride } : {}),
        },
      )
    }
  }

  if (hasBlockingWarnings(result)) {
    const firstBlock = result.warnings.find((w) => w.severity === 'block')
    return importErrorResponse(result.warnings, firstBlock?.message ?? 'Import failed.')
  }

  // Semantic validation (durations sum to meter, tuplets complete,
  // etc.). Parser already runs schema validation; this catches the
  // measure-duration consistency the schema can't express.
  try {
    validateScore(result.score)
  } catch (e) {
    if (e instanceof ValidationError) {
      return importErrorResponse(
        [
          ...result.warnings,
          { severity: 'block', code: 'schema_invalid', message: e.message },
        ],
        e.message,
      )
    }
    throw e
  }

  // Transpile to ABC and re-validate via abcjs. This is the same
  // post-LLM check the chat route performs.
  let abc: string
  try {
    abc = scoreToAbc(result.score)
    await validateAbc(abc)
  } catch (e) {
    if (e instanceof ValidationError) {
      return importErrorResponse(
        [
          ...result.warnings,
          { severity: 'block', code: 'parse_failed', message: e.message },
        ],
        e.message,
      )
    }
    throw e
  }

  const { chatId, toolUseId, introText } = await seedConversation(
    userId,
    result.score,
    format,
    filename,
  )

  const body: ImportResponse = {
    chatId,
    abc,
    introText,
    scoreJson: result.score,
    toolUseId,
    warnings: warningsToWire(result.warnings),
    importFormat: format,
    ...(filename ? { filename } : {}),
  }
  // Stamp latency in a header so the debug panel can surface it
  // without inflating the response shape.
  return attachRecoveryHeader(
    NextResponse.json(body, {
      headers: { 'X-Import-Latency-Ms': String(Date.now() - t0) },
    }),
    session,
  )
}
