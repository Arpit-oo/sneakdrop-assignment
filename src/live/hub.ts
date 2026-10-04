import pg from 'pg';
import { config } from '../config.js';

/**
 * One LISTEN connection per API instance. Any instance's write fires
 * pg_notify('sale_changed') (trigger, migration 003), every instance hears it
 * and tells its subscribers (open SSE streams). Started lazily on the first
 * subscriber, so tests / workers that never open a stream never connect.
 */
export class SaleHub {
  private client: pg.Client | undefined;
  private connecting: Promise<void> | undefined;
  private subscribers = new Set<() => void>();
  private timer: NodeJS.Timeout | undefined;
  private closed = false;

  constructor(private readonly debounceMs = 100) {}

  async subscribe(fn: () => void): Promise<() => void> {
    this.subscribers.add(fn);
    await this.ensureListening();
    return () => this.subscribers.delete(fn);
  }

  get size() {
    return this.subscribers.size;
  }

  async close() {
    this.closed = true;
    clearTimeout(this.timer);
    this.subscribers.clear();
    await this.client?.end().catch(() => {});
    this.client = undefined;
  }

  private ensureListening(): Promise<void> {
    if (this.client || this.closed) return Promise.resolve();
    this.connecting ??= this.connect().finally(() => (this.connecting = undefined));
    return this.connecting;
  }

  private async connect() {
    const client = new pg.Client({ connectionString: config.DATABASE_URL });
    await client.connect();
    await client.query('LISTEN sale_changed');
    client.on('notification', () => this.changed());
    client.on('error', () => {
      // connection dropped: forget it, reconnect, and nudge pages to refetch
      this.client = undefined;
      if (!this.closed) setTimeout(() => this.ensureListening().then(() => this.changed()).catch(() => {}), 1000);
    });
    this.client = client;
  }

  /** Debounced: a burst of commits becomes one push per ~100ms. */
  private changed() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      for (const fn of this.subscribers) fn();
    }, this.debounceMs);
  }
}
