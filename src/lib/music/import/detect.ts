import type { ImportFormat } from './types'

/**
 * Best-effort format detection from filename + content. Caller can
 * always override by passing the format explicitly.
 *
 * Sniffs run in order: extension → leading bytes / leading text.
 *
 * Uncompressed MusicXML (`.xml` / `.musicxml`, or leading-`<` text whose
 * head contains `score-partwise` / `score-timewise`) routes to the
 * `musicxml` parser. COMPRESSED MusicXML (`.mxl`, or a `PK`/zip magic
 * header) stays `xml-unsupported` — the zip container is out of scope; the
 * route surfaces a "export an uncompressed .musicxml" message. Any other
 * leading-`<` text also falls back to `xml-unsupported` so a misuploaded
 * generic XML file fails with a clear message rather than being routed to
 * the JSON parser and producing a confusing schema error.
 */
export function detectFormat(input: {
  filename?: string
  mime?: string
  bytes?: Uint8Array
  text?: string
}): ImportFormat | 'unknown' | 'xml-unsupported' {
  const ext = input.filename?.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1]
  if (ext === 'abc') return 'abc'
  if (ext === 'mid' || ext === 'midi') return 'midi'
  if (ext === 'json') return 'json'
  // Uncompressed MusicXML imports; compressed `.mxl` (zip) does not.
  if (ext === 'xml' || ext === 'musicxml') return 'musicxml'
  if (ext === 'mxl') return 'xml-unsupported'

  if (input.mime === 'audio/midi' || input.mime === 'audio/x-midi') return 'midi'
  if (input.mime === 'application/json') return 'json'
  if (input.mime === 'text/vnd.abc') return 'abc'

  if (input.bytes && input.bytes.length >= 4) {
    if (
      input.bytes[0] === 0x4d &&
      input.bytes[1] === 0x54 &&
      input.bytes[2] === 0x68 &&
      input.bytes[3] === 0x64
    ) {
      // 'MThd' magic
      return 'midi'
    }
    if (input.bytes[0] === 0x50 && input.bytes[1] === 0x4b) {
      // 'PK' — ZIP container, likely compressed .mxl (out of scope).
      return 'xml-unsupported'
    }
  }

  const text = input.text?.trim()
  if (text) {
    if (text.startsWith('<')) {
      // MusicXML partwise/timewise → our parser; any other XML is
      // unsupported. The head sniff handles the BOM/declaration/DOCTYPE
      // preamble before the root element appears.
      const head = text.slice(0, 2048)
      if (/score-partwise|score-timewise/.test(head)) return 'musicxml'
      return 'xml-unsupported'
    }
    if (text.startsWith('{')) return 'json'
    // ABC reference numbers come first, then headers. Any "X:" line is a
    // strong ABC signal.
    if (/^X\s*:\s*\d/m.test(text)) return 'abc'
    if (/^[KMLT]\s*:/m.test(text)) return 'abc'
  }

  return 'unknown'
}
