import type { NextFunction, Request, Response } from 'express';

/**
 * The one error shape every route returns: `{ error: { code, message } }`.
 * Throw (or `next()`) an AppError anywhere and the error handler renders it.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  toBody() {
    const error: { code: string; message: string; details?: unknown } = {
      code: this.code,
      message: this.message,
    };
    if (this.details !== undefined) error.details = this.details;
    return { error };
  }
}

export const badRequest = (code: string, message: string, details?: unknown) =>
  new AppError(400, code, message, details);
export const unauthorized = (message = 'Authentication required.') =>
  new AppError(401, 'unauthenticated', message);
export const forbidden = (message = 'You do not have access to this resource.') =>
  new AppError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
export const conflict = (code: string, message: string) => new AppError(409, code, message);
export const unavailable = (code: string, message: string) => new AppError(503, code, message);

/** Route stub for milestone 2 work: validates input upstream, then answers 501. */
export function notImplemented(_req: Request, _res: Response, next: NextFunction) {
  next(new AppError(501, 'not_implemented', 'This endpoint is planned for a later milestone.'));
}
