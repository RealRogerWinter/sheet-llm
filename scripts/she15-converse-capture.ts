/**
 * SHE-15 CONVERSE-OUTPUT capture harness.
 *
 * Drives the orchestrator's CONVERSE (music-tutor Q&A) path for ONE model
 * over a fixed set of questions about a small sample Score, and writes the
 * full streamed text answers to disk for HUMAN review. This is a SUBJECTIVE
 * eval — there is NO pass/fail scoring. A reviewer reads the per-model .md
 * and judges answer quality across models.
 *
 * Model selection mirrors the SHE-15 matrix pattern: route the stack with
 * PROVIDER_<TIER> env (PROVIDER_MEDIUM is the one converse uses — it pins
 * tier 'medium') and pin the model id with SL_EVAL_MODEL_OVERRIDE. With no
 * env set, you get the ambient default (Anthropic Sonnet 4.6).
 *
 * It calls `runConverse` directly (the handler), which deterministically
 * returns an OrchestratorConverseStream WITHOUT going through the
 * classifier/dispatcher — so a question can never be mis-routed to an edit
 * handler. The handler still honors the same selectProvider seam + the
 * SL_EVAL_MODEL_OVERRIDE override the live matrix uses, so the model under
 * test is identical to what the live path would pick.
 *
 * Usage (one model per run):
 *   # Sonnet 4.6 baseline (ambient default — no provider env)
 *   SL_NEW_TOOL_DISPATCH=1 SL_CONVERSE_OUT=evals/results/she15-converse/baseline.md \
 *     tsx scripts/she15-converse-capture.ts
 *
 *   # Anthropic Haiku
 *   SL_NEW_TOOL_DISPATCH=1 PROVIDER_MEDIUM=anthropic \
 *     SL_EVAL_MODEL_OVERRIDE=claude-haiku-4-5-20251001 \
 *     SL_CONVERSE_OUT=evals/results/she15-converse/haiku.md \
 *     tsx scripts/she15-converse-capture.ts
 *
 *   # Groq llama-3.1-8b-instant
 *   SL_NEW_TOOL_DISPATCH=1 PROVIDER_MEDIUM=groq PROVIDER_FALLBACK=groq \
 *     SL_EVAL_MODEL_OVERRIDE=llama-3.1-8b-instant \
 *     SL_CONVERSE_OUT=evals/results/she15-converse/llama-3.1-8b.md \
 *     tsx scripts/she15-converse-capture.ts
 *
 *   # Groq gpt-oss-20b
 *   SL_NEW_TOOL_DISPATCH=1 PROVIDER_MEDIUM=groq PROVIDER_FALLBACK=groq \
 *     SL_EVAL_MODEL_OVERRIDE=openai/gpt-oss-20b \
 *     SL_CONVERSE_OUT=evals/results/she15-converse/gpt-oss-20b.md \
 *     tsx scripts/she15-converse-capture.ts
 *
 * Requires ANTHROPIC_API_KEY (Anthropic rows) and/or GROQ_API_KEY (Groq rows).
 * Spends money on real provider calls — there is no dry-run here; just don't
 * run it if you don't intend to spend.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Score } from '@/lib/music/types'
import type { Classification } from '@/lib/orchestrator/types'
import type { TextStreamEvent } from '@/lib/providers/types'
import { runConverse } from '@/lib/orchestrator/handlers/converse'

/** Deterministic converse classification — bypasses classifier uncertainty. */
const CONVERSE_CLASSIFICATION: Classification = {
  kind: 'converse',
  scope: 'snippet',
  complexity: 'simple',
  confidence: 1,
}

// --- Sample scores -------------------------------------------------------
// Two small, recognizable diatonic melodies in C major, 4/4, treble clef.
// Both are ~4 bars so a reviewer can sanity-check every factual answer by eye.

/**
 * Sample A — an ascending/descending C-major scale fragment that lands on a
 * clear authentic-cadence shape: a simple, instantly-recognizable melody so
 * factual answers (key/meter/bar count) and contour answers are verifiable.
 */
const SAMPLE_SCALE: Score = {
  title: 'C Major Scale Phrase',
  key: 'C',
  meter: '4/4',
  clef: 'treble',
  tempo_bpm: 96,
  measures: [
    {
      events: [
        { kind: 'note', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { kind: 'note', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'C', octave: 5 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { kind: 'note', pitches: [{ step: 'B', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { kind: 'note', pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
        { kind: 'note', pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
      ],
    },
  ],
}

/**
 * Sample B — the opening of "Twinkle, Twinkle, Little Star": a melody every
 * reviewer knows by ear, so a model's identification / contour / cadence
 * answers can be judged without re-deriving the theory.
 */
const SAMPLE_TWINKLE: Score = {
  title: 'Twinkle Opening',
  key: 'C',
  meter: '4/4',
  clef: 'treble',
  tempo_bpm: 100,
  measures: [
    {
      events: [
        { kind: 'note', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'C', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'G', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { kind: 'note', pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'A', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'G', octave: 4 }], duration: 'half' },
      ],
    },
    {
      events: [
        { kind: 'note', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'F', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'E', octave: 4 }], duration: 'quarter' },
      ],
    },
    {
      events: [
        { kind: 'note', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'D', octave: 4 }], duration: 'quarter' },
        { kind: 'note', pitches: [{ step: 'C', octave: 4 }], duration: 'half' },
      ],
    },
  ],
}

interface CaptureQuestion {
  id: string
  /** Which sample score the question is asked against. */
  scoreLabel: string
  score: Score
  /** factual | analytical | creative — for the reviewer's grouping. */
  category: 'factual' | 'analytical' | 'creative'
  question: string
}

// ~8 questions spanning factual / analytical / creative. The phrasing is
// verbatim user-style — converse.ts keeps the question's exact wording.
const QUESTIONS: CaptureQuestion[] = [
  // Factual — verifiable by eye against the score literal above.
  {
    id: 'q1-key-meter',
    scoreLabel: 'SCALE',
    score: SAMPLE_SCALE,
    category: 'factual',
    question: 'What key and time signature is this piece in?',
  },
  {
    id: 'q2-bar-count',
    scoreLabel: 'SCALE',
    score: SAMPLE_SCALE,
    category: 'factual',
    question: 'How many measures are there, and how many beats are in the last measure?',
  },
  {
    id: 'q3-identify-tune',
    scoreLabel: 'TWINKLE',
    score: SAMPLE_TWINKLE,
    category: 'factual',
    question: 'Do you recognize this melody? What is the first and last note?',
  },
  // Analytical.
  {
    id: 'q4-contour',
    scoreLabel: 'SCALE',
    score: SAMPLE_SCALE,
    category: 'analytical',
    question:
      'Describe the melodic contour of this phrase. Where does it peak and how does it resolve?',
  },
  {
    id: 'q5-cadence',
    scoreLabel: 'TWINKLE',
    score: SAMPLE_TWINKLE,
    category: 'analytical',
    question:
      'What kind of cadence does this melody end on, and which scale degrees outline it?',
  },
  {
    id: 'q6-harmony',
    scoreLabel: 'TWINKLE',
    score: SAMPLE_TWINKLE,
    category: 'analytical',
    question:
      'Suggest a simple chord progression to harmonize this melody. Give chord symbols per measure with their constituent notes.',
  },
  // Creative.
  {
    id: 'q7-continuation',
    scoreLabel: 'SCALE',
    score: SAMPLE_SCALE,
    category: 'creative',
    question:
      'Suggest a four-measure melodic continuation that would make a satisfying B phrase. Describe it in prose with note names.',
  },
  {
    id: 'q8-mood-style',
    scoreLabel: 'TWINKLE',
    score: SAMPLE_TWINKLE,
    category: 'creative',
    question:
      'What mood does this melody convey, and what musical style or arrangement would suit it?',
  },
]

interface CaptureRecord {
  id: string
  scoreLabel: string
  category: string
  question: string
  answerText: string
  model: string
  latencyMs: number
  /** Present when the question errored or returned a non-converse outcome. */
  error?: string
}

/**
 * Consume a converse stream exactly once and assemble the full answer text.
 * The stream yields message-start, zero+ text-delta, then exactly one
 * terminal message-stop (carrying finalText) or an error event. We prefer
 * finalText off message-stop and fall back to the accumulated deltas.
 */
async function collectStreamText(events: AsyncIterable<TextStreamEvent>): Promise<string> {
  let acc = ''
  for await (const ev of events) {
    if (ev.type === 'text-delta') {
      acc += ev.delta
    } else if (ev.type === 'message-stop') {
      return ev.finalText ?? acc
    } else if (ev.type === 'error') {
      throw ev.error
    }
    // message-start carries no text — ignore.
  }
  return acc
}

function describeError(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`
  try {
    return String(e)
  } catch {
    return 'unknown error'
  }
}

/**
 * Run one question through converse. Never throws — on any failure (provider
 * error, stream error, missing textStream, an outcome that somehow isn't a
 * converse stream) it records the failure gracefully so the run continues.
 */
async function captureOne(q: CaptureQuestion, modelOverride: string | undefined): Promise<CaptureRecord> {
  const t0 = Date.now()
  try {
    const outcome = runConverse({
      classification: CONVERSE_CLASSIFICATION,
      chatId: `she15-converse-${q.id}`,
      userText: q.question,
      editedScore: q.score,
      history: [],
      ...(modelOverride !== undefined ? { modelOverride } : {}),
    })

    // Defensive guard: the handler signature guarantees a converse_stream,
    // but record gracefully if the contract is ever violated.
    if (outcome.outcomeKind !== 'converse_stream') {
      return {
        id: q.id,
        scoreLabel: q.scoreLabel,
        category: q.category,
        question: q.question,
        answerText: '',
        model: modelOverride ?? '(ambient default)',
        latencyMs: Date.now() - t0,
        error: `non-converse outcome: ${String((outcome as { outcomeKind?: unknown }).outcomeKind)}`,
      }
    }

    const answerText = await collectStreamText(outcome.events)
    return {
      id: q.id,
      scoreLabel: q.scoreLabel,
      category: q.category,
      question: q.question,
      answerText,
      model: outcome.model,
      latencyMs: Date.now() - t0,
    }
  } catch (e) {
    return {
      id: q.id,
      scoreLabel: q.scoreLabel,
      category: q.category,
      question: q.question,
      answerText: '',
      model: modelOverride ?? '(ambient default)',
      latencyMs: Date.now() - t0,
      error: describeError(e),
    }
  }
}

function sanitize(s: string): string {
  return s.replace(/[^a-z0-9._-]/gi, '_')
}

function renderMdSection(rec: CaptureRecord, index: number): string {
  const lines: string[] = []
  lines.push(`## Q${index + 1}. ${rec.question}`)
  lines.push('')
  lines.push(
    `- **id:** \`${rec.id}\` · **category:** ${rec.category} · **score:** ${rec.scoreLabel} · ` +
      `**model:** \`${rec.model}\` · **latency:** ${rec.latencyMs}ms`,
  )
  lines.push('')
  if (rec.error) {
    lines.push(`> **ERROR:** ${rec.error}`)
  } else if (rec.answerText.trim() === '') {
    lines.push('> _(empty answer)_')
  } else {
    lines.push(rec.answerText.trim())
  }
  lines.push('')
  return lines.join('\n')
}

async function main(): Promise<number> {
  const modelOverride = process.env.SL_EVAL_MODEL_OVERRIDE || undefined
  const modelLabel = modelOverride ?? '(ambient default — Sonnet 4.6)'
  const providerMedium = process.env.PROVIDER_MEDIUM ?? 'anthropic (default)'

  const outFile = process.env.SL_CONVERSE_OUT
    ? path.resolve(process.cwd(), process.env.SL_CONVERSE_OUT)
    : path.resolve(
        process.cwd(),
        'evals',
        'results',
        'she15-converse',
        `${sanitize(modelOverride ?? 'baseline')}.md`,
      )
  const jsonlFile = outFile.replace(/\.md$/i, '') + '.jsonl'

  mkdirSync(path.dirname(outFile), { recursive: true })

  console.log('SHE-15 converse capture')
  console.log(`  model override : ${modelLabel}`)
  console.log(`  PROVIDER_MEDIUM: ${providerMedium}`)
  console.log(`  questions      : ${QUESTIONS.length}`)
  console.log(`  md  -> ${outFile}`)
  console.log(`  jsonl -> ${jsonlFile}\n`)

  // Fresh files per run.
  const header =
    `# SHE-15 Converse Capture\n\n` +
    `- **model:** \`${modelLabel}\`\n` +
    `- **PROVIDER_MEDIUM:** \`${providerMedium}\`\n` +
    `- **captured:** ${new Date().toISOString()}\n` +
    `- **questions:** ${QUESTIONS.length}\n\n` +
    `Subjective eval — read the answers and judge quality. No pass/fail scoring.\n\n` +
    `---\n\n`
  writeFileSync(outFile, header)
  writeFileSync(jsonlFile, '')

  let errorCount = 0
  for (let i = 0; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i]
    process.stdout.write(`[${i + 1}/${QUESTIONS.length}] ${q.id} ... `)
    const rec = await captureOne(q, modelOverride)
    if (rec.error) {
      errorCount++
      console.log(`ERROR (${rec.error})`)
    } else {
      console.log(`ok (${rec.latencyMs}ms, ${rec.answerText.length} chars)`)
    }
    appendFileSync(outFile, renderMdSection(rec, i) + '\n')
    appendFileSync(jsonlFile, JSON.stringify(rec) + '\n')
  }

  console.log(
    `\nDone. ${QUESTIONS.length - errorCount}/${QUESTIONS.length} answered, ${errorCount} errors.`,
  )
  console.log(`Review: ${outFile}`)
  // Capture run never fails the process on per-question errors — they're
  // recorded inline for the reviewer. Exit 0 unless EVERYTHING errored.
  return errorCount === QUESTIONS.length ? 1 : 0
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    // Last-resort guard: should be unreachable since captureOne never throws.
    console.error('FATAL (unexpected — capture loop should not throw):', describeError(e))
    process.exit(1)
  })
