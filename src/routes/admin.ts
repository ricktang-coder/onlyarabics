import { Hono } from 'hono';
import { Env } from '../types';
import { AuthenticatedUser } from '../auth';

const admin = new Hono<{ Bindings: Env; Variables: { user: AuthenticatedUser } }>();

function getBeijingTodayDate(): string {
  const now = new Date();
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  const beijingTime = new Date(utcMs + 8 * 3600000);
  return beijingTime.toISOString().split('T')[0];
}

/**
 * GET /api/admin/overview
 * Strictly restricted to `role === 'admin'` (via ADMIN_EMAILS whitelist).
 * Returns aggregate retention metrics and per-account learning telemetry.
 */
admin.get('/overview', async (c) => {
  const user = c.get('user');
  if (!user || user.isGuest || user.role !== 'admin') {
    return c.json({ error: 'FORBIDDEN', message: '无管理员访问权限' }, 403);
  }

  const db = c.env.DB;
  const todayBeijing = getBeijingTodayDate();
  const todayUtcPrefix = new Date().toISOString().slice(0, 10);

  const [usersRes, progressAggRes, checkinAggRes, sessionAggRes] = await Promise.all([
    db
      .prepare(
        `SELECT id, uid, email, username, role, daily_goal, review_goal, selected_level, theme,
                created_at, last_login_at, last_active_at
         FROM users
         ORDER BY id DESC
         LIMIT 500`
      )
      .all<{
        id: number;
        uid: string;
        email: string;
        username: string;
        role: string;
        daily_goal: number;
        review_goal: number;
        selected_level: string;
        theme: string;
        created_at: string;
        last_login_at: string | null;
        last_active_at: string | null;
      }>(),
    db
      .prepare(
        `SELECT user_id,
                COUNT(1) AS learned_count,
                SUM(CASE WHEN is_mastered = 1 OR interval >= 21 THEN 1 ELSE 0 END) AS mastered_count
         FROM user_progress
         GROUP BY user_id`
      )
      .all<{ user_id: string; learned_count: number; mastered_count: number }>(),
    db
      .prepare(
        `SELECT user_id,
                COUNT(1) AS checkin_days,
                MAX(checkin_date) AS latest_checkin
         FROM user_daily_checkin
         GROUP BY user_id`
      )
      .all<{ user_id: string; checkin_days: number; latest_checkin: string | null }>(),
    db
      .prepare(
        `SELECT user_id,
                COUNT(1) AS session_count,
                COALESCE(SUM(completed_words), 0) AS total_completed_words,
                COALESCE(SUM(duration_sec), 0) AS total_duration_sec
         FROM user_study_sessions
         GROUP BY user_id`
      )
      .all<{
        user_id: string;
        session_count: number;
        total_completed_words: number;
        total_duration_sec: number;
      }>(),
  ]);

  const progressMap = new Map(progressAggRes.results.map((r) => [r.user_id, r]));
  const checkinMap = new Map(checkinAggRes.results.map((r) => [r.user_id, r]));
  const sessionMap = new Map(sessionAggRes.results.map((r) => [r.user_id, r]));

  let totalProgressRecords = 0;
  let totalStudySessions = 0;
  let activeTodayUsers = 0;

  const users = usersRes.results.map((u) => {
    const prog = progressMap.get(u.uid);
    const chk = checkinMap.get(u.uid);
    const sess = sessionMap.get(u.uid);

    const learnedCount = Number(prog?.learned_count || 0);
    const masteredCount = Number(prog?.mastered_count || 0);
    const checkinDays = Number(chk?.checkin_days || 0);
    const sessionCount = Number(sess?.session_count || 0);
    const totalDurationSec = Number(sess?.total_duration_sec || 0);

    totalProgressRecords += learnedCount;
    totalStudySessions += sessionCount;

    const activeToday =
      chk?.latest_checkin === todayBeijing ||
      Boolean(u.last_active_at && u.last_active_at.startsWith(todayUtcPrefix));
    if (activeToday) activeTodayUsers++;

    return {
      id: u.id,
      uid: u.uid,
      email: u.email,
      username: u.username,
      role: u.uid === user.userId ? 'admin' : u.role,
      daily_goal: u.daily_goal,
      review_goal: u.review_goal,
      selected_level: u.selected_level,
      learned_count: learnedCount,
      mastered_count: masteredCount,
      checkin_days: checkinDays,
      session_count: sessionCount,
      study_minutes: Math.round(totalDurationSec / 60),
      created_at: u.created_at,
      last_login_at: u.last_login_at,
      last_active_at: u.last_active_at,
    };
  });

  return c.json({
    summary: {
      total_users: users.length,
      active_today_users: activeTodayUsers,
      total_progress_records: totalProgressRecords,
      total_study_sessions: totalStudySessions,
    },
    users,
  });
});

/** GET /api/admin/feedback — latest user feedback, admin only. */
admin.get('/feedback', async (c) => {
  const user = c.get('user');
  if (!user || user.isGuest || user.role !== 'admin') {
    return c.json({ error: 'FORBIDDEN', message: '无管理员访问权限' }, 403);
  }

  const db = c.env.DB;
  const [rows, newCountRow] = await Promise.all([
    db
      .prepare(
        `SELECT id, uid, email, username, content, source, status, created_at
         FROM user_feedback
         ORDER BY id DESC
         LIMIT 200`
      )
      .all<{
        id: number;
        uid: string;
        email: string | null;
        username: string | null;
        content: string;
        source: string | null;
        status: string;
        created_at: string;
      }>(),
    db
      .prepare("SELECT COUNT(1) AS cnt FROM user_feedback WHERE status = 'new'")
      .first<{ cnt: number }>(),
  ]);

  return c.json({
    total_new: newCountRow?.cnt || 0,
    total: rows.results.length,
    feedback: rows.results,
  });
});

export default admin;
