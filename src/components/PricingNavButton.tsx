import Link from 'next/link'
import styles from './PricingNavButton.module.css'

/**
 * Prominent header link to the /pricing landing page. Styled like the other
 * header buttons (HelpButton) but tinted with the accent so the upsell stands
 * out among the neutral tools. The label collapses to just the icon on narrow
 * headers, like HelpButton. A plain <Link> (no client state), so it can render
 * inside the client AppHeader without extra cost.
 */
export default function PricingNavButton() {
  return (
    <Link href="/pricing" className={styles.button} aria-label="Pricing and credits">
      <PricingIcon />
      <span className={styles.label}>Pricing</span>
    </Link>
  )
}

function PricingIcon() {
  // A small "sparkle" mark — reads as value/upgrade without implying a hard paywall.
  return (
    <svg
      className={styles.icon}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M12 3l1.9 4.9L19 9.8l-4.1 2.9L16 18l-4-2.8L8 18l1.1-5.3L5 9.8l5.1-1.9z" />
    </svg>
  )
}
