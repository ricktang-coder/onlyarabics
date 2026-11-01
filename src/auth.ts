import { Context, Next } from 'hono';
import { Env, UserRecord } from './types';
import { normalizeEmail } from './email';

export interface AuthenticatedUser {
  userId: string;
  username: string;
  email?: string;
  role: 'student' | 'teacher' | 'admin';
  tokenVersion: number;
  isGuest: boolean;
}

const PBKDF2_ITERATIONS = 100000;
const JWT_EXPIRY_SECONDS = 30 * 24 * 60 * 60; // 30 days

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, '0');
  }
  return out;
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.trim();
  const len = Math.floor(clean.length / 2);
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16) || 0;
  }
  return out;
}

export function base64UrlEncodeBytes(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlEncode(str: string): string {
  return base64UrlEncodeBytes(new TextEncoder().encode(str));
}

/** Constant-time string comparison to avoid timing side-channels. */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

/** Generates a globally unique, non-enumerable user ID (e.g. `u_9f8e...`, 96-bit random). */
export function generateUserUid(): string {
  const buf = new Uint8Array(12);
  crypto.getRandomValues(buf);
  return `u_${bytesToHex(buf)}`;
}

/** Generates a 16-byte cryptographic salt encoded as 32 hex chars. */
export function generateSaltHex(): string {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return bytesToHex(buf);
}

/** Generates an unbiased 6-digit numeric OTP (`000000` - `999999`). */
export function generateSixDigitCode(): string {
  const maxUnbiased = 4294000000; // Largest multiple of 1,000,000 <= 2^32 - 1
  const arr = new Uint32Array(1);
  while (true) {
    crypto.getRandomValues(arr);
    if (arr[0] < maxUnbiased) {
      return String(arr[0] % 1000000).padStart(6, '0');
    }
  }
}

/** Derives a 256-bit PBKDF2-HMAC-SHA256 password hash as hex. */
export async function hashPasswordPbkdf2(password: string, saltHex: string): Promise<string> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    enc.encode(password),
    { name: 'PBKDF2' },
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: hexToBytes(saltHex),
      iterations: PBKDF2_ITERATIONS,
      hash: 'SHA-256',
    },
    keyMaterial,
    256
  );
  return bytesToHex(new Uint8Array(bits));
}

export async function verifyPasswordPbkdf2(
  password: string,
  saltHex: string,
  expectedHashHex: string
): Promise<boolean> {
  if (!saltHex || !expectedHashHex) return false;
  const computed = await hashPasswordPbkdf2(password, saltHex);
  return timingSafeEqual(computed, expectedHashHex);
}

export async function signJwtHmac(data: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return base64UrlEncodeBytes(new Uint8Array(sig));
}

/** One-way HMAC hash of an email verification code so plaintext OTPs are never stored in D1. */
export async function hashVerificationCode(
  email: string,
  purpose: string,
  code: string,
  secret: string
): Promise<string> {
  return signJwtHmac(`otp:${normalizeEmail(email)}:${purpose}:${code.trim()}`, secret);
}

export function isAdminEmail(email: string, env: Env): boolean {
  const target = normalizeEmail(email);
  if (!target) return false;
  const rawList = String(env.ADMIN_EMAILS || '');
  if (!rawList.trim()) return false;
  const admins = rawList
    .split(/[,;\s]+/)
    .map((s) => normalizeEmail(s))
    .filter(Boolean);
  return admins.includes(target);
}

/**
 * Admin rights come only from the ADMIN_EMAILS whitelist. A stored 'admin' role
 * for an address that is no longer whitelisted is downgraded to 'student', so
 * removing someone from the list revokes their access on the next request.
 */
export function resolveEffectiveRole(
  email: string,
  storedRole: string | null | undefined,
  env: Env
): 'student' | 'teacher' | 'admin' {
  if (isAdminEmail(email, env)) return 'admin';
  return storedRole === 'teacher' ? 'teacher' : 'student';
}

export async function issueUserJwt(
  user: Pick<UserRecord, 'uid' | 'email' | 'username' | 'role' | 'token_version'>,
  secret: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64UrlEncode(
    JSON.stringify({
      sub: user.uid,
      email: user.email,
      username: user.username,
      role: user.role,
      tv: user.token_version,
      iat: now,
      exp: now + JWT_EXPIRY_SECONDS,
    })
  );
  const signature = await signJwtHmac(`${header}.${payload}`, secret);
  return `${header}.${payload}.${signature}`;
}

/**
 * Verifies a signed JWT. Fails closed: without a configured secret nothing is
 * accepted, and the only valid signature is the real HMAC of header.payload.
 */
export async function verifyAndParseJwt(token: string, secret?: string): Promise<any | null> {
  try {
    const key = (secret || '').trim();
    if (key.length < 16) return null;
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const [headerB64, payloadB64, sigB64] = parts;

    const expectedSig = await signJwtHmac(`${headerB64}.${payloadB64}`, key);
    if (!timingSafeEqual(sigB64, expectedSig)) return null;

    const base64 = payloadB64.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(
      atob(base64)
        .split('')
        .map((c) => '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2))
        .join('')
    );
    const payload = JSON.parse(jsonPayload);

    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

/**
 * Authentication Middleware.
 * Verifies Bearer JWT signature AND validates `token_version` against the D1 `users`
 * table (1 indexed row read via `idx_users_uid`) so password resets immediately revoke old sessions.
 */
export async function authMiddleware(
  c: Context<{ Bindings: Env; Variables: { user: AuthenticatedUser } }>,
  next: Next
) {
  const authHeader = c.req.header('Authorization');
  let user: AuthenticatedUser = {
    userId: 'guest',
    username: '访客',
    role: 'student',
    tokenVersion: 0,
    isGuest: true,
  };

  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7).trim();
    if (token) {
      const payload = await verifyAndParseJwt(token, c.env.JWT_SECRET);
      if (payload && payload.sub) {
        const uid = String(payload.sub);
        const dbUser = await c.env.DB.prepare(
          'SELECT uid, email, username, role, token_version FROM users WHERE uid = ?'
        )
          .bind(uid)
          .first<{
            uid: string;
            email: string;
            username: string;
            role: 'student' | 'teacher' | 'admin';
            token_version: number;
          }>();

        if (dbUser && Number(payload.tv ?? 1) === Number(dbUser.token_version ?? 1)) {
          const effectiveRole = resolveEffectiveRole(dbUser.email, dbUser.role, c.env);
          user = {
            userId: dbUser.uid,
            username: dbUser.username,
            email: dbUser.email,
            role: effectiveRole,
            tokenVersion: dbUser.token_version,
            isGuest: false,
          };
        }
      }
    }
  }

  c.set('user', user);
  await next();
}
