import { Hono, Context } from 'hono';
import { Env, UserPreferences, UserRecord } from '../types';
import {
  generateSaltHex,
  generateSixDigitCode,
  generateUserUid,
  hashPasswordPbkdf2,
  hashVerificationCode,
  issueUserJwt,
  resolveEffectiveRole,
  timingSafeEqual,
  verifyAndParseJwt,
  verifyPasswordPbkdf2,
} from '../auth';
import { normalizeEmail, sendVerificationEmail, validateEmailAddress } from '../email';

const auth = new Hono<{ Bindings: Env }>();

const EMAIL_COOLDOWN_SECONDS = 60;
const EMAIL_DAILY_MAX_SENDS = 5;
const IP_HOURLY_MAX_SENDS = 10;
const OTP_EXPIRY_MINUTES = 10;
const OTP_MAX_ATTEMPTS = 5;

/** Login brute-force throttle: failed attempts counted in a sliding window. */
const LOGIN_WINDOW_MINUTES = 15;
const LOGIN_MAX_FAILS_PER_ACCOUNT = 5;
const LOGIN_MAX_FAILS_PER_IP = 20;
const LOGIN_FAIL_RETENTION_HOURS = 24;
const LOGIN_FAILED_MESSAGE = '账号或密码错误，请核对后重试';
/** Fixed salt used to burn equal PBKDF2 time when the account does not exist. */
const DUMMY_SALT_HEX = '00000000000000000000000000000000';

/** Version string recorded with each registration as consent evidence. */
const LEGAL_VERSION = 'v1.0';
/** Privacy policy §6: OTP rows are purged within 24h after they expire. */
const OTP_PURGE_AFTER_HOURS = 24;

const VALID_LEVELS = new Set([
  'all',
  'beginner',
  'intermediate',
  'advanced',
  'syllabus',
  'syllabus:2',
  'syllabus:4',
  'syllabus:6',
  'syllabus:8',
  'syllabus:unmarked',
  'syllabus:key',
  'tem4',
  'tem4:key',
  'book1',
  'book2',
]);

const VALID_THEMES = new Set([
  'theme-cream',
  'theme-sage',
  'theme-slate',
  'theme-terracotta',
  'theme-matcha',
  'theme-sand',
  'theme-lavender',
]);

function getJwtSecret(env: Env): string | null {
  const secret = (env.JWT_SECRET || '').trim();
  return secret.length >= 16 ? secret : null;
}

function getClientIp(req: Request): string {
  return (
    req.headers.get('CF-Connecting-IP') ||
    req.headers.get('X-Forwarded-For')?.split(',')[0]?.trim() ||
    'unknown'
  );
}

function formatPublicUser(row: UserRecord, env: Env) {
  const role = resolveEffectiveRole(row.email, row.role, env);
  const preferences: UserPreferences = {
    daily_goal: Number(row.daily_goal || 20),
    review_goal: Number(row.review_goal || 20),
    selected_level: row.selected_level || 'all',
    theme: row.theme || 'theme-cream',
  };
  return {
    id: row.uid,
    uid: row.uid,
    email: row.email,
    username: row.username,
    role,
    avatar_url: row.avatar_url || null,
    created_at: row.created_at,
    last_login_at: row.last_login_at,
    preferences,
  };
}

function sanitizeUsernameInput(raw: string): { valid: boolean; username: string; error?: string } {
  const trimmed = String(raw || '').trim();
  if (!trimmed) return { valid: true, username: '' };
  if (trimmed.length < 2 || trimmed.length > 24) {
    return { valid: false, username: trimmed, error: '昵称长度需在 2 到 24 个字符之间' };
  }
  if (trimmed.includes('@') || /[\s<>"'`\\/]/.test(trimmed)) {
    return { valid: false, username: trimmed, error: '昵称不能包含空格、@ 或特殊符号' };
  }
  return { valid: true, username: trimmed };
}

async function generateAvailableUsername(db: D1Database, email: string, preferredRaw?: string): Promise<{ ok: boolean; username: string; error?: string }> {
  if (preferredRaw && preferredRaw.trim()) {
    const check = sanitizeUsernameInput(preferredRaw);
    if (!check.valid) return { ok: false, username: '', error: check.error };
    const existing = await db
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .bind(check.username)
      .first();
    if (existing) {
      return { ok: false, username: '', error: '该昵称已被占用，请换一个昵称' };
    }
    return { ok: true, username: check.username };
  }

  const localPart = email.split('@')[0].replace(/[^a-zA-Z0-9_\u4e00-\u9fa5-]/g, '').slice(0, 14) || 'user';
  const base = localPart.length >= 2 ? localPart : `user_${localPart}`;

  const directTaken = await db
    .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
    .bind(base)
    .first();
  if (!directTaken) return { ok: true, username: base };

  for (let i = 0; i < 8; i++) {
    const rand = String(Math.floor(1000 + Math.random() * 9000));
    const candidate = `${base}_${rand}`;
    const taken = await db
      .prepare('SELECT id FROM users WHERE username = ? COLLATE NOCASE')
      .bind(candidate)
      .first();
    if (!taken) return { ok: true, username: candidate };
  }

  return { ok: true, username: `${base}_${Date.now().toString().slice(-6)}` };
}

function loginAccountKey(identifier: string): string {
  return identifier.trim().toLowerCase();
}

/**
 * Returns a lockout message when the account or IP has too many recent failed
 * logins. Fails open (logs and allows) if the throttle table is unavailable, so
 * a missing migration cannot lock every user out.
 */
async function checkLoginThrottle(db: D1Database, accountKey: string, ip: string): Promise<string | null> {
  try {
    const floorIso = new Date(Date.now() - LOGIN_WINDOW_MINUTES * 60 * 1000).toISOString();
    const accountRow = await db
      .prepare('SELECT COUNT(1) AS cnt FROM auth_login_failures WHERE account_key = ? AND created_at > ?')
      .bind(accountKey, floorIso)
      .first<{ cnt: number }>();
    if ((accountRow?.cnt || 0) >= LOGIN_MAX_FAILS_PER_ACCOUNT) {
      return `该账号登录失败次数过多，请 ${LOGIN_WINDOW_MINUTES} 分钟后再试，或使用「忘记密码」重置`;
    }
    if (ip !== 'unknown') {
      const ipRow = await db
        .prepare('SELECT COUNT(1) AS cnt FROM auth_login_failures WHERE ip = ? AND created_at > ?')
        .bind(ip, floorIso)
        .first<{ cnt: number }>();
      if ((ipRow?.cnt || 0) >= LOGIN_MAX_FAILS_PER_IP) {
        return `当前网络登录失败次数过多，请 ${LOGIN_WINDOW_MINUTES} 分钟后再试`;
      }
    }
  } catch (err) {
    console.error('login throttle check failed (is auth_login_failures migrated?):', err);
  }
  return null;
}

async function recordLoginFailure(db: D1Database, accountKey: string, ip: string): Promise<void> {
  try {
    const nowMs = Date.now();
    const purgeFloorIso = new Date(nowMs - LOGIN_FAIL_RETENTION_HOURS * 60 * 60 * 1000).toISOString();
    await db.batch([
      db
        .prepare('INSERT INTO auth_login_failures (account_key, ip, created_at) VALUES (?, ?, ?)')
        .bind(accountKey, ip, new Date(nowMs).toISOString()),
      db.prepare('DELETE FROM auth_login_failures WHERE created_at < ?').bind(purgeFloorIso),
    ]);
  } catch (err) {
    console.error('login failure record failed:', err);
  }
}

async function clearLoginFailures(db: D1Database, accountKeys: string[]): Promise<void> {
  const keys = Array.from(new Set(accountKeys.filter(Boolean)));
  if (keys.length === 0) return;
  try {
    const placeholders = keys.map(() => '?').join(',');
    await db.prepare(`DELETE FROM auth_login_failures WHERE account_key IN (${placeholders})`).bind(...keys).run();
  } catch (err) {
    console.error('login failure cleanup failed:', err);
  }
}

async function resolveAuthenticatedDbUser(
  c: Context<{ Bindings: Env }>
): Promise<{ secret: string; user: UserRecord } | null> {
  const secret = getJwtSecret(c.env);
  if (!secret) return null;
  const authHeader = c.req.header('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const token = authHeader.substring(7).trim();
  const payload = await verifyAndParseJwt(token, secret);
  if (!payload || !payload.sub) return null;
  const user = await c.env.DB.prepare('SELECT * FROM users WHERE uid = ?')
    .bind(String(payload.sub))
    .first<UserRecord>();
  if (!user) return null;
  if (Number(payload.tv ?? 1) !== Number(user.token_version ?? 1)) return null;
  return { secret, user };
}

// 1. Send 6-Digit Email Verification Code (Register or Reset Password)
auth.post('/send-code', async (c) => {
  const secret = getJwtSecret(c.env);
  if (!secret) {
    return c.json({ error: 'AUTH_NOT_CONFIGURED', message: '认证密钥尚未配置（缺少 JWT_SECRET）' }, 503);
  }

  let body: { email?: string; purpose?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const emailCheck = validateEmailAddress(body.email || '');
  if (!emailCheck.valid) {
    return c.json({ error: emailCheck.error || '邮箱格式无效' }, 400);
  }
  const email = emailCheck.email;

  const purpose = body.purpose === 'reset_password' ? 'reset_password' : 'register';
  const db = c.env.DB;

  // Privacy policy §6 — purge rows that expired more than 24h ago. Best effort:
  // a cleanup failure must never block issuing a new code.
  try {
    const purgeFloorIso = new Date(Date.now() - OTP_PURGE_AFTER_HOURS * 60 * 60 * 1000).toISOString();
    await db.prepare('DELETE FROM email_verification_codes WHERE expires_at < ?').bind(purgeFloorIso).run();
  } catch (err) {
    console.error('otp purge failed:', err);
  }

  const existingUser = await db
    .prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: number }>();

  if (purpose === 'register' && existingUser) {
    return c.json({ error: '该邮箱已注册账号，请直接切换至「登录」页使用' }, 409);
  }
  if (purpose === 'reset_password' && !existingUser) {
    // Same response as a real send so the endpoint cannot be used to probe
    // which addresses have accounts. Nothing is stored or sent.
    return c.json({
      success: true,
      message: '若该邮箱已注册，验证码将发送至该邮箱，10 分钟内有效（若未收到请查看垃圾箱）',
      cooldown: EMAIL_COOLDOWN_SECONDS,
    });
  }

  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const cooldownFloorIso = new Date(nowMs - EMAIL_COOLDOWN_SECONDS * 1000).toISOString();
  const dayFloorIso = new Date(nowMs - 24 * 60 * 60 * 1000).toISOString();
  const hourFloorIso = new Date(nowMs - 60 * 60 * 1000).toISOString();
  const clientIp = getClientIp(c.req.raw);

  // Cooldown check (60s per email + purpose)
  const recentRow = await db
    .prepare(
      'SELECT created_at FROM email_verification_codes WHERE email = ? AND purpose = ? AND created_at > ? ORDER BY id DESC LIMIT 1'
    )
    .bind(email, purpose, cooldownFloorIso)
    .first<{ created_at: string }>();

  if (recentRow) {
    const elapsedSec = Math.max(0, Math.floor((nowMs - new Date(recentRow.created_at).getTime()) / 1000));
    const retryAfter = Math.max(1, EMAIL_COOLDOWN_SECONDS - elapsedSec);
    return c.json(
      {
        error: `验证码发送过于频繁，请在 ${retryAfter} 秒后重试`,
        retry_after: retryAfter,
      },
      429
    );
  }

  // Daily email cap (5 per 24h)
  const dailyCountRow = await db
    .prepare('SELECT COUNT(1) AS cnt FROM email_verification_codes WHERE email = ? AND created_at > ?')
    .bind(email, dayFloorIso)
    .first<{ cnt: number }>();

  if ((dailyCountRow?.cnt || 0) >= EMAIL_DAILY_MAX_SENDS) {
    return c.json({ error: '该邮箱今日验证码发送次数已达上限（5次），请 24 小时后再试' }, 429);
  }

  // Hourly IP cap (10 per 1h)
  if (clientIp && clientIp !== 'unknown' && clientIp !== '127.0.0.1' && clientIp !== '::1') {
    const ipCountRow = await db
      .prepare('SELECT COUNT(1) AS cnt FROM email_verification_codes WHERE request_ip = ? AND created_at > ?')
      .bind(clientIp, hourFloorIso)
      .first<{ cnt: number }>();
    if ((ipCountRow?.cnt || 0) >= IP_HOURLY_MAX_SENDS) {
      return c.json({ error: '当前网络获取验证码过于频繁，请 1 小时后再试' }, 429);
    }
  }

  const code = generateSixDigitCode();
  const codeHash = await hashVerificationCode(email, purpose, code, secret);
  const expiresAtIso = new Date(nowMs + OTP_EXPIRY_MINUTES * 60 * 1000).toISOString();

  const insertRes = await db
    .prepare(
      `INSERT INTO email_verification_codes (email, purpose, code_hash, attempts, expires_at, request_ip, created_at)
       VALUES (?, ?, ?, 0, ?, ?, ?)`
    )
    .bind(email, purpose, codeHash, expiresAtIso, clientIp, nowIso)
    .run();

  const sendRes = await sendVerificationEmail(c.env, email, code, purpose);
  if (!sendRes.ok) {
    const insertedId = insertRes.meta?.last_row_id;
    if (insertedId) {
      await db.prepare('DELETE FROM email_verification_codes WHERE id = ?').bind(insertedId).run();
    }
    return c.json(
      {
        error: sendRes.error || '验证码发送失败，请稍后重试',
        code: sendRes.mode,
      },
      sendRes.mode === 'unconfigured' ? 503 : 502
    );
  }

  const responsePayload: Record<string, any> = {
    success: true,
    message:
      purpose === 'reset_password'
        ? '若该邮箱已注册，验证码将发送至该邮箱，10 分钟内有效（若未收到请查看垃圾箱）'
        : '验证码已发送至您的邮箱，10 分钟内有效（若未收到请查看垃圾箱）',
    cooldown: EMAIL_COOLDOWN_SECONDS,
  };
  if (sendRes.mode === 'dev_console' && c.env.ENVIRONMENT !== 'production') {
    responsePayload.dev_code = code;
  }

  return c.json(responsePayload);
});

// Helper: Verify and atomically consume an OTP code
async function verifyAndConsumeOtp(
  db: D1Database,
  email: string,
  purpose: 'register' | 'reset_password',
  codeInput: string,
  secret: string
): Promise<{ ok: boolean; error?: string }> {
  const code = String(codeInput || '').trim();
  if (!/^\d{6}$/.test(code)) {
    return { ok: false, error: '请输入完整的 6 位数字验证码' };
  }

  const nowIso = new Date().toISOString();
  const otpRow = await db
    .prepare(
      `SELECT id, code_hash, attempts, expires_at
       FROM email_verification_codes
       WHERE email = ? AND purpose = ? AND used_at IS NULL
       ORDER BY id DESC
       LIMIT 1`
    )
    .bind(email, purpose)
    .first<{ id: number; code_hash: string; attempts: number; expires_at: string }>();

  if (!otpRow || otpRow.expires_at <= nowIso) {
    return { ok: false, error: '验证码无效或已过期，请重新点击获取验证码' };
  }

  if ((otpRow.attempts || 0) >= OTP_MAX_ATTEMPTS) {
    return { ok: false, error: '验证码输错次数过多已失效，请重新获取验证码' };
  }

  const expectedHash = await hashVerificationCode(email, purpose, code, secret);
  if (!timingSafeEqual(otpRow.code_hash, expectedHash)) {
    const nextAttempts = (otpRow.attempts || 0) + 1;
    await db
      .prepare('UPDATE email_verification_codes SET attempts = ? WHERE id = ?')
      .bind(nextAttempts, otpRow.id)
      .run();
    const remaining = Math.max(0, OTP_MAX_ATTEMPTS - nextAttempts);
    return {
      ok: false,
      error: remaining > 0 ? `验证码不正确，还剩 ${remaining} 次尝试机会` : '验证码输错次数过多已失效，请重新获取',
    };
  }

  // Consume all unused codes of this purpose for this email
  await db
    .prepare('UPDATE email_verification_codes SET used_at = ? WHERE email = ? AND purpose = ? AND used_at IS NULL')
    .bind(nowIso, email, purpose)
    .run();

  return { ok: true };
}

// 2. Register New Account with Email + Verification Code + Password
auth.post('/register', async (c) => {
  const secret = getJwtSecret(c.env);
  if (!secret) {
    return c.json({ error: 'AUTH_NOT_CONFIGURED', message: '认证密钥尚未配置（缺少 JWT_SECRET）' }, 503);
  }

  let body: { email?: string; code?: string; password?: string; username?: string; agreed_legal?: boolean };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const emailCheck = validateEmailAddress(body.email || '');
  if (!emailCheck.valid) {
    return c.json({ error: emailCheck.error || '邮箱格式无效' }, 400);
  }
  const email = emailCheck.email;

  // Legal consent is mandatory and enforced server-side (strict boolean, so
  // "true" as a string or 1 cannot slip through).
  if (body.agreed_legal !== true) {
    return c.json({ error: '请先阅读并同意《用户服务协议》与《隐私政策》' }, 400);
  }

  const password = String(body.password || '');
  if (password.length < 6 || password.length > 72) {
    return c.json({ error: '登录密码长度需在 6 到 72 位之间' }, 400);
  }

  const db = c.env.DB;
  const existingEmail = await db.prepare('SELECT id FROM users WHERE email = ?').bind(email).first();
  if (existingEmail) {
    return c.json({ error: '该邮箱已注册账号，请直接登录' }, 409);
  }

  // Validate nickname uniqueness before burning the OTP code!
  const unameRes = await generateAvailableUsername(db, email, body.username);
  if (!unameRes.ok) {
    return c.json({ error: unameRes.error || '昵称不可用' }, 409);
  }

  const otpCheck = await verifyAndConsumeOtp(db, email, 'register', body.code || '', secret);
  if (!otpCheck.ok) {
    return c.json({ error: otpCheck.error || '验证码校验失败' }, 400);
  }

  const uid = generateUserUid();
  const saltHex = generateSaltHex();
  const passwordHash = await hashPasswordPbkdf2(password, saltHex);
  const role = resolveEffectiveRole(email, 'student', c.env);
  const nowIso = new Date().toISOString();
  const clientIp = getClientIp(c.req.raw);

  await db
    .prepare(
      `INSERT INTO users (
        uid, email, username, password_hash, password_salt, role,
        email_verified, token_version, daily_goal, review_goal, selected_level, theme,
        register_ip, created_at, updated_at, last_login_at, last_active_at,
        legal_agreed_at, legal_version
      ) VALUES (?, ?, ?, ?, ?, ?, 1, 1, 20, 20, 'all', 'theme-cream', ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(uid, email, unameRes.username, passwordHash, saltHex, role, clientIp, nowIso, nowIso, nowIso, nowIso, nowIso, LEGAL_VERSION)
    .run();

  const createdUser = await db.prepare('SELECT * FROM users WHERE uid = ?').bind(uid).first<UserRecord>();
  if (!createdUser) {
    return c.json({ error: '账号创建失败，请重试' }, 500);
  }

  const token = await issueUserJwt(createdUser, secret);
  return c.json({
    success: true,
    message: `注册成功，欢迎加入 OnlyArabics，${createdUser.username}！`,
    token,
    user: formatPublicUser(createdUser, c.env),
  });
});

// 3. Login with Email or Username + Password
auth.post('/login', async (c) => {
  const secret = getJwtSecret(c.env);
  if (!secret) {
    return c.json({ error: 'AUTH_NOT_CONFIGURED', message: '登录服务尚未配置（缺少 JWT_SECRET）' }, 503);
  }

  let body: { identifier?: string; username?: string; email?: string; password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const rawIdentifier = String(body.identifier || body.email || body.username || '').trim();
  const password = String(body.password || '');

  if (!rawIdentifier) return c.json({ error: '请输入注册邮箱或用户名' }, 400);
  if (!password) return c.json({ error: '请输入登录密码' }, 400);

  const db = c.env.DB;
  const normalized = normalizeEmail(rawIdentifier);
  const accountKey = loginAccountKey(rawIdentifier);
  const clientIp = getClientIp(c.req.raw);

  const throttled = await checkLoginThrottle(db, accountKey, clientIp);
  if (throttled) {
    return c.json({ error: throttled, retry_after: LOGIN_WINDOW_MINUTES * 60 }, 429);
  }

  const userRow = rawIdentifier.includes('@')
    ? await db.prepare('SELECT * FROM users WHERE email = ?').bind(normalized).first<UserRecord>()
    : await db
        .prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE')
        .bind(rawIdentifier)
        .first<UserRecord>();

  if (!userRow) {
    // Burn the same PBKDF2 cost so response timing does not reveal whether
    // the account exists; the message is identical to a wrong password.
    await hashPasswordPbkdf2(password, DUMMY_SALT_HEX);
    await recordLoginFailure(db, accountKey, clientIp);
    return c.json({ error: LOGIN_FAILED_MESSAGE }, 401);
  }

  const passOk = await verifyPasswordPbkdf2(password, userRow.password_salt, userRow.password_hash);
  if (!passOk) {
    await recordLoginFailure(db, accountKey, clientIp);
    return c.json({ error: LOGIN_FAILED_MESSAGE }, 401);
  }

  await clearLoginFailures(db, [accountKey, loginAccountKey(userRow.email), loginAccountKey(userRow.username)]);

  const nowIso = new Date().toISOString();
  const targetRole = resolveEffectiveRole(userRow.email, userRow.role, c.env);

  await db
    .prepare('UPDATE users SET last_login_at = ?, last_active_at = ?, role = ? WHERE uid = ?')
    .bind(nowIso, nowIso, targetRole, userRow.uid)
    .run();

  userRow.last_login_at = nowIso;
  userRow.last_active_at = nowIso;
  userRow.role = targetRole;

  const token = await issueUserJwt(userRow, secret);
  return c.json({
    success: true,
    token,
    user: formatPublicUser(userRow, c.env),
  });
});

// 4. Reset Forgotten Password via Email OTP
auth.post('/reset-password', async (c) => {
  const secret = getJwtSecret(c.env);
  if (!secret) {
    return c.json({ error: 'AUTH_NOT_CONFIGURED', message: '认证密钥尚未配置' }, 503);
  }

  let body: { email?: string; code?: string; new_password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const emailCheck = validateEmailAddress(body.email || '');
  if (!emailCheck.valid) {
    return c.json({ error: emailCheck.error || '邮箱格式无效' }, 400);
  }
  const email = emailCheck.email;

  const newPassword = String(body.new_password || '');
  if (newPassword.length < 6 || newPassword.length > 72) {
    return c.json({ error: '新密码长度需在 6 到 72 位之间' }, 400);
  }

  const db = c.env.DB;
  const userRow = await db.prepare('SELECT * FROM users WHERE email = ?').bind(email).first<UserRecord>();
  if (!userRow) {
    return c.json({ error: '验证码无效或已过期，请重新点击获取验证码' }, 400);
  }

  const otpCheck = await verifyAndConsumeOtp(db, email, 'reset_password', body.code || '', secret);
  if (!otpCheck.ok) {
    return c.json({ error: otpCheck.error || '验证码校验失败' }, 400);
  }

  const newSalt = generateSaltHex();
  const newHash = await hashPasswordPbkdf2(newPassword, newSalt);
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `UPDATE users
       SET password_hash = ?, password_salt = ?, token_version = token_version + 1, updated_at = ?
       WHERE uid = ?`
    )
    .bind(newHash, newSalt, nowIso, userRow.uid)
    .run();

  await clearLoginFailures(db, [loginAccountKey(userRow.email), loginAccountKey(userRow.username)]);

  return c.json({
    success: true,
    message: '密码已成功重置，请使用新密码登录',
  });
});

// 5. Verify Current Session & Fetch Latest Cloud Preferences
auth.get('/verify', async (c) => {
  const resolved = await resolveAuthenticatedDbUser(c);
  if (!resolved) {
    return c.json({ valid: false, error: '登录凭证已失效，请重新登录' }, 401);
  }
  const { user } = resolved;
  const nowIso = new Date().toISOString();
  const effectiveRole = resolveEffectiveRole(user.email, user.role, c.env);

  if (effectiveRole !== user.role) {
    await c.env.DB.prepare('UPDATE users SET role = ?, last_active_at = ? WHERE uid = ?')
      .bind(effectiveRole, nowIso, user.uid)
      .run();
    user.role = effectiveRole;
  } else {
    await c.env.DB.prepare('UPDATE users SET last_active_at = ? WHERE uid = ?')
      .bind(nowIso, user.uid)
      .run();
  }

  return c.json({
    valid: true,
    user: formatPublicUser(user, c.env),
  });
});

// 6. Persist Per-Account Preferences in D1
auth.put('/preferences', async (c) => {
  const resolved = await resolveAuthenticatedDbUser(c);
  if (!resolved) {
    return c.json({ error: 'AUTH_REQUIRED', message: '请先登录' }, 401);
  }
  const { user } = resolved;

  let body: Partial<UserPreferences>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const dailyGoal =
    body.daily_goal !== undefined
      ? Math.max(5, Math.min(200, parseInt(String(body.daily_goal), 10) || 20))
      : user.daily_goal || 20;

  const reviewGoal =
    body.review_goal !== undefined
      ? Math.max(5, Math.min(200, parseInt(String(body.review_goal), 10) || 20))
      : user.review_goal || 20;

  const selectedLevel =
    body.selected_level !== undefined && VALID_LEVELS.has(String(body.selected_level))
      ? String(body.selected_level)
      : user.selected_level || 'all';

  const theme =
    body.theme !== undefined && VALID_THEMES.has(String(body.theme))
      ? String(body.theme)
      : user.theme || 'theme-cream';

  const nowIso = new Date().toISOString();
  await c.env.DB.prepare(
    `UPDATE users
     SET daily_goal = ?, review_goal = ?, selected_level = ?, theme = ?, updated_at = ?, last_active_at = ?
     WHERE uid = ?`
  )
    .bind(dailyGoal, reviewGoal, selectedLevel, theme, nowIso, nowIso, user.uid)
    .run();

  return c.json({
    success: true,
    preferences: {
      daily_goal: dailyGoal,
      review_goal: reviewGoal,
      selected_level: selectedLevel,
      theme,
    },
  });
});

// 7. Update User Profile Nickname
auth.put('/profile', async (c) => {
  const resolved = await resolveAuthenticatedDbUser(c);
  if (!resolved) {
    return c.json({ error: 'AUTH_REQUIRED', message: '请先登录' }, 401);
  }
  const { secret, user } = resolved;

  let body: { username?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const check = sanitizeUsernameInput(body.username || '');
  if (!check.valid || !check.username) {
    return c.json({ error: check.error || '请输入有效的新昵称（2-24字符）' }, 400);
  }

  const conflict = await c.env.DB.prepare(
    'SELECT id FROM users WHERE username = ? COLLATE NOCASE AND uid != ?'
  )
    .bind(check.username, user.uid)
    .first();

  if (conflict) {
    return c.json({ error: '该昵称已被其他用户使用，请换一个昵称' }, 409);
  }

  const nowIso = new Date().toISOString();
  await c.env.DB.prepare('UPDATE users SET username = ?, updated_at = ? WHERE uid = ?')
    .bind(check.username, nowIso, user.uid)
    .run();

  user.username = check.username;
  user.updated_at = nowIso;
  const refreshedToken = await issueUserJwt(user, secret);

  return c.json({
    success: true,
    message: '昵称已更新',
    token: refreshedToken,
    user: formatPublicUser(user, c.env),
  });
});

// 7b. Update Avatar (client-resized data URL, size-capped server side)
const AVATAR_MAX_BYTES = 64 * 1024;
const AVATAR_DATA_URL = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/;

auth.put('/avatar', async (c) => {
  const resolved = await resolveAuthenticatedDbUser(c);
  if (!resolved) {
    return c.json({ error: 'AUTH_REQUIRED', message: '请先登录' }, 401);
  }
  const { user } = resolved;

  let body: { avatar?: string | null };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const raw = body.avatar;
  let value: string | null = null;

  if (raw !== null && raw !== undefined && raw !== '') {
    if (typeof raw !== 'string' || !AVATAR_DATA_URL.test(raw)) {
      return c.json({ error: '头像格式不支持，请上传 PNG / JPEG / WebP 图片' }, 400);
    }
    const base64 = raw.slice(raw.indexOf(',') + 1);
    const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
    const bytes = Math.floor((base64.length * 3) / 4) - padding;
    if (bytes > AVATAR_MAX_BYTES) {
      return c.json({ error: '头像文件过大（上限 64KB），请压缩后重试' }, 413);
    }
    value = raw;
  }

  const nowIso = new Date().toISOString();
  await c.env.DB.prepare('UPDATE users SET avatar_url = ?, updated_at = ? WHERE uid = ?')
    .bind(value, nowIso, user.uid)
    .run();

  user.avatar_url = value;
  user.updated_at = nowIso;

  return c.json({
    success: true,
    message: value ? '头像已更新' : '已恢复默认头像',
    user: formatPublicUser(user, c.env),
  });
});

// 8. Change Password for Logged-In User (Invalidates Other Old Device Tokens)
auth.post('/change-password', async (c) => {
  const resolved = await resolveAuthenticatedDbUser(c);
  if (!resolved) {
    return c.json({ error: 'AUTH_REQUIRED', message: '请先登录' }, 401);
  }
  const { secret, user } = resolved;

  let body: { current_password?: string; new_password?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const currentPassword = String(body.current_password || '');
  const newPassword = String(body.new_password || '');

  if (!currentPassword) return c.json({ error: '请输入当前密码' }, 400);
  if (newPassword.length < 6 || newPassword.length > 72) {
    return c.json({ error: '新密码长度需在 6 到 72 位之间' }, 400);
  }

  const validCurrent = await verifyPasswordPbkdf2(currentPassword, user.password_salt, user.password_hash);
  if (!validCurrent) {
    return c.json({ error: '当前密码输入不正确' }, 401);
  }

  const newSalt = generateSaltHex();
  const newHash = await hashPasswordPbkdf2(newPassword, newSalt);
  const nextTv = Number(user.token_version || 1) + 1;
  const nowIso = new Date().toISOString();

  await c.env.DB.prepare(
    `UPDATE users
     SET password_hash = ?, password_salt = ?, token_version = ?, updated_at = ?
     WHERE uid = ?`
  )
    .bind(newHash, newSalt, nextTv, nowIso, user.uid)
    .run();

  user.token_version = nextTv;
  const freshToken = await issueUserJwt(user, secret);

  return c.json({
    success: true,
    message: '密码修改成功，其他设备上的旧登录态已自动下线',
    token: freshToken,
  });
});

auth.post('/logout', async (c) => {
  return c.json({ success: true });
});

export default auth;
