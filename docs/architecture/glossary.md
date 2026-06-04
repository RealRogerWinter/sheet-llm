---
title: Glossary — Domain and System Terms
subsystem: cross-cutting
audience: [contributor, ai-agent]
status: current
last_verified: 2026-06-03
verified_against: 150cb15
source_paths:
  - src/lib/music/types.ts
  - src/lib/orchestrator/README.md
  - src/lib/orchestrator/index.ts
  - src/lib/orchestrator/toolDispatch.ts
  - src/lib/orchestrator/generationTier.ts
  - src/lib/orchestrator/scoreVersion.ts
  - src/lib/music/scoreToAbcWithMap.ts
  - src/lib/chat/state.ts
  - src/lib/db/schema.ts
  - src/lib/providers/select.ts
  - src/lib/providers/sticky.ts
  - src/lib/providers/degradation.ts
  - src/lib/providers/callWithFailover.ts
  - src/lib/providers/types.ts
  - evals/README.md
related:
  - music-model
  - orchestrator
  - providers-llm
  - persistence-db
  - ghost-preview
  - abc-rendering
---

# Glossary

Alphabetized reference for the domain (music) and system terms that
recur across the codebase. Each entry is anchored to the file where
the term is actually defined or enforced — open that file before
relying on the definition. Music terms are taken from the Zod
schema doc-comments in `src/lib/music/types.ts`; system terms from the
orchestrator, providers, persistence, and chat-state subsystems.

Conventions:
- **(M)** = music-domain term, **(S)** = system/architecture term.
- Code pointers are `path:symbol` and are clickable from the repo root.

---

## A

**Acciaccatura vs Appoggiatura** (M)
Two kinds of grace note distinguished by a single boolean. In
`GraceNoteSchema` (`src/lib/music/types.ts:GraceNoteSchema`),
`slashed: true` is the *acciaccatura* — "crushed", takes no time from
the principal note; omitted/`false` is the *appoggiatura* — takes time
from the principal (traditionally half a binary value or two-thirds of
a dotted one). The renderer treats this as a notation distinction, not
a playback one — it does not redistribute durations.

**Accounts (claimed identity)** (S)
The optional user-account layer on top of the anonymous identity, dark
behind `SL_ACCOUNTS_ENABLED`. Signup **claims** the current anonymous
`users` row in place — sets `email` + `password_hash` (argon2id) +
`claimed_at` — so existing scores/sessions carry over with no data move.
Once `claimed_at` is set, the anonymous recovery-token path is refused
and a stale `sl_uid` no longer authenticates the account (it must log in
via the DB-backed revocable `sl_sess`). OAuth (Google/GitHub via
`arctic`) and single-use email-verify/reset tokens hang off the same
`users` row. Tables: `auth_sessions`, `oauth_accounts`, `auth_tokens`
(`src/lib/db/schema.ts`). See [auth-gdpr](../subsystems/auth-gdpr.md).

**Anacrusis** (M)
A pickup measure — a leading partial bar whose total duration is less
than the meter's full capacity. Flagged by `Measure.isPickup`
(`src/lib/music/types.ts:MeasureSchema`); the closing partial that
balances it is `Measure.isFinalPartial`. Import normalization pads/
truncates around it (`src/lib/music/import/normalize.ts`). Note the
schema comment's caveat: setting `isPickup` is currently inert for
duration validation pending a later PR.

**Annotation** (M/S)
A free-floating text label (rehearsal mark, expression text, tempo
text, `dolce`, etc.) anchored to a `(measureIdx, eventIdx?)` target
with a placement. `src/lib/music/types.ts:AnnotationSchema`. Optional
`spanEnd` makes it a line-extending annotation (`rit. ____`). Distinct
from a `Span` (a typed musical line) and a `Marker` (a key/meter/tempo
change).

## C

**Coda** (M)
A jump-target marking the tail section reached after `To Coda`. Modeled
as `CodaMarkerSchema` plus the `'To Coda'` and `'*.al Coda'` values of
`JumpKindSchema` (`src/lib/music/types.ts`). Jump markers link by id
(`codaRef`, `toCodaRef`) so multi-coda pieces can express
"this D.S. → that Segno → that Coda".

## D

**D.C. / D.S. / Fine** (M)
*Da Capo* (from the top), *Dal Segno* (from the sign), and *Fine* (the
end) navigation directives. Enumerated in
`src/lib/music/types.ts:JumpKindSchema` (`D.C.`, `D.S.`, `D.C. al Coda`,
`D.S. al Coda`, `D.C. al Fine`, `D.S. al Fine`, `To Coda`, `Fine`) and
carried on `JumpMarkerSchema`. A `D.S.*` kind references its `Segno` via
`segnoRef`; `*.al Coda` references its `Coda` via `codaRef`.

**Dispatcher** (S)
The native tool-use router. `src/lib/orchestrator/toolDispatch.ts:run`
calls Claude (Sonnet, prompt-cached) with a schema of exactly six
tools and lets the model pick the one matching the prompt + current
Score: `extend_composition`, `insert_measures`, `region_replace`,
`edit_intra_measure`, `regenerate_all`, and `answer_question` (the
last routes to a `converse` stream and modifies nothing — for
"explain / what / why" questions). Default-on via
`SL_NEW_TOOL_DISPATCH`; setting it to `0` falls back to the legacy
Haiku classifier (`src/lib/orchestrator/classifier.ts`). See
[orchestrator](../subsystems/orchestrator.md).

## E

**Eval tier** (S)
One of four eval harness levels — *mock* (zero API spend, fully
deterministic, every PR), *smoke* (real Haiku classifier, per-PR gate),
*visual* (deterministic abcjs render + path-distance diff), and *live*
(real Anthropic, nightly/on-demand). Defined in `evals/README.md`
("Tiers" table); cases pin orchestrator contract invariants against the
applied Score. See [evals-testing](../subsystems/evals-testing.md) if
present, else `evals/README.md`.

**Event** (S/M)
The atomic rhythmic unit of the Score tree: one notehead-moment (a
note, chord, or rest) with a duration. `src/lib/music/types.ts:EventSchema`
— carries `pitches[]` (1–6), `duration`, and all the per-note
attachments (articulations, ornament, dynamic, tremolo, graceNotes,
lyrics, fingerings, ties). `kind: 'note' | 'rest'` discriminates;
during the Phase-1 rollout `kind` is optional and rest-ness is inferred
from `pitches[0].step === 'rest'` (the legacy hack — see
`src/lib/music/eventKind.ts`). Each event has an optional stable `id`
(`EventIdSchema`) that spans/markers reference.

## G

**Generation tier (paywall)** (S)
The product/paywall bucket — `'free' | 'pro'` (`GenerationTier`,
`src/lib/orchestrator/generationTier.ts`) — resolved per request by
`resolveGenerationTier(userId, debugOverride)` and threaded into the
orchestrator. Precedence: operator force-free kill switch > dev-only
debug-panel override (ignored in production unless
`SL_ALLOW_TIER_OVERRIDE`) > per-user entitlement (`users.tier='pro'` AND
`email_verified=1`) > env default (`SL_GENERATION_TIER`). `free` bounds
output to `BOUNDED_EMIT_CEILING` tokens, makes `regenerate_all`
(whole-score rewrite) Pro-only, and returns a clean error instead of the
unbounded legacy regen on a fall-through (`policyFor(tier).allowWholeScore`).
**Not** the same as the model-size **Tier** or the **eval tier** below.

**Ghost preview** (S)
M24's accept/reject layer that turns every AI score-edit into a
*previewed* proposal rather than a silent commit. The server attaches
the proposal (`src/lib/orchestrator/index.ts:maybeAttachGhostProposal`);
the client renders an inline warm-amber overlay (≤4 affected events) or
a right-docked diff panel (≥5) and accepts on Enter / rejects on Esc.
Gated by `SL_GHOST_PREVIEW` (default **on** since M24-PR-6); `0` reverts
to silent-commit. See [ghost-preview](../subsystems/ghost-preview.md).

## H

**Hairpin** (M)
A crescendo/diminuendo wedge — a `Span` of kind `hairpin-cresc` (`<`)
or `hairpin-dim` (`>`) (`src/lib/music/types.ts:SpanKindSchema`).
Optional `startDynamic`/`endDynamic` on the span enable `p<f` shorthand
(the renderer pins a dynamic glyph at each end).

**Handler** (S)
The function that actually executes a dispatched tool, emitting a Score
+ `appliedOps`. The four score-producing handlers
(`runExtendComposition`, `runInsertMeasures`, `runRegionReplace`,
`runEditIntraMeasure`, under `src/lib/orchestrator/handlers/`) retry
once on a `ValidationError` (re-prompting with the failure injected);
`regenerate_all` routes to `runCompose`. See the dispatcher→handler
table in [orchestrator](../subsystems/orchestrator.md).

**Head pointer** (S)
The `sessions.head_version_id` column — an O(1) "what is the current
score?" pointer into `score_versions`
(`src/lib/db/schema.ts`, the `sessions` table). Score-mutating turns
advance head; turns that set `requiresConfirmation` (replacement gate
or ghost preview) persist a candidate `score_versions` row *without*
bumping head. See [persistence-db](../subsystems/persistence-db.md).

## L

**Laissez vibrer (l.v.)** (M)
An open-ended tie with no termination target — the pitch rings until
natural decay (harp, vibraphone, damper-pedal piano). Modeled as
`Pitch.lv` (`src/lib/music/types.ts:PitchSchema`); unlike a normal tie
it requires no matching pitch in the next event to satisfy validation.

## M

**Marker** (M/S)
A mid-piece change of key, meter, tempo (BPM and/or word), or per-staff
clef, anchored at a `measureIdx`. `src/lib/music/types.ts:MarkerSchema`
(a `.refine()` requires it to change at least one attribute). Accessors
like `activeKeyAt(score, measureIdx)` resolve the score-level default
plus the most recent marker at or before an index. Optionally carries a
`metricModulation`. Distinct from jump/segno/coda markers (navigation)
and annotations (free text).

**Metric modulation** (M)
A tempo-equivalence notation rendered as "♩ = ♩." at a boundary —
"fromNote in the old tempo equals toNote in the new tempo" (Carter,
Reich, Adams). `src/lib/music/types.ts:MetricModulationSchema`, attached
to a `Marker`. It is a *visual label only*: the actual new playback
tempo lives in the sibling `Marker.tempo_bpm`.

## N

**Niente** (M)
"Nothing" — silence treated as a dynamic, the `'n'` value of
`src/lib/music/types.ts:DynamicSchema` (Berio, Sciarrino, late Nono).
Typically the terminal dynamic of a hairpin fading to/from nothing.

## O

**Orchestrator** (S)
The `/api/chat` brain. `src/lib/orchestrator/index.ts:run` is the single
entry point; it runs a copyright filter, then dispatch (tool-use or
legacy classifier), handler execution, preservation verification, the
replacement gate, and the ghost-preview hook, before emitting a
versioned Score result. `src/lib/orchestrator/README.md` is the
authoritative deep reference; see also
[orchestrator](../subsystems/orchestrator.md).

## P

**Pizz / Arco / Col legno → see Technique state** (M)

**Portato** (M)
The compound staccato-and-tenuto articulation — a *single* glyph
(`'portato'` in `src/lib/music/types.ts:ArticulationSchema`), NOT a
stack of two articulations. Helpers in `articulations.ts` auto-coerce a
`staccato + tenuto` pair into `portato` and reject `marcato + accent`
(engraving convention).

**Preservation verification** (S)
The trust-nothing-the-LLM-says guard. `preservationVerifier.ts`
re-hashes the measures a tool was contractually supposed to leave
untouched (e.g. `extend_composition`/`insert_measures` retain bars
`0..N-1`) and refuses the result if any retained-measure hash differs
from the input — even if the model claims preservation. On failure the
handler throws and the orchestrator falls through to the legacy path.
See the "Server-side preservation verification" section of
`src/lib/orchestrator/README.md`.

**Proposal** (S)
The payload that drives ghost preview. Server-side it is the
`result.proposal = { affectedEventIds }` envelope set by
`maybeAttachGhostProposal` (`src/lib/orchestrator/index.ts`), which also
sets `requiresConfirmation = true`. Client-side it materializes as the
`PendingProposal` slot in the chat store
(`src/lib/chat/state.ts:PendingProposal`) — carrying the
`candidateVersionId`, `candidateScore`, `beforeScore`, pre-rendered
`abc`, `affectedEventIds`, and a derived `presentation`
(`inline` | `diff-panel`). See [ghost-preview](../subsystems/ghost-preview.md).

**Provider failover** (S)
Two-layer provider resilience. `callWithFailover`
(`src/lib/providers/callWithFailover.ts`) is a single-attempt wrapper
that, on a `ProviderSchemaError`, reports the failure to the
degradation tracker and re-throws. The *active* failover is in
`selectProvider` (`src/lib/providers/select.ts`): once a provider hits
`DEGRADATION_THRESHOLD` (2) schema failures on a chat+tier
(`src/lib/providers/degradation.ts`), the rest of the conversation
auto-routes to `PROVIDER_FALLBACK` (default `anthropic`). See
[providers-llm](../subsystems/providers-llm.md).

## R

**Replacement gate** (S)
The replacement-as-confirmation guard. `replacementDetect.ts` fires
when ALL of: retained-measure-identity ratio < 0.5, at least one of
key/meter/title changed, AND the prompt lacks explicit-rewrite intent
(the `rewrite|replace|start over|…` regex). On fire the orchestrator
sets `result.requiresConfirmation = true` and the route persists a
candidate version without bumping head, surfacing
`ReplacementConfirmModal.tsx`. Default-on via `SL_REPLACEMENT_GATE`;
per-session opt-out is `sessions.replacement_gate_suppressed`. The
replacement gate is mutually exclusive with — and wins over — ghost
preview on the same turn. See the "Replacement-as-confirmation gate"
section of `src/lib/orchestrator/README.md`.

## S

**Score** (S/M)
The spine of the whole app: a deeply-nested Zod object
(`src/lib/music/types.ts:ScoreSchema`) — top-level `key`/`meter`/
`tempo_bpm`/`title` plus `measures[] → events[] → pitches[]`, an
optional `secondStaff` and `extraVoices`, and the side-arrays `spans`,
`markers`, `voltas`, `jumpMarkers`/`segnoMarkers`/`codaMarkers`,
`annotations`, `techniqueStates`, and `engravingDefaults`. `validateScore`
(`src/lib/music/validateScore.ts`) is the single validation entry point.
`BLANK_SCORE` is the canonical empty seed.

**Score version** (S)
One immutable checkpoint of a Score in the append-only
`score_versions` table (`src/lib/db/schema.ts`). Every row carries
`score_json`, a `score_hash`, a `parent_version_id` (the linear path
back to root), and a `source` (`llm | edit | import | fork-seed |
revert`). `idempotency_key` makes retries safe. The `sessions.head_version_id`
points at the current one. See [persistence-db](../subsystems/persistence-db.md).

**Segno** (M)
The "sign" (𝄋) a `D.S.` jumps back to. `SegnoMarkerSchema`
(`src/lib/music/types.ts`), referenced from a `JumpMarker.segnoRef`.

**SourceMap** (S)
The character-range index that links Score events/pitches to positions
in the generated ABC string (and, via `data-startchar` on rendered
SVG, to noteheads). Produced by
`src/lib/music/scoreToAbcWithMap.ts:scoreToAbcWithMap` — type `SourceMap`
= `{ events: EventRange[]; byEvent: Map<string, EventRange> }`, keyed
`"${staffIdx}:${voiceIdx}:${measureIdx}:${eventIdx}"`. It is what lets a
click on the rendered staff round-trip back to a Score selection. See
[abc-rendering](../subsystems/abc-rendering.md).

**Span** (M/S)
A typed musical line whose endpoints reference stable Event ids:
slur/phrase-slur, hairpin (cresc/dim), octave lines (8va/8vb/15ma/15mb),
glissando, trill-line, tremolo-between, pedal, and accel/rit tempo
spans. `src/lib/music/types.ts:SpanSchema` / `SpanKindSchema`. The
`id` is optional on the wire and backfilled by `ensureSpanIds` before
save. Cross-voice and cross-staff spans are rejected in Phase 1.

**Sticky routing** (S)
Sticky-per-chat provider selection. The first provider resolved for a
tier on a given `chatId` is remembered for the rest of the conversation
so the chat doesn't drift between provider "voices" turn to turn.
`src/lib/providers/sticky.ts` (in-memory `getSticky`/`setSticky`,
cleared via `clearStickyForChat` on deletion); consulted first by
`selectProvider`. See [providers-llm](../subsystems/providers-llm.md).

## T

**Technique state (pizz / arco / col legno)** (M)
A *state-changing* performance direction that persists on a voice from
its position forward until cancelled — fundamentally different from a
per-note articulation. A `pizz.` at m.5 means the voice plays pizzicato
from m.5 until an `arco` (or another change) cancels it. Modeled as
`Score.techniqueStates: TechniqueChange[]`
(`src/lib/music/types.ts:TechniqueChangeSchema` / `TechniqueKindSchema`
— pizz, arco, col-legno-battuto/tratto, sul-ponticello, sul-tasto,
flautando, ord, snap-pizz, LH-pizz, tremolo, mute-on/off). Helpers in
`techniques.ts` compute the active technique at any position.

**Tier** (S)
A model-size bucket — `'small' | 'medium' | 'large'`
(`src/lib/providers/types.ts:Tier`) — that the orchestrator maps
classified scope/complexity onto, then resolves to a concrete provider
+ model via `PROVIDER_SMALL`/`PROVIDER_MEDIUM`/`PROVIDER_LARGE`
(default `anthropic`). Not to be confused with **eval tier** (above)
or the **generation tier** (the `free`/`pro` paywall bucket, also above)
— three unrelated uses of "tier".

**Tremolo (measured / unmeasured)** (M)
Rapid repetition shown as slashes. Single-note tremolo is
`Event.tremolo = { slashes: 1–5, measured?: boolean }`
(`src/lib/music/types.ts:EventSchema`): `slashes` sets the subdivision
(1 = eighth, 2 = sixteenth, …); `measured: false` is the
unmeasured/bowed tremolo (Beethoven-5 strings), `true`/omitted is
measured (Schubert). Between-two-notes tremolo is instead a
`Span` of kind `tremolo-between`; an unmeasured tremolo *state* is the
`'tremolo'` `TechniqueKind`.

## V

**Voltas** (M)
1st/2nd/Nth-ending brackets over a repeated passage. `VoltaSchema`
(`src/lib/music/types.ts`) spans `startMeasureIdx..endMeasureIdx` with
an `endings[]` array (`[1]` = first time only, `[1,2]` = first and
second pass) and an optional closing `endHook`. Stack multiple voltas
for separate brackets over the same passage.

---

## See also

- `src/lib/music/types.ts` — the canonical schema + doc-comments for
  every music term above.
- `src/lib/orchestrator/README.md` — the authoritative reference for
  dispatcher / handler / preservation verification / replacement gate /
  ghost preview.
- [music-model](../subsystems/music-model.md),
  [orchestrator](../subsystems/orchestrator.md),
  [providers-llm](../subsystems/providers-llm.md),
  [persistence-db](../subsystems/persistence-db.md),
  [ghost-preview](../subsystems/ghost-preview.md),
  [abc-rendering](../subsystems/abc-rendering.md)
