/**
 * Narrow curated lists for the copyright filter. Intentionally small.
 *
 * The red-team review on a broad 500-name trie showed catastrophic
 * false positives on common-word band/song names. The new strategy:
 *
 * - PD_COMPOSERS: explicit allowlist of public-domain composers /
 *   styles. Any prompt containing one of these names short-circuits
 *   the filter to "not blocked" regardless of co-occurrence with
 *   verbs like "by" / "cover of".
 *
 * - HIGH_RISK_ARTISTS / SONGS: only used in *co-occurrence* matching
 *   ("by X", "cover of X", "reproduce X"). Standalone occurrence of
 *   any name on these lists does NOT block.
 *
 * Keep these lists short and high-precision. The eventual real
 * mitigation is an output-side melodic fingerprint check (deferred).
 */

export const PD_COMPOSERS = [
  'bach',
  'mozart',
  'beethoven',
  'chopin',
  'schubert',
  'handel',
  'haydn',
  'vivaldi',
  'tchaikovsky',
  'brahms',
  'schumann',
  'mendelssohn',
  'liszt',
  'wagner',
  'verdi',
  'puccini',
  'rossini',
  'debussy',
  'ravel',
  'satie',
  'gershwin',
  'sousa',
  'palestrina',
  'monteverdi',
  'corelli',
  'scarlatti',
  'purcell',
  'rameau',
]

/**
 * Modern (post-1929, almost certainly under copyright) artists and
 * groups. Listed only for co-occurrence matching with infringement
 * verbs. Names that ARE common English words ("Queen", "Yes", "Cream",
 * "Bread", "America") are deliberately omitted — the false-positive
 * rate alone is not worth the recall.
 */
export const HIGH_RISK_ARTISTS = [
  'the beatles',
  'beatles',
  'taylor swift',
  'beyonce',
  'beyoncé',
  'drake',
  'kanye west',
  'jay-z',
  'rihanna',
  'adele',
  'ed sheeran',
  'bruno mars',
  'lady gaga',
  'justin bieber',
  'ariana grande',
  'eminem',
  'kendrick lamar',
  'billie eilish',
  'olivia rodrigo',
  'the weeknd',
  'post malone',
  'harry styles',
  'dua lipa',
  'doja cat',
  'sza',
  'frank ocean',
  'radiohead',
  'coldplay',
  'oasis',
  'nirvana',
  'metallica',
  'led zeppelin',
  'pink floyd',
  'rolling stones',
  'the rolling stones',
  'fleetwood mac',
  'michael jackson',
  'prince',
  'madonna',
  'whitney houston',
  'mariah carey',
]

/**
 * High-risk song titles. ONLY used in co-occurrence with infringement
 * verbs ("cover of X", "reproduce X"). Bare title matches do not
 * block — "yesterday's rain" must pass.
 */
export const HIGH_RISK_SONGS = [
  'yesterday',
  'hey jude',
  'let it be',
  'imagine',
  'bohemian rhapsody',
  'stairway to heaven',
  'hotel california',
  'smells like teen spirit',
  'shake it off',
  'rolling in the deep',
  'someone like you',
  'thinking out loud',
  'shape of you',
  'uptown funk',
  'happy',
  'blinding lights',
  'old town road',
  'despacito',
]

/**
 * Verbs/phrases that signal reproduction intent. Co-occurrence with
 * a name from HIGH_RISK_ARTISTS or HIGH_RISK_SONGS triggers the filter.
 *
 * Deliberately narrow: bare verbs like "play" / "write" / "sing" /
 * "perform" are EXCLUDED because they collide with everyday prompts
 * ("play happy notes", "sing yesterday's news", "write let it be in
 * G major"). Only verbs that unambiguously claim ownership of a
 * specific named work belong here.
 */
export const INFRINGEMENT_VERBS = [
  'by',
  'cover of',
  'cover the',
  'reproduce',
  'copy of',
]
