import { hash, verify } from '@node-rs/argon2'

/**
 * Argon2id password hashing — a thin wrapper so the cost parameters live in ONE
 * place and a future bump is a one-line change + `needsRehash()`.
 *
 * `@node-rs/argon2`'s `hash()` defaults to the **argon2id** algorithm and
 * version 0x13 (19); we set only the cost knobs and ASSERT the produced PHC
 * string is argon2id in the unit test, so a future library-default change can
 * never silently weaken us to argon2i/argon2d.
 *
 * Params: the OWASP 2024 argon2id baseline (m = 19 MiB, t = 2, p = 1). `@node-rs`
 * runs the hash OFF the main thread (libuv pool), so it does not block the
 * event loop — but a burst can still saturate the pool, so login is rate-limited
 * (per-IP) BEFORE hashing. A global concurrency semaphore to hard-bound
 * libuv-pool use under a DISTRIBUTED burst is a documented future hardening; v1
 * relies on the per-IP limiter + pool back-pressure. No pepper in v1: a static
 * pepper cannot be rotated without breaking
 * every stored hash, and it only defends a DB-only leak (not host compromise);
 * revisit with a dual-pepper scheme if that threat model ever demands it.
 */
export const ARGON2_PARAMS = {
  memoryCost: 19_456, // 19 MiB, in KiB (OWASP argon2id floor)
  timeCost: 2,
  parallelism: 1,
}

export function hashPassword(password: string): Promise<string> {
  return hash(password, ARGON2_PARAMS)
}

/**
 * Verify a password against a stored PHC hash. The algorithm + cost params are
 * read from the encoded hash itself, so we pass no options. NEVER throws — a
 * malformed / foreign / empty hash is treated as a non-match.
 */
export async function verifyPassword(
  storedHash: string,
  password: string,
): Promise<boolean> {
  try {
    return await verify(storedHash, password)
  } catch {
    return false
  }
}

/**
 * True when `storedHash` is not current-strength argon2id and should be
 * re-hashed on the next successful login. Parses the PHC header
 * `$argon2id$v=19$m=19456,t=2,p=1$…`. Conservatively returns true on any parse
 * failure or foreign algorithm — better to re-hash than to keep a weak hash.
 */
export function needsRehash(storedHash: string): boolean {
  const m = /^\$argon2id\$v=(\d+)\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(storedHash)
  if (!m) return true
  const [, version, mem, time, par] = m
  return (
    Number(version) < 19 ||
    Number(mem) < ARGON2_PARAMS.memoryCost ||
    Number(time) < ARGON2_PARAMS.timeCost ||
    Number(par) !== ARGON2_PARAMS.parallelism
  )
}
