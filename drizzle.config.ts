import { defineConfig } from 'drizzle-kit'

const url = process.env.DATABASE_URL ?? 'file:./data/sheet-llm.db'
if (!url.startsWith('file:')) {
  throw new Error(
    'drizzle.config.ts currently only supports file:* SQLite URLs.',
  )
}

export default defineConfig({
  schema: './src/lib/db/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: url.slice('file:'.length),
  },
  verbose: true,
  strict: true,
})
