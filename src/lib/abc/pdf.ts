import { jsPDF } from 'jspdf'
import { svg2pdf } from 'svg2pdf.js'

async function loadAbcjs() {
  const mod = await import('abcjs')
  return (mod as unknown as { default?: typeof mod }).default ?? mod
}

interface PdfOptions {
  title?: string
  staffwidth?: number
}

/**
 * Render `abc` to a hidden SVG, then convert it to vector PDF bytes
 * using jsPDF + svg2pdf.js. Vector (not rasterized) so notation stays
 * crisp at any zoom; rasterizing via html2canvas was rejected for
 * exactly this reason.
 *
 * Browser-only — touches document.
 */
export async function generatePdf(abc: string, opts: PdfOptions = {}): Promise<Uint8Array> {
  const staffwidth = opts.staffwidth ?? 760

  const hidden = document.createElement('div')
  hidden.style.position = 'absolute'
  hidden.style.left = '-99999px'
  hidden.style.top = '0'
  hidden.style.width = `${staffwidth + 40}px`
  document.body.appendChild(hidden)

  try {
    const abcjs = await loadAbcjs() as unknown as {
      renderAbc: (t: HTMLElement, abc: string, opts?: unknown) => unknown
    }
    // expandToWidest equalizes measure widths across systems so the PDF
    // matches the on-screen score (see RenderScoreOptions.expandToWidest
    // in synth.ts for the rationale).
    abcjs.renderAbc(hidden, abc, { staffwidth, expandToWidest: true })

    const svg = hidden.querySelector('svg')
    if (!svg) throw new Error('abcjs produced no SVG for PDF export')

    const width = Number(svg.getAttribute('width') ?? staffwidth)
    const height = Number(svg.getAttribute('height') ?? 200)

    const doc = new jsPDF({
      orientation: width > height ? 'landscape' : 'portrait',
      unit: 'pt',
      format: [Math.ceil(width + 40), Math.ceil(height + 40)],
    })
    if (opts.title) doc.setProperties({ title: opts.title })

    await svg2pdf(svg, doc, { x: 20, y: 20, width, height })

    return new Uint8Array(doc.output('arraybuffer'))
  } finally {
    document.body.removeChild(hidden)
  }
}

/**
 * Trigger a browser download of the rendered score as PDF.
 */
export async function downloadPdf(abc: string, filename = 'score.pdf', opts: PdfOptions = {}): Promise<void> {
  const bytes = await generatePdf(abc, opts)
  const blob = new Blob([new Uint8Array(bytes)], { type: 'application/pdf' })
  const url = URL.createObjectURL(blob)
  try {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
  } finally {
    URL.revokeObjectURL(url)
  }
}
