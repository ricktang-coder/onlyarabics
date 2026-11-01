import { Hono } from 'hono';
import { Env } from '../types';
import { AuthenticatedUser } from '../auth';
import { calculateCheckinStreak, getBeijingDateInfo } from '../db';

const checkin = new Hono<{ Bindings: Env; Variables: { user: AuthenticatedUser } }>();

/**
 * POST /api/checkin
 * Records daily streak checkin for current user (Beijing Time UTC+8)
 */
checkin.post('/', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const { todayStr } = getBeijingDateInfo();
  const nowIso = new Date().toISOString();

  const existing = await db
    .prepare('SELECT id FROM user_daily_checkin WHERE user_id = ? AND checkin_date = ?')
    .bind(user.userId, todayStr)
    .first<{ id: number }>();

  if (!existing) {
    await db
      .prepare('INSERT INTO user_daily_checkin (user_id, checkin_date, created_at) VALUES (?, ?, ?)')
      .bind(user.userId, todayStr, nowIso)
      .run();
  }

  const streak = await calculateCheckinStreak(db, user.userId);

  return c.json({
    success: true,
    message: `签到成功！已连续打卡 ${streak} 天 🎉`,
    streak_days: streak,
    today_checked: true,
  });
});

export default checkin;
