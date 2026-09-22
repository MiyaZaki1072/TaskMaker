/**
 * Postgres access for the self-hosted deployment.
 *
 * Why this file exists
 * --------------------
 * storage-db.ts was written against @neondatabase/serverless, whose whole API surface is a
 * tagged template you await:  await sql`SELECT ... WHERE folder = ${folder}`.  That driver talks
 * to Neon over HTTP and cannot reach an ordinary Postgres server at all, so moving the app onto
 * ZimaOS (where Postgres is a container on the same Docker network, reached over TCP) means
 * changing drivers.
 *
 * Rather than rewrite ~20 query sites into pool.query('... $1 ...', [folder]) — a mechanical
 * change with a real chance of mismatching a placeholder against its value — this module
 * reproduces the small slice of the Neon API that storage-db.ts actually used, on top of `pg`:
 *
 *   - a tagged template that turns ${value} interpolations into $1, $2, … bind parameters
 *     (so values are still parameterised, never string-concatenated into SQL),
 *   - awaiting a query resolves to the rows array, exactly as the Neon driver did,
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
  // DATABASE_URL is the portable name and what docker-compose sets for the self-hosted stack.
  // POSTGRES_URL / DATABASE_URL_UNPOOLED are also accepted, since hosted Postgres providers
  // commonly set one of those names instead.
  return process.env.DATABASE_URL || process.env.POSTGRES_URL || process.env.DATABASE_URL_UNPOOLED;
}

export function isDbConfigured(): boolean {
  return Boolean(connectionString());
}

/**
 * TLS is required by hosted providers (Neon and friends) and actively wrong for the ZimaOS stack,
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
  // refusing to connect at all, and this is the same trust level the Neon HTTP driver gave us.
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

/** The tagged template storage-db.ts queries through. Shaped like the Neon driver it replaced. */
export function sql(): SqlTag {
  if (!tag) {
    tag = makeTag(async (text, values) => {
      const result = await getPool().query(text, values);
      return result.rows;
    });
  }
  return tag;
}

/** Postgres error codes storage-db.ts branches on, via pg's error type instead of Neon's */
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
