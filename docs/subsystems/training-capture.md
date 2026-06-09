---
title: Training-Data Capture & Export
subsystem: training-capture
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-09
verified_against: b4a4fa8
source_paths:
  - src/lib/orchestrator/trainingCapture.ts
  - src/lib/training/trainingExport.ts
  - src/lib/training/trainingRetention.ts
  - src/lib/orchestrator/observability.ts
  - src/lib/db/schema.ts
  - scripts/export-training-pairs.ts
  - scripts/trim-training-pairs.ts
related:
  - env-flags
  - persistence-db
  - orchestrator
---

# Training-Data Capture & Export

> **HOSTED-ONLY, OFF BY DEFAULT.** Capture exists only to build a training corpus
> from the public demo at **https://sheetllm.com**. It is **disabled by default**
> (`SL_CAPTURE_TRAINING` unset) — self-hosted / local installs never write a
> `training_pairs` row and never build a corpus, even though they run the same
> `orchestrator_turns` telemetry. Everything below applies only when an operator
> explicitly turns it on.
>
> ⚠️ **LEGAL GATE.** Building and running the capture/export tooling is decoupled
> from *using* the data. Exported data MUST NOT feed any fine-tune / distillation /
> teacher-data run until a **ToS / legal review** confirms the Terms of Service
> cover model-improvement use. The tooling can run now; the data is gated.

## Why (SHE-18)

SHE-16 (fine-tuning feasibility) found the #1 blocker was *"no training data and no
pipeline that captures it."* This subsystem removes that blocker: it captures
`(prompt → before-score → after-score, + quality signals)` interaction tuples on
the hosted demo and exports them as a clean, anonymized JSONL dataset — useful for
a future fine-tune AND, independently, for eval-corpus growth and regression sets.

## Architecture

The forensic `orchestrator_turns` row is the **source of truth** — PR1–PR3 enriched
it to hold the complete per-turn tuple. `training_pairs` is a thin, hosted-only
**consent marker** layered on top; the export joins back to the source tables and
anonymizes.

```
/api/chat turn
  └─ recordTurn()  (observability.ts)            [ALWAYS — core telemetry]
       ├─ INSERT orchestrator_turns              (prompt link, before/after score
       │                                          FKs, classification, diff,
       │                                          outcome, preservation, replacement)
       └─ captureTrainingPair()  (trainingCapture.ts)   [ONLY if SL_CAPTURE_TRAINING]
            └─ INSERT training_pairs              (turn_id FK + salted session_hash
                                                   + captured_at) — no content, no id

confirm-replacement / revert routes → recordTurnOutcome()  (turnOutcome.ts)
       └─ UPDATE orchestrator_turns.outcome      (accepted | reverted)

export-training-pairs (offline)  (trainingExport.ts)
  └─ training_pairs ⨝ orchestrator_turns ⨝ score_versions ⨝ messages
       → filter (usable) → anonymize → neutral JSONL
```

### The complete tuple on `orchestrator_turns`

| Datum | Column(s) | Added by |
| --- | --- | --- |
| Emitted score (after) | `after_score_version_id` → `score_versions` | PR1 (back-filled in the responder) |
| Before score | the after-version's `parent_version_id` | derived at export |
| User prompt | `messages` (via `score_version_id` link) | derived at export |
| Classification / model / tokens / diff | `classification_kind`, `handler_model`, `*_tokens`, `retained_event_ratio`, … | pre-existing |
| User decision | `outcome` (`accepted`/`reverted`/`superseded`) | PR2 |
| Preservation | `preservation_ok`, `preservation_mismatch_count` | PR3 |
| Replacement gate | `replacement_retained_identity_ratio`, `replacement_reasons`, `replacement_user_explicit_rewrite`, `replacement_blocked` | PR3 |

### `training_pairs` (the consent marker)

`id` PK · `turn_id` → `orchestrator_turns` **ON DELETE CASCADE** · `session_hash` ·
`captured_at` (ms). It stores **no** score/prompt content and **no** user identifier
— only the turn FK and `session_hash = sha256(SL_CAPTURE_SALT : sessionId)`, an
opaque, non-reversible dedup/grouping key (the raw session id — itself a random
UUID — and the user are never persisted here).

## Flags

| Var | Default | Meaning |
| --- | --- | --- |
| `SL_CAPTURE_TRAINING` | off | Master toggle. `1`/`true`/`on` marks turns for the corpus. Read fresh per request (`isFlagEnabled`). |
| `SL_CAPTURE_SALT` | empty | Per-deployment salt for `session_hash`. **Set a long random value when capture is on**, and **do not rotate it** while on (rotation breaks cross-turn session grouping in exports). |

The consent boundary is fail-closed: an unset/empty/unknown flag value is OFF, and
capture also sits behind the existing `!sessionId / 'anonymous'` guard in
`recordTurn` — two independent gates.

## Export

`pnpm export-training-pairs [--since <ms>] [--limit <n>] [--out <file>] [--watermark-file <path>]`

Joins the marker back to the source tables and emits one JSON object per line.
**Usable-turn filter:** a marker exists, `final_status='ok'`, an emitted score, and
NOT explicitly reverted (`outcome IS NULL` [implicitly kept] OR `'accepted'`).
Incremental + idempotent: a strictly-greater watermark on `captured_at`; the
`--watermark-file` makes it a single self-persisting cron command.

### Export row schema (neutral JSONL)

```json
{
  "id": "<turn uuid>", "sessionHash": "<opaque>",
  "userText": "add 4 bars with a ii-V-I",
  "beforeScore": { /* Score JSON, metadata-redacted, or null for fresh-gen */ },
  "afterScore":  { /* Score JSON, metadata-redacted */ },
  "classification": "edit_score_level", "model": "claude-sonnet-4-6",
  "outcome": "kept", "preservationOk": true, "retainedEventRatio": 0.83,
  "replacementBlocked": false, "replacementReasons": ["key C → Am"],
  "tokens": { "input": 0, "output": 0 }, "createdAt": 0
}
```

It round-trips through the live eval harness: `assertScoreInvariants` re-derives
preservation via `hashMeasure` on the exported before/after scores (see
`tests/unit/training/trainingExport.test.ts`).

## Anonymization policy

Asserted by `tests/unit/training/trainingAnonymization.test.ts` (seeds identity
sentinels into every joined field, asserts none survive).

**Stripped — never exported:**
- Identifiers: `session_id`, `user_id`, `message_id`, `request_id`, and the
  `error` column. The only session key that survives is the opaque `session_hash`.
- Score authorship free-text (`redactScore`): `title`, `composer`, `arranger`,
  `lyricist`, `copyright`, and `annotations` are removed from before/after scores.
  (None are part of `hashMeasure`, so the preservation round-trip is unaffected.)
- `replacement_reasons`: the `title '…' → '…'` variant is scrubbed (`scrubReasons`).

**Kept — documented free-text training signal, redaction DEFERRED:**
- `userText` (the raw prompt) and the score's musical free-text: per-event `lyrics`
  and the in-score performance labels `marker.tempo_text`, `volta.text`, and
  `span.endTempoText`. These are part of the musical content / training signal
  (and `lyrics` is part of the per-measure hash the round-trip depends on); they
  may contain free-text PII / copyrighted lyrics. A redaction pass over them is a
  deliberate follow-up, and the **legal gate** above governs any use regardless.
  (Only score-level *authorship* metadata — title/composer/arranger/lyricist/
  copyright + `annotations` — is stripped, not the musical labels.)

### Residual re-identification risk

`session_hash` is stable per session by design (dedup/grouping), so all of a
session's rows cluster together; combined with `createdAt` + scores this can
re-identify a session's full edit history *within the corpus*. This is intended but
is the residual risk operators must weigh before sharing/using a dataset. The salt
keeps the hash unlinkable across datasets to anyone without it — **so set the salt.**

## Retention

Two mechanisms bound the corpus, whichever is **shorter**:

1. **Marker TTL** — `pnpm trim:training-pairs [--max-age-days <n>]` (default 90)
   deletes `training_pairs` rows older than the window. Trimming a marker removes
   its turn from the export join (export-eligibility ends) WITHOUT deleting the
   source-of-truth `orchestrator_turns` row. Use a shorter window here to cap the
   corpus tighter than the turn log.
2. **Cascade from turn retention** — `pnpm trim:orchestrator-turns` (90d) deletes
   old turns, which drops their markers via `ON DELETE CASCADE` AND removes the
   score/prompt the export reads. So captured data is never exportable past the
   turn-retention horizon regardless of the marker TTL.

GDPR: the cascade chain `sessions → orchestrator_turns → training_pairs` means a
user/session erasure drops markers automatically.

## Scheduled export (runbook)

Capture runs on the hosted box; the export is an **operator-run, offline** job
there (the JSONL is sensitive — keep it off public paths). Schedule it with a host
cron using a watermark file so each run is incremental + self-persisting:

```cron
# daily at 04:00 — incremental export + marker retention (hosted box)
0 4 * * *  cd /app && pnpm -s export-training-pairs \
             --watermark-file /var/lib/sheetllm/train.watermark \
             --out /var/lib/sheetllm/exports/train-$(date +\%F).jsonl
30 4 * * *  cd /app && pnpm trim:training-pairs --max-age-days 90
```

`pnpm -s` (or invoking `tsx scripts/export-training-pairs.ts` directly) keeps stdout
pure JSONL; the `rows=/skipped=/watermark=` summary and the per-file count go to
stderr. A non-zero `skipped` flags stored scores that wouldn't parse — investigate.
