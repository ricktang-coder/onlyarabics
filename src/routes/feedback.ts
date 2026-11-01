import { Hono } from 'hono';
import { Env } from '../types';
import { AuthenticatedUser } from '../auth';

const feedback = new Hono<{ Bindings: Env; Variables: { user: AuthenticatedUser } }>();

const MAX_LENGTH = 500;
const MIN_LENGTH = 2;
const DAILY_LIMIT = 5;

/** POST /api/feedback — any signed-in user can leave one short message. */
feedback.post('/', async (c) => {
  const user = c.get('user');
  if (!user || user.isGuest) {
    return c.json({ error: 'AUTH_REQUIRED', message: '请先登录后再提交反馈' }, 401);
  }

  let body: { content?: string; source?: string };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const content = String(body.content || '').trim();
  if (content.length < MIN_LENGTH) {
    return c.json({ error: '反馈内容太短，请至少写 2 个字' }, 400);
  }
  if (content.length > MAX_LENGTH) {
    return c.json({ error: `反馈内容不能超过 ${MAX_LENGTH} 字` }, 400);
  }

  const db = c.env.DB;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const countRow = await db
    .prepare('SELECT COUNT(1) AS cnt FROM user_feedback WHERE uid = ? AND created_at > ?')
    .bind(user.userId, since)
    .first<{ cnt: number }>();

  if ((countRow?.cnt || 0) >= DAILY_LIMIT) {
    return c.json({ error: `今天已经提交 ${DAILY_LIMIT} 条反馈啦，明天再来吧` }, 429);
  }

  const nowIso = new Date().toISOString();
  const source = String(body.source || 'settings').slice(0, 40);

  await db
    .prepare(
      'INSERT INTO user_feedback (uid, email, username, content, source, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .bind(user.userId, user.email || null, user.username || null, content, source, 'new', nowIso)
    .run();

  return c.json({ success: true, message: '反馈已收到，感谢你的建议！' });
});

export default feedback;
