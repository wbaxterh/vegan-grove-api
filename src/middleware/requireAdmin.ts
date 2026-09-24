import type { RequestHandler } from 'express';
import { forbidden } from '../lib/errors.js';
import { currentUser } from './auth.js';

/**
 * Admin gate. Mount after `requireAuth`, which loaded the user from the DB on
 * this very request, so `role` is current and never comes from a token.
 */
export const requireAdmin: RequestHandler = (req, _res, next) => {
  const user = currentUser(req);
  if (user.role !== 'admin') return next(forbidden('Admin access required.'));
  next();
};
