/**
 * Postgres access for the self-hosted deployment.
 *
 * storage-db.ts queries through a tagged template you await:
 *   await sql`SELECT ... WHERE folder = ${folder}`
 * rather than pool.query('... $1 ...', [folder]), because writing the value where it is used
 * leaves no way to mismatch a placeholder against its position in an array. On top of `pg`:
 *
 *   - the tag turns ${value} interpolations into $1, $2, … bind parameters
 *     (so values are always parameterised, never string-concatenated into SQL),
 *   - awaiting a query resolves to the rows array,
 *   - transaction([...]) runs a list of not-yet-executed queries in one BEGIN/COMMIT.
 *
 * The laziness matters for that last point: a query built by this tagged template does not hit
 * the database until something awaits it, which is what lets importParsedProblems() build a list
 * of queries first and then hand them to transaction() to run together.
 */
import pg from 'pg';

const { DatabaseError, Pool } = pg;

/**
 * A built-but-not-yet-sent query. Thenable rather than a real Promise so that `await q` runs it
 * while `transaction([q, …])` can still take it unexecuted and run it on a shared client.
 */
export class PendingQuery<T> implements PromiseLike<T[]> {
  private started: Promise<T[]> | undefined;

  constructor(
    readonly text: string,
    readonly values: unknown[],
    private readonly run: (text: string, values: unknown[]) => Promise<T[]>,
  ) {}

  /** Runs the query at most once, however many times it is awaited */
  private exec(): Promise<T[]> {
    if (!this.started) this.started = this.run(this.text, this.values);
    return this.started;
  }

  then<R1 = T[], R2 = never>(
    onfulfilled?: ((value: T[]) => R1 | PromiseLike<R1>) | null,
    onrejected?: ((reason: unknown) => R2 | PromiseLike<R2>) | null,
  ): PromiseLike<R1 | R2> {
    return this.exec().then(onfulfilled, onrejected);
  }

  catch<R = never>(onrejected?: ((reason: unknown) => R | PromiseLike<R>) | null): Promise<T[] | R> {
    return this.exec().catch(onrejected);
  }
}

export interface SqlTag {
  <T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): PendingQuery<T>;
  /** Runs several queries built by this tag inside one BEGIN/COMMIT on a single connection */
  transaction(queries: Array<PendingQuery<unknown>>): Promise<void>;
}

function connectionString(): string | undefined {
  // docker-compose.yml builds this from POSTGRES_PASSWORD; set it by hand only outside Docker.
  return process.env.DATABASE_URL || undefined;
}

export function isDbConfigured(): boolean {
  return Boolean(connectionString());
}

/**
 * TLS is required by most hosted Postgres providers and actively wrong for the ZimaOS stack,
 * where Postgres is another container on a private Docker network with no certificate of its own.
 * Asking for TLS there fails the connection outright, so it is opt-in: on when the URL says so,
 * or when PGSSLMODE requests it.
 */
function sslConfig(conn: string): pg.PoolConfig['ssl'] {
  const wantsSsl =
    /[?&]sslmode=(require|verify-ca|verify-full)/.test(conn) ||
    ['require', 'verify-ca', 'verify-full'].includes(process.env.PGSSLMODE ?? '');
  if (!wantsSsl) return undefined;
  // Hosted Postgres commonly presents a chain Node does not have a root for. The alternative is
  // refusing to connect at all.
  return { rejectUnauthorized: false };
}

let pool: pg.Pool | undefined;

/** The shared connection pool. Created on first use so importing this module never connects. */
export function getPool(): pg.Pool {
  if (!pool) {
    const conn = connectionString();
    if (!conn) throw new Error('Database is not configured (set DATABASE_URL)');
    pool = new Pool({
      connectionString: conn,
      ssl: sslConfig(conn),
      // A single small studio: a handful of connections is plenty, and keeping the ceiling low
      // means the Postgres container's default max_connections is never the thing that breaks.
      max: Number(process.env.PGPOOL_MAX ?? 8),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    });
    // Without a listener, a connection dropped while idle (Postgres restarting, which on a home
    // server happens every time the ZimaOS box reboots) is an unhandled 'error' event and takes
    // the whole studio process down with it. The pool discards the bad client and reconnects on
    // the next query by itself; this only stops the crash.
    pool.on('error', (err) => {
      console.error('[DB] Idle connection error (the pool will reconnect):', err.message);
    });
  }
  return pool;
}

/** Builds `$1, $2, …` placeholders from a tagged template's interpolated values */
function buildText(strings: TemplateStringsArray, values: unknown[]): string {
  let text = strings[0] ?? '';
  for (let i = 0; i < values.length; i += 1) {
    text += `$${i + 1}${strings[i + 1] ?? ''}`;
  }
  return text;
}

function makeTag(execute: (text: string, values: unknown[]) => Promise<unknown[]>): SqlTag {
  const tag = <T,>(strings: TemplateStringsArray, ...values: unknown[]): PendingQuery<T> =>
    new PendingQuery<T>(buildText(strings, values), values, execute as (t: string, v: unknown[]) => Promise<T[]>);

  (tag as SqlTag).transaction = async (queries: Array<PendingQuery<unknown>>): Promise<void> => {
    if (queries.length === 0) return;
    const client = await getPool().connect();
    try {
      await client.query('BEGIN');
      for (const query of queries) {
        await client.query(query.text, query.values);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  };

  return tag as SqlTag;
}

let tag: SqlTag | undefined;

/** The tagged template storage-db.ts queries through. */
export function sql(): SqlTag {
  if (!tag) {
    tag = makeTag(async (text, values) => {
      const result = await getPool().query(text, values);
      return result.rows;
    });
  }
  return tag;
}

/** Postgres error codes storage-db.ts branches on */
export function isUniqueViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === '23505';
}
export function isForeignKeyViolation(err: unknown): boolean {
  return err instanceof DatabaseError && err.code === '23503';
}

/** Closes the pool on shutdown so the container exits promptly instead of waiting on idle sockets. */
export async function closePool(): Promise<void> {
  const current = pool;
  pool = undefined;
  tag = undefined;
  await current?.end().catch(() => undefined);
}
