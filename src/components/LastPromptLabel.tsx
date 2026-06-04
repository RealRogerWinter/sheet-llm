import styles from './LastPromptLabel.module.css'

interface LastPromptLabelProps {
  prompt: string | undefined
}

export default function LastPromptLabel({ prompt }: LastPromptLabelProps) {
  if (!prompt) return null
  return (
    <p className={styles.label}>
      <span>&gt; </span>
      <span className={styles.quote}>{prompt}</span>
    </p>
  )
}
