import { Hono } from 'hono';
import { Env, DashboardResponse } from '../types';
import { AuthenticatedUser } from '../auth';
import { calculateCheckinStreak, edgeCachedJson, getBeijingDateInfo } from '../db';
import { buildLevelFilter } from '../levelFilter';

const dashboard = new Hono<{ Bindings: Env; Variables: { user: AuthenticatedUser } }>();

const STATIC_CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

interface GlobalVocabCounts {
  totalWords: number;
  approvedExampleCount: number;
  expiresAt: number;
}

interface LevelVocabCounts {
  levelTotalWords: number;
  levelApprovedWords: number;
  expiresAt: number;
}

let globalCountsCache: GlobalVocabCounts | null = null;
const levelCountsCache = new Map<string, LevelVocabCounts>();

async function getGlobalVocabCounts(db: D1Database, nowMs: number, origin: string): Promise<GlobalVocabCounts> {
  if (globalCountsCache && globalCountsCache.expiresAt > nowMs) {
    return globalCountsCache;
  }
  const countsRow = await edgeCachedJson(origin, 'dashboard:global-counts', STATIC_CACHE_TTL_MS / 1000, () =>
    db
      .prepare(`
        SELECT
          COUNT(*) as total_cnt,
          SUM(CASE WHEN example_ar IS NOT NULL AND TRIM(example_ar) != '' THEN 1 ELSE 0 END) as approved_cnt
        FROM words
      `)
      .first<{ total_cnt: number; approved_cnt: number }>()
  );

  globalCountsCache = {
    totalWords: countsRow?.total_cnt || 0,
    approvedExampleCount: countsRow?.approved_cnt || 0,
    expiresAt: nowMs + STATIC_CACHE_TTL_MS,
  };
  return globalCountsCache;
}

async function getLevelVocabCounts(
  db: D1Database,
  level: string,
  globalCounts: GlobalVocabCounts,
  nowMs: number,
  origin: string
): Promise<LevelVocabCounts> {
  if (!level || level === 'all') {
    return {
      levelTotalWords: globalCounts.totalWords,
      levelApprovedWords: globalCounts.approvedExampleCount,
      expiresAt: globalCounts.expiresAt,
    };
  }
  const cached = levelCountsCache.get(level);
  if (cached && cached.expiresAt > nowMs) {
    return cached;
  }
  const lvlFilter = buildLevelFilter(level);
  const sql = `
    SELECT
      COUNT(*) as total_cnt,
      SUM(CASE WHEN example_ar IS NOT NULL AND TRIM(example_ar) != '' THEN 1 ELSE 0 END) as approved_cnt
    FROM words
    WHERE 1=1 ${lvlFilter.clause}
  `;
  const row = await edgeCachedJson(origin, `dashboard:level-counts:${level}`, STATIC_CACHE_TTL_MS / 1000, () => {
    const stmt = db.prepare(sql);
    return lvlFilter.params.length > 0
      ? stmt.bind(...lvlFilter.params).first<{ total_cnt: number; approved_cnt: number }>()
      : stmt.first<{ total_cnt: number; approved_cnt: number }>();
  });

  const entry: LevelVocabCounts = {
    levelTotalWords: row?.total_cnt || 0,
    levelApprovedWords: row?.approved_cnt || 0,
    expiresAt: nowMs + STATIC_CACHE_TTL_MS,
  };
  levelCountsCache.set(level, entry);
  return entry;
}

dashboard.get('/', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const level = c.req.query('level') || 'all';
  const now = new Date();
  const nowMs = now.getTime();
  const nowIso = now.toISOString();

  const { todayStr, dateDisplay } = getBeijingDateInfo(now);

  // 1. Static vocabulary counts (cached in Worker memory to avoid 12,525-row full table scans)
  const origin = new URL(c.req.url).origin;
  const globalCounts = await getGlobalVocabCounts(db, nowMs, origin);
  const levelCounts = await getLevelVocabCounts(db, level, globalCounts, nowMs, origin);

  const totalWords = globalCounts.totalWords;
  const approvedExampleCount = globalCounts.approvedExampleCount;
  const pendingExampleCount = Math.max(0, totalWords - approvedExampleCount);
  const levelTotalWords = levelCounts.levelTotalWords;

  // 2. Unlearned words count for this user:
  // Query only the user's progress rows via idx_user_progress_user + words PK lookup
  const lvlFilterAlias = buildLevelFilter(level, 'w');
  const learnedInLevelSql = `
    SELECT COUNT(*) as cnt
    FROM user_progress up
    JOIN words w ON w.id = up.word_id
    WHERE up.user_id = ?
      AND w.example_ar IS NOT NULL AND TRIM(w.example_ar) != ''
      ${lvlFilterAlias.clause}
  `;
  const learnedInLevelRow = await db
    .prepare(learnedInLevelSql)
    .bind(user.userId, ...lvlFilterAlias.params)
    .first<{ cnt: number }>();
  const learnCount = Math.max(0, levelCounts.levelApprovedWords - (learnedInLevelRow?.cnt || 0));

  // 3. Single-pass user_progress aggregation (reviewing, mastered, overdue)
  const progSummaryRow = await db
    .prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN is_mastered = 0 AND interval < 21 THEN 1 ELSE 0 END), 0) as reviewing_cnt,
        COALESCE(SUM(CASE WHEN is_mastered = 1 OR interval >= 21 THEN 1 ELSE 0 END), 0) as mastered_cnt,
        COALESCE(SUM(CASE WHEN is_mastered = 0 AND next_review <= ? THEN 1 ELSE 0 END), 0) as overdue_cnt
      FROM user_progress
      WHERE user_id = ?
    `)
    .bind(nowIso, user.userId)
    .first<{ reviewing_cnt: number; mastered_cnt: number; overdue_cnt: number }>();

  const totalReviewing = progSummaryRow?.reviewing_cnt || 0;
  const masteredCount = progSummaryRow?.mastered_cnt || 0;
  const reviewCount = progSummaryRow?.overdue_cnt || 0;

  // 4. Today checkin and streak
  const checkinRow = await db
    .prepare('SELECT id FROM user_daily_checkin WHERE user_id = ? AND checkin_date = ?')
    .bind(user.userId, todayStr)
    .first<{ id: number }>();
  const todayChecked = !!checkinRow;
  const streakDays = await calculateCheckinStreak(db, user.userId);

  const response: DashboardResponse = {
    user_id: user.userId,
    username: user.username,
    total_words: totalWords,
    approved_example_count: approvedExampleCount,
    pending_example_count: pendingExampleCount,
    learn_count: learnCount,
    review_count: reviewCount,
    total_reviewing: totalReviewing,
    mastered_count: masteredCount,
    today_checked: todayChecked,
    streak_days: streakDays,
    date_display: dateDisplay,
    active_level: level,
    level_total_words: levelTotalWords,
  };

  return c.json(response);
});

export default dashboard;
