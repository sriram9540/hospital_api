import { Request, Response, NextFunction } from 'express';
import { verifySessionToken, AuthSession } from './auth.service.js';
import { unauthenticated, forbidden } from '../../lib/errors.js';

export interface AuthenticatedRequest extends Request {
  user?: AuthSession;
}

export function extractAuthSession(req: Request): AuthSession | null {
  const authHeader = req.headers.authorization;
  let token: string | undefined;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.substring(7);
  } else if (req.cookies && req.cookies['hospital_session']) {
    token = req.cookies['hospital_session'];
  }

  if (!token) return null;
  return verifySessionToken(token);
}

export function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const session = extractAuthSession(req);
  if (!session) {
    unauthenticated('Please log in to continue');
  }
  req.user = session;
  next();
}

export function optionalAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const session = extractAuthSession(req);
  if (session) {
    req.user = session;
  }
  next();
}

export function requireRole(...roles: Array<'patient' | 'doctor' | 'admin' | 'receptionist'>) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
    if (!req.user) {
      unauthenticated('Please log in to continue');
    }
    if (!roles.includes(req.user.role)) {
      forbidden('You do not have permission to access this resource');
    }
    next();
  };
}
