import { readFileSync } from 'node:fs';
import type { DatabaseSync } from 'node:sqlite';
export function migrateTestDatabase(sql: DatabaseSync) {
  const journal = JSON.parse(readFileSync('drizzle/meta/_journal.json', 'utf8')) as { entries: { tag: string }[] };
  for (const entry of journal.entries) sql.exec(readFileSync(`drizzle/${entry.tag}.sql`, 'utf8'));
}
