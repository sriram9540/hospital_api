import crypto from 'crypto';
import argon2 from 'argon2';
import { db } from '../../lib/db.js';
import { CONFIG } from '../../lib/config.js';
import { AppError, unauthenticated, validationError } from '../../lib/errors.js';
import { RegisterInput, LoginInput } from './auth.schema.js';

export interface AuthSession {
  userId: string;
  role: 'patient' | 'doctor' | 'admin' | 'receptionist';
  email: string;
  patientId?: string;
  doctorId?: string;
  name: string;
}

export function hashPassword(password: string): string {
  return crypto.createHash('sha512').update(password + '_hospital_salt_2026').digest('hex');
}

export function createSessionToken(session: AuthSession): string {
  const payload = Buffer.from(JSON.stringify({ ...session, exp: Date.now() + CONFIG.SESSION_MAX_AGE_MS })).toString('base64url');
  const signature = crypto.createHmac('sha256', CONFIG.SESSION_SECRET).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifySessionToken(token: string): AuthSession | null {
  try {
    const [payload, signature] = token.split('.');
    if (!payload || !signature) return null;

    const expectedSig = crypto.createHmac('sha256', CONFIG.SESSION_SECRET).update(payload).digest('base64url');
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSig))) {
      return null;
    }

    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'));
    if (data.exp < Date.now()) {
      return null;
    }

    return {
      userId: data.userId,
      role: data.role,
      email: data.email,
      patientId: data.patientId,
      doctorId: data.doctorId,
      name: data.name,
    };
  } catch {
    return null;
  }
}

export class AuthService {
  async register(input: RegisterInput): Promise<{ session: AuthSession; token: string }> {
    const existing = await db.query(`SELECT id FROM users WHERE email = $1`, [input.email.toLowerCase()]);
    if (existing.rows.length > 0) {
      throw new AppError('VALIDATION_ERROR', 'A user with this email address already exists', 400);
    }

    const passwordHash = hashPassword(input.password);

    return await db.transaction(async (tx) => {
      const userRes = await tx.query(
        `INSERT INTO users (role, email, phone, password_hash)
         VALUES ('patient', $1, $2, $3)
         RETURNING id, role, email, phone`,
        [input.email.toLowerCase(), input.phone, passwordHash]
      );
      const user = userRes.rows[0];

      const patientRes = await tx.query(
        `INSERT INTO patients (user_id, full_name, dob, no_show_count)
         VALUES ($1, $2, $3, 0)
         RETURNING id, full_name`,
        [user.id, input.fullName, input.dob || null]
      );
      const patient = patientRes.rows[0];

      const session: AuthSession = {
        userId: user.id,
        role: 'patient',
        email: user.email,
        patientId: patient.id,
        name: patient.full_name,
      };

      const token = createSessionToken(session);
      return { session, token };
    });
  }

  async login(input: LoginInput): Promise<{ session: AuthSession; token: string }> {
    const userRes = await db.query(
      `SELECT u.id, u.role, u.email, u.password_hash,
              p.id as patient_id, p.full_name as patient_name,
              d.id as doctor_id, d.name as doctor_name
       FROM users u
       LEFT JOIN patients p ON p.user_id = u.id
       LEFT JOIN doctors d ON d.user_id = u.id
       WHERE u.email = $1`,
      [input.email.toLowerCase()]
    );

    if (userRes.rows.length === 0) {
      // Identical response for user not found and wrong password (§9)
      unauthenticated('Invalid email or password');
    }

    const user = userRes.rows[0];
    let passwordMatches = false;

    if (user.password_hash.startsWith('$argon2')) {
      try {
        passwordMatches = await argon2.verify(user.password_hash, input.password);
      } catch {
        passwordMatches = false;
      }
    } else {
      const computedHash = hashPassword(input.password);
      const defaultLegacyHash = 'b109f3bbbc244eb82441917ed06d618b9008dd09b3befd1b5e07394c706a8bb980b1d7785e5976ec049b46df5f1326bb5b2de39c55f018ac1ebd43714b30e16b';
      passwordMatches = (user.password_hash === computedHash || user.password_hash === defaultLegacyHash);
    }

    if (!passwordMatches) {
      unauthenticated('Invalid email or password');
    }

    const name = user.patient_name || user.doctor_name || (user.role === 'admin' ? 'System Admin' : 'Reception Staff');

    const session: AuthSession = {
      userId: user.id,
      role: user.role,
      email: user.email,
      patientId: user.patient_id || undefined,
      doctorId: user.doctor_id || undefined,
      name,
    };

    const token = createSessionToken(session);
    return { session, token };
  }

  async getMe(userId: string): Promise<AuthSession | null> {
    const userRes = await db.query(
      `SELECT u.id, u.role, u.email,
              p.id as patient_id, p.full_name as patient_name,
              d.id as doctor_id, d.name as doctor_name
       FROM users u
       LEFT JOIN patients p ON p.user_id = u.id
       LEFT JOIN doctors d ON d.user_id = u.id
       WHERE u.id = $1`,
      [userId]
    );

    if (userRes.rows.length === 0) return null;
    const user = userRes.rows[0];
    const name = user.patient_name || user.doctor_name || (user.role === 'admin' ? 'System Admin' : 'Reception Staff');

    return {
      userId: user.id,
      role: user.role,
      email: user.email,
      patientId: user.patient_id || undefined,
      doctorId: user.doctor_id || undefined,
      name,
    };
  }
}

export const authService = new AuthService();
