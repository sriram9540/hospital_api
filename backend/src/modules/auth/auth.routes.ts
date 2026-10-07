import { Router, Request, Response, NextFunction } from 'express';
import { registerSchema, loginSchema } from './auth.schema.js';
import { authService } from './auth.service.js';
import { requireAuth, AuthenticatedRequest } from './auth.middleware.js';
import { validationError } from '../../lib/errors.js';

export const authRouter = Router();

authRouter.post('/register', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseRes = registerSchema.safeParse(req.body);
    if (!parseRes.success) {
      validationError('Invalid registration data', { issues: parseRes.error.format() });
    }
    const { session, token } = await authService.register(parseRes.data);

    res.cookie('hospital_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ user: session, token });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/login', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const parseRes = loginSchema.safeParse(req.body);
    if (!parseRes.success) {
      validationError('Invalid login credentials', { issues: parseRes.error.format() });
    }
    const { session, token } = await authService.login(parseRes.data);

    res.cookie('hospital_session', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ user: session, token });
  } catch (err) {
    next(err);
  }
});

authRouter.post('/logout', (req: Request, res: Response) => {
  res.clearCookie('hospital_session');
  res.json({ message: 'Successfully logged out' });
});

authRouter.get('/me', requireAuth, async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  try {
    const session = await authService.getMe(req.user!.userId);
    res.json({ user: session });
  } catch (err) {
    next(err);
  }
});
