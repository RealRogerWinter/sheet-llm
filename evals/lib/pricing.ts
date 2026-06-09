/**
 * Token pricing — re-exported from the canonical cost model.
 *
 * The `PRICING` table and the `estimateCostUsd` / `billableCostUsd` cost
 * functions now live in `src/lib/metering/pricing.ts` (one source of truth
 * for both evals and customer billing). This file is kept as the eval
 * import path (`evals/lib/liveRunner.ts` imports `estimateCostUsd` from
 * here). Do not add logic here — change the canonical module instead.
 */
export * from '../../src/lib/metering/pricing'
