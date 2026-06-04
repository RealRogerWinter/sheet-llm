import BlankScoreButton from './BlankScoreButton'
import ChatHistoryButton from './ChatHistoryButton'
import HelpButton from './HelpButton'
import ImportScoreButton from './ImportScoreButton'
import NewScoreButton from './NewScoreButton'
import SessionsButton from './SessionsButton'
import ThemeToggle from './ThemeToggle'
import AuthNavButton from './auth/AuthNavButton'
import styles from './AppHeader.module.css'

export default function AppHeader() {
  return (
    <header className={styles.header}>
      <SessionsButton />
      <h1 className={styles.brand}>sheet-llm</h1>
      <div className={styles.right}>
        <ChatHistoryButton />
        <ImportScoreButton />
        <BlankScoreButton />
        <NewScoreButton />
        <HelpButton />
        <ThemeToggle />
        <AuthNavButton />
      </div>
    </header>
  )
}
