/** Expected business-rule failure. Routes map it straight to an HTTP response. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
  }
}

type PgError = { code?: string; hint?: string; constraint?: string };

/**
 * Translate errors raised by the database safety net (trigger / unique index)
 * into DomainErrors. The app checks the same rules first, so reaching this
 * means the DB caught something the app logic missed — still a clean 409.
 */
export function fromDbError(err: unknown): DomainError | undefined {
  const e = err as PgError;
  if (e?.code === 'P0001' && e.hint === 'SOLD_OUT') {
    return new DomainError('SOLD_OUT', 409, 'All pairs are taken');
  }
  if (e?.code === 'P0001' && e.hint === 'LIMIT_REACHED') {
    return new DomainError('LIMIT_REACHED', 409, 'Purchase limit reached');
  }
  if (e?.code === '23505' && e.constraint === 'holds_one_active_per_user') {
    return new DomainError('ALREADY_HOLDING', 409, 'You already hold a pair');
  }
  return undefined;
}
