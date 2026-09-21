import type { NextFunction, Request, Response } from 'express';

/** Thrown by route handlers to produce a clean JSON error with a status code. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly details?: Record<string, string>,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const badRequest = (message: string, details?: Record<string, string>) =>
  new HttpError(400, message, details);
export const unauthorized = (message = 'You are not signed in') => new HttpError(401, message);
export const forbidden = (message = 'You do not have access to this') => new HttpError(403, message);
export const notFound = (message = 'Not found') => new HttpError(404, message);
export const conflict = (message: string) => new HttpError(409, message);

/** Wraps an async handler so rejected promises reach the Express error handler. */
export function asyncRoute<T extends Request>(
  handler: (req: T, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(handler(req as T, res, next)).catch(next);
  };
}

export function requireString(value: unknown, field: string, { max = 5000, min = 1 } = {}): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text.length < min) throw badRequest(`${field} is required`, { [field]: 'Required' });
  if (text.length > max) throw badRequest(`${field} must be ${max} characters or fewer`, { [field]: 'Too long' });
  return text;
}

export function optionalString(value: unknown, max = 5000): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return null;
  return text.slice(0, max);
}

export function requireEnum<T extends string>(value: unknown, allowed: readonly T[], field: string): T {
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  throw badRequest(`${field} must be one of: ${allowed.join(', ')}`, { [field]: 'Invalid value' });
}

export function optionalEnum<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) return value as T;
  return undefined;
}

export function parseIntOr(value: unknown, fallback: number, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}): number {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  if (Number.isNaN(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

/**
 * Parses a client-supplied date, rejecting anything Date cannot represent.
 * `new Date('nonsense').toISOString()` throws a RangeError, which would
 * otherwise surface as a 500 on a plainly invalid request.
 */
export function optionalDate(value: unknown, field: string): string | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' && typeof value !== 'number') {
    throw badRequest(`${field} must be a date`, { [field]: 'Invalid date' });
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw badRequest(`${field} is not a valid date`, { [field]: 'Invalid date' });
  }
  return date.toISOString();
}

export function isValidEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

export function toStringArray(value: unknown, max = 50): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean)
    .slice(0, max);
}
