-- M3.5-PR-4 — replacement-as-confirmation gate
--
-- Adds two columns:
--   1. orchestrator_turns.replacement_blocked — telemetry; set to 1 when
--      the gate fired on a turn (i.e. detectReplacement returned
--      isReplacement=true).
--   2. sessions.replacement_gate_suppressed — per-session opt-out. The
--      user clicks "Replace anyway and don't ask again this session"
--      and the next orchestrator turn for that session bypasses the gate.
--
-- Both columns default to 0 so existing rows backfill as a no-op.
ALTER TABLE `orchestrator_turns` ADD `replacement_blocked` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `replacement_gate_suppressed` integer DEFAULT 0 NOT NULL;
