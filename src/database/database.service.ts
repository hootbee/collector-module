import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool, type PoolClient, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

export type DatabaseHealth = {
  configured: boolean;
  ok: boolean;
  database?: string;
  user?: string;
  host?: string;
  port?: number;
  serverVersion?: string;
  latencyMs?: number;
  error?: string;
};

@Injectable()
export class DatabaseService implements OnModuleDestroy {
  private pool: Pool | null = null;

  isConfigured(): boolean {
    return Boolean(process.env.DATABASE_URL?.trim() || process.env.PGHOST?.trim());
  }

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>> {
    return this.getPool().query<T>(text, values);
  }

  async withClient<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.getPool().connect();
    try {
      return await work(client);
    } finally {
      client.release();
    }
  }

  async health(): Promise<DatabaseHealth> {
    if (!this.isConfigured()) {
      return {
        configured: false,
        ok: false,
        error: 'PostgreSQL is not configured. Set DATABASE_URL or PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD.',
      };
    }

    const startedAt = Date.now();
    try {
      const result = await this.query<{
        current_database: string;
        current_user: string;
        inet_server_addr: string | null;
        inet_server_port: number | null;
        server_version: string;
      }>(
        [
          'select',
          'current_database() as current_database,',
          'current_user as current_user,',
          'inet_server_addr()::text as inet_server_addr,',
          'inet_server_port() as inet_server_port,',
          "current_setting('server_version') as server_version",
        ].join(' '),
      );
      const row = result.rows[0];
      return {
        configured: true,
        ok: true,
        database: row?.current_database,
        user: row?.current_user,
        host: row?.inet_server_addr ?? this.configSummary().host,
        port: row?.inet_server_port ?? this.configSummary().port,
        serverVersion: row?.server_version,
        latencyMs: Date.now() - startedAt,
      };
    } catch (error) {
      return {
        configured: true,
        ok: false,
        ...this.configSummary(),
        latencyMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.pool?.end();
    this.pool = null;
  }

  private getPool(): Pool {
    if (!this.pool) {
      this.pool = new Pool(this.poolConfig());
    }
    return this.pool;
  }

  private poolConfig(): PoolConfig {
    const connectionString = process.env.DATABASE_URL?.trim();
    const sslEnabled = process.env.DB_SSL === 'true';
    const base: PoolConfig = connectionString
      ? { connectionString }
      : {
          host: process.env.PGHOST?.trim() || '127.0.0.1',
          port: Number(process.env.PGPORT ?? 5432),
          database: process.env.PGDATABASE?.trim() || 'stage_one',
          user: process.env.PGUSER?.trim() || 'stage_one',
          password: process.env.PGPASSWORD,
        };

    return {
      ...base,
      max: Number(process.env.DB_POOL_MAX ?? 10),
      idleTimeoutMillis: Number(process.env.DB_IDLE_TIMEOUT_MS ?? 30000),
      connectionTimeoutMillis: Number(process.env.DB_CONNECTION_TIMEOUT_MS ?? 5000),
      ssl: sslEnabled ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
    };
  }

  private configSummary(): Pick<DatabaseHealth, 'database' | 'user' | 'host' | 'port'> {
    if (process.env.DATABASE_URL?.trim()) {
      try {
        const url = new URL(process.env.DATABASE_URL);
        return {
          database: url.pathname.replace(/^\//, '') || undefined,
          user: decodeURIComponent(url.username || ''),
          host: url.hostname,
          port: url.port ? Number(url.port) : 5432,
        };
      } catch {
        return {};
      }
    }
    return {
      database: process.env.PGDATABASE?.trim() || 'stage_one',
      user: process.env.PGUSER?.trim() || 'stage_one',
      host: process.env.PGHOST?.trim() || '127.0.0.1',
      port: Number(process.env.PGPORT ?? 5432),
    };
  }
}
