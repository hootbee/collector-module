import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createApp } from '../main';
import { DatabaseService } from '../database/database.service';

async function main() {
  const app = await createApp();
  await app.init();
  const databaseService = app.get(DatabaseService);

  try {
    const health = await databaseService.health();
    if (!health.ok) {
      throw new Error(`PostgreSQL health check failed: ${health.error ?? 'unknown error'}`);
    }

    if (process.env.DB_SMOKE_MIGRATE === 'true') {
      const schemaPath = join(__dirname, '..', 'database', 'schema.sql');
      const sql = await readFile(schemaPath, 'utf8');
      await databaseService.query(sql);
    }

    const result = await databaseService.query<{ now: string }>('select now()::text as now');
    console.log(JSON.stringify({
      status: 'ok',
      health,
      migrated: process.env.DB_SMOKE_MIGRATE === 'true',
      now: result.rows[0]?.now,
    }, null, 2));
  } finally {
    await app.close();
  }
}

void main();
