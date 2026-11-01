import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { Env } from './types';
import { authMiddleware, AuthenticatedUser } from './auth';

import authRoutes from './routes/auth';
import dashboardRoutes from './routes/dashboard';
import sessionRoutes from './routes/session';
import wordsRoutes from './routes/words';
import checkinRoutes from './routes/checkin';
import levelsRoutes from './routes/levels';
import adminRoutes from './routes/admin';
import feedbackRoutes from './routes/feedback';

const app = new Hono<{ Bindings: Env; Variables: { user: AuthenticatedUser } }>();

app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  if (message.includes('exceeded D1') || message.includes('row read limit')) {
    return c.json({
      error: 'D1_DAILY_READ_LIMIT',
      message: '词库服务今日读取额度已用完；请升级 D1 配额，或等待 UTC 零点（北京时间 08:00）重置。',
    }, 503);
  }
  console.error('Unhandled Worker error:', err);
  return c.json({
    error: 'INTERNAL_ERROR',
    message: '服务器暂时不可用，请稍后重试。',
  }, 500);
});

// 0. Security headers for Worker-generated responses (API, audio). Static
// assets get the same set from public/_headers.
const SECURITY_HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  'Strict-Transport-Security': 'max-age=31536000',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

app.use('*', async (c, next) => {
  await next();
  // Responses passed through from ASSETS/R2 can have immutable headers.
  const res = new Response(c.res.body, c.res);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    if (!res.headers.has(name)) res.headers.set(name, value);
  }
  if (new URL(c.req.url).pathname.startsWith('/api/') && !res.headers.has('Cache-Control')) {
    res.headers.set('Cache-Control', 'no-store');
  }
  c.res = res;
});

// 1. Global CORS Middleware
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'Authorization'],
  })
);

// WeChat Domain Verification File (微信网站管理员认证)
app.get('/3cf1e3bb261c349ce4b5f9f4b7c2ea94.txt', (c) => {
  return c.text('a6e271d725e0e8da7e5f28ad34fb17f0c08b5ba9');
});

// 2. Root Health Check (Public)
app.get('/api/health', (c) => {
  return c.json({
    status: 'healthy',
    runtime: 'cloudflare-workers',
    timestamp: new Date().toISOString(),
  });
});

// 3. Auth Endpoints (Public entrypoints + self-verified profile/preferences endpoints)
app.route('/api/auth', authRoutes);
app.post('/api/login', async (c) => {
  return authRoutes.fetch(new Request(new URL('/login', c.req.url).toString(), c.req.raw), c.env, c.executionCtx);
});
app.post('/api/logout', async (c) => {
  return authRoutes.fetch(new Request(new URL('/logout', c.req.url).toString(), c.req.raw), c.env, c.executionCtx);
});

// 4. Global Auth Middleware & Mandatory Login Guard for Protected APIs
const PUBLIC_API_PATHS = new Set(['/api/login', '/api/logout', '/api/health']);

app.use('/api/*', async (c, next) => {
  if (c.req.method.toUpperCase() === 'OPTIONS') return next();
  const path = new URL(c.req.url).pathname;
  if (PUBLIC_API_PATHS.has(path) || path.startsWith('/api/auth/')) {
    return next();
  }
  await authMiddleware(c, async () => {});
  const user = c.get('user');
  if (!user || user.isGuest) {
    return c.json({ error: 'AUTH_REQUIRED', message: '请先登录或使用邮箱注册账号' }, 401);
  }
  return next();
});

// 5. Mount Authenticated API Routes
app.route('/api/dashboard', dashboardRoutes);
app.route('/api/session', sessionRoutes);
app.route('/api/words', wordsRoutes);
app.route('/api', wordsRoutes); // Mounts /api/word/:id, /api/root/:root, /api/reset
app.route('/api/checkin', checkinRoutes);
app.route('/api/levels', levelsRoutes);
app.route('/api/admin', adminRoutes);
app.route('/api/feedback', feedbackRoutes);

// 6. Cloudflare Audio Streaming Route (/static/audios/:filename)
app.get('/static/audios/:filename', async (c) => {
  const filename = c.req.param('filename');
  const bucket = c.env.AUDIO_BUCKET;

  if (bucket) {
    try {
      const object = await bucket.get(filename);
      if (object) {
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set('etag', object.httpEtag);
        headers.set('Cache-Control', 'public, max-age=2592000'); // 30-day CDN cache
        headers.set('Content-Type', 'audio/mpeg');
        return new Response(object.body, { headers });
      }
    } catch (e) {
      console.warn('R2 bucket fetch error, falling back to static assets:', e);
    }
  }

  // Fallback to static assets
  if (c.env.ASSETS) {
    return await c.env.ASSETS.fetch(c.req.raw);
  }

  return c.text('Audio asset not found', 404);
});

export default app;
