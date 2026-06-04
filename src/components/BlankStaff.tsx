interface BlankStaffProps {
  className?: string
}

/**
 * Static SVG placeholder for the empty-state staff. Five staff lines,
 * a treble clef glyph, a 4/4 time signature, and a final barline.
 * No abcjs dependency — avoids the responsive-resize flakiness that
 * happens when abcjs renders a header-only tune in an empty container.
 */
export default function BlankStaff({ className }: BlankStaffProps) {
  return (
    <svg
      className={className}
      viewBox="0 0 720 160"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Empty sheet music staff awaiting notes"
      style={{ width: '100%', height: 'auto', maxWidth: 720, display: 'block', margin: '0 auto' }}
    >
      {[55, 70, 85, 100, 115].map((y) => (
        <line key={y} x1="40" y1={y} x2="700" y2={y} stroke="currentColor" strokeWidth="1" />
      ))}
      <text x="50" y="118" fontSize="80" fill="currentColor" fontFamily="serif">
        𝄞
      </text>
      <text x="120" y="89" fontSize="26" fontWeight="700" fill="currentColor" fontFamily="serif">
        4
      </text>
      <text x="120" y="115" fontSize="26" fontWeight="700" fill="currentColor" fontFamily="serif">
        4
      </text>
      <line x1="700" y1="55" x2="700" y2="115" stroke="currentColor" strokeWidth="2" />
    </svg>
  )
}
