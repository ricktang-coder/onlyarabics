import { Hono } from 'hono';
import { Env, Word, UserProgress } from '../types';
import { AuthenticatedUser } from '../auth';
import { dedupeWords, enrichWordDataSync, enrichWordsBatch, getCachedSamplePool, parsePositiveInt, pickRandomWords, shuffle } from '../db';
import { calculateSM2 } from '../srs';
import { buildLevelFilter } from '../levelFilter';

const session = new Hono<{ Bindings: Env; Variables: { user: AuthenticatedUser } }>();

/** Upper bound on per-word mistakes accepted from the client. */
const MAX_MISTAKES = 20;

async function wordExists(db: D1Database, wordId: number): Promise<boolean> {
  return Boolean(await db.prepare('SELECT id FROM words WHERE id = ?').bind(wordId).first());
}

/**
 * GET /api/session/learn
 * Extracts a batch of unlearned words for the current user (strictly gating words without approved examples)
 */
session.get('/learn', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const limit = Math.min(200, Math.max(5, parseInt(c.req.query('limit') || '15', 10)));
  const level = c.req.query('level') || 'all';
  const group = c.req.query('group');

  const effectiveLevel = level !== 'all' ? level : group || 'all';
  const lvlFilter = buildLevelFilter(effectiveLevel);

  const filter = `
      AND id NOT IN (SELECT word_id FROM user_progress WHERE user_id = ?)
      AND example_ar IS NOT NULL AND TRIM(example_ar) != ''
      ${lvlFilter.clause}`;

  // Over-fetch because duplicate rows are dropped after retrieval.
  const [unlearnedRows, cachedPool] = await Promise.all([
    pickRandomWords(db, filter, [user.userId, ...lvlFilter.params], Math.min(600, limit * 2)),
    getCachedSamplePool(db),
  ]);
  const unlearnedWords = dedupeWords(unlearnedRows).slice(0, limit);
  const samplePool = dedupeWords([...unlearnedWords, ...cachedPool]);

  const enrichedWords = unlearnedWords.map((w) => enrichWordDataSync(w, null, samplePool));

  return c.json({
    mode: 'learn',
    level,
    count: enrichedWords.length,
    target_limit: limit,
    words: shuffle(enrichedWords),
  });
});

/**
 * GET /api/session/review
 * Extracts review words (overdue and previously learned words) for current user
 */
session.get('/review', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const limit = Math.min(200, Math.max(5, parseInt(c.req.query('limit') || '20', 10)));

  const nowIso = new Date().toISOString();
  
  // 1. Primary: Overdue review words scheduled by SM-2
  const query = `
    SELECT w.* FROM words w
    INNER JOIN user_progress p ON w.id = p.word_id
    WHERE p.user_id = ? AND p.is_mastered = 0 AND p.next_review <= ?
    ORDER BY p.next_review ASC
    LIMIT ?
  `;

  let reviewWords = dedupeWords((await db.prepare(query).bind(user.userId, nowIso, limit * 2).all<Word>()).results).slice(0, limit);

  // 2. Secondary: If overdue words are fewer than custom limit, draw from all previously learned words (randomly or by last_review)
  if (reviewWords.length < limit) {
    const needed = limit - reviewWords.length;
    const existingIds = reviewWords.map((w) => Number(w.id)).filter(Number.isFinite).join(',') || '0';
    const fallbackQuery = `
      SELECT w.* FROM words w
      INNER JOIN user_progress p ON w.id = p.word_id
      WHERE p.user_id = ? AND w.id NOT IN (${existingIds})
      ORDER BY p.last_review DESC, RANDOM()
      LIMIT ?
    `;
    const fallbackWords = dedupeWords((await db.prepare(fallbackQuery).bind(user.userId, needed * 2).all<Word>()).results);
    reviewWords = dedupeWords([...reviewWords, ...fallbackWords]).slice(0, limit);
  }

  // Review only ever contains words this user has learned; a short session is
  // fine, and an empty one tells the client to send the learner to Learn.
  if (reviewWords.length === 0) {
    return c.json({
      mode: 'review',
      count: 0,
      target_limit: limit,
      words: [],
      message: '还没有学过的单词，先去 Learn 学几个吧 📚',
    });
  }

  const cachedPool = await getCachedSamplePool(db);
  const uniqueReviewWords = dedupeWords(reviewWords).slice(0, limit);
  const samplePool = dedupeWords([...uniqueReviewWords, ...cachedPool]);
  const enrichedWords = await enrichWordsBatch(uniqueReviewWords, db, user.userId, samplePool);

  return c.json({
    mode: 'review',
    count: enrichedWords.length,
    target_limit: limit,
    words: shuffle(enrichedWords),
  });
});

/**
 * POST /api/session/graduate
 * Completes 4-streak multimodal session graduation and computes SM-2 schedule
 */
session.post('/graduate', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  let body: { word_id?: unknown; mistakes?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }
  const wordId = parsePositiveInt(body.word_id);
  if (wordId === null) {
    return c.json({ error: 'INVALID_WORD_ID' }, 400);
  }
  const rawMistakes = Number(body.mistakes ?? 0);
  if (!Number.isInteger(rawMistakes) || rawMistakes < 0) {
    return c.json({ error: 'INVALID_MISTAKES' }, 400);
  }
  const mistakes = Math.min(MAX_MISTAKES, rawMistakes);
  if (!(await wordExists(db, wordId))) {
    return c.json({ error: 'Word not found' }, 404);
  }

  let rating = 4;
  if (mistakes === 1) rating = 3;
  else if (mistakes === 2) rating = 2;
  else if (mistakes >= 3) rating = 1;

  const existing = await db
    .prepare('SELECT * FROM user_progress WHERE user_id = ? AND word_id = ?')
    .bind(user.userId, wordId)
    .first<UserProgress>();

  const currentRep = existing?.repetition || 0;
  const currentIvl = existing?.interval || 0;
  const currentEf = existing?.ease_factor || 2.5;

  const sm2 = calculateSM2(rating, currentRep, currentIvl, currentEf);
  const nowIso = new Date().toISOString();
  const lapseAdd = rating < 3 ? 1 : 0;
  const historyAdd = 4 + mistakes;

  if (existing) {
    await db
      .prepare(`
        UPDATE user_progress
        SET repetition = ?, interval = ?, ease_factor = ?, next_review = ?,
            last_review = ?, history_count = history_count + ?, lapse_count = lapse_count + ?
        WHERE id = ?
      `)
      .bind(sm2.repetition, sm2.interval, sm2.easeFactor, sm2.nextReview, nowIso, historyAdd, lapseAdd, existing.id)
      .run();
  } else {
    await db
      .prepare(`
        INSERT INTO user_progress (user_id, word_id, repetition, interval, ease_factor, next_review, last_review, history_count, lapse_count, is_mastered)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
      `)
      .bind(user.userId, wordId, sm2.repetition, sm2.interval, sm2.easeFactor, sm2.nextReview, nowIso, historyAdd, lapseAdd)
      .run();
  }

  return c.json({
    success: true,
    word_id: wordId,
    user_id: user.userId,
    derived_rating: rating,
    mistakes,
    interval_days: sm2.interval,
    next_review: sm2.nextReview,
  });
});

/**
 * POST /api/review
 */
session.post('/review', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  let body: { word_id?: unknown; rating?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }
  const wordId = parsePositiveInt(body.word_id);
  if (wordId === null) {
    return c.json({ error: 'INVALID_WORD_ID' }, 400);
  }
  const rating = Number(body.rating);
  if (!Number.isInteger(rating) || rating < 1 || rating > 4) {
    return c.json({ error: 'INVALID_RATING', message: 'rating 必须是 1-4 的整数' }, 400);
  }
  if (!(await wordExists(db, wordId))) {
    return c.json({ error: 'Word not found' }, 404);
  }

  const existing = await db
    .prepare('SELECT * FROM user_progress WHERE user_id = ? AND word_id = ?')
    .bind(user.userId, wordId)
    .first<UserProgress>();

  const currentRep = existing?.repetition || 0;
  const currentIvl = existing?.interval || 0;
  const currentEf = existing?.ease_factor || 2.5;

  const sm2 = calculateSM2(rating, currentRep, currentIvl, currentEf);
  const nowIso = new Date().toISOString();
  const lapseAdd = rating < 3 ? 1 : 0;

  if (existing) {
    await db
      .prepare(`
        UPDATE user_progress
        SET repetition = ?, interval = ?, ease_factor = ?, next_review = ?,
            last_review = ?, history_count = history_count + 1, lapse_count = lapse_count + ?
        WHERE id = ?
      `)
      .bind(sm2.repetition, sm2.interval, sm2.easeFactor, sm2.nextReview, nowIso, lapseAdd, existing.id)
      .run();
  } else {
    await db
      .prepare(`
        INSERT INTO user_progress (user_id, word_id, repetition, interval, ease_factor, next_review, last_review, history_count, lapse_count, is_mastered)
        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 0)
      `)
      .bind(user.userId, wordId, sm2.repetition, sm2.interval, sm2.easeFactor, sm2.nextReview, nowIso, lapseAdd)
      .run();
  }

  return c.json({
    success: true,
    word_id: wordId,
    user_id: user.userId,
    rating,
    interval_days: sm2.interval,
  });
});

/**
 * POST /api/session/complete
 * Records a completed 4-streak study/review batch into `user_study_sessions`
 * so historical learning trajectories are permanently retained in D1.
 */
session.post('/complete', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');

  let body: {
    mode?: string;
    level?: string;
    total_words?: number;
    completed_words?: number;
    mistakes_count?: number;
    accuracy_pct?: number;
    duration_sec?: number;
  };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }

  const mode = body.mode === 'review' ? 'review' : 'learn';
  const level = String(body.level || 'all').slice(0, 32);
  const totalWords = Math.max(0, Math.min(500, Math.floor(Number(body.total_words) || 0)));
  const completedWords = Math.max(0, Math.min(500, Math.floor(Number(body.completed_words) || 0)));
  const mistakesCount = Math.max(0, Math.min(5000, Math.floor(Number(body.mistakes_count) || 0)));
  const accuracyPct = Math.max(0, Math.min(100, Math.round(Number(body.accuracy_pct ?? 100))));
  const durationSec = Math.max(0, Math.min(86400, Math.floor(Number(body.duration_sec) || 0)));
  const nowIso = new Date().toISOString();

  await db
    .prepare(
      `INSERT INTO user_study_sessions
       (user_id, mode, level, total_words, completed_words, mistakes_count, accuracy_pct, duration_sec, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(user.userId, mode, level, totalWords, completedWords, mistakesCount, accuracyPct, durationSec, nowIso)
    .run();

  await db
    .prepare('UPDATE users SET last_active_at = ? WHERE uid = ?')
    .bind(nowIso, user.userId)
    .run();

  return c.json({
    success: true,
    user_id: user.userId,
    mode,
    completed_words: completedWords,
  });
});

export default session;
