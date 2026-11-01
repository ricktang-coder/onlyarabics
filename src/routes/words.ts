import { Hono } from 'hono';
import { Env, Word, UserProgress } from '../types';
import { AuthenticatedUser } from '../auth';
import { dedupeWords, edgeCachedJson, enrichWordData, enrichWordDataSync, enrichWordsBatch, getCachedSamplePool, parsePositiveInt, pickRandomWords, shuffle } from '../db';
import { buildWordsQueryFilters } from '../levelFilter';

const words = new Hono<{ Bindings: Env; Variables: { user: AuthenticatedUser } }>();

/** Library rows are the same for every user; cache them per colo for an hour. */
const LIBRARY_CACHE_TTL_SECONDS = 60 * 60;

interface LookupRow {
  id: number;
  text_vocalized: string;
  text_unvocalized: string;
  meaning_zh: string;
  pos: string | null;
  root: string | null;
}

interface SupplementRow extends LookupRow {
  source_name: string | null;
  source_url: string | null;
}

const ARABIC_FOLDS: Array<[string, string]> = [
  ['أ', 'ا'],
  ['إ', 'ا'],
  ['آ', 'ا'],
  ['ٱ', 'ا'],
  ['ة', 'ه'],
  ['ى', 'ي'],
  ['ئ', 'ء'],
  ['ؤ', 'ء'],
  ['ـ', ''],
];

function stripArabicMarks(value: string): string {
  return value
    .split('ـ')
    .join('')
    .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g, '')
    .trim();
}

function normalizeArabic(value: string): string {
  return ARABIC_FOLDS.reduce((text, [from, to]) => text.split(from).join(to), stripArabicMarks(value));
}

function normalizedSql(column: string): string {
  return ARABIC_FOLDS.reduce((expr, [from, to]) => `REPLACE(${expr},'${from}','${to}')`, column);
}

/**
 * Generate surface orthographic variants (initial hamza/alif, final taa marbuta/haa,
 * final alif maqsura/yaa) so SQLite can use `idx_words_unvocalized` via `IN (...)`
 * instead of scanning all 12,525 rows with nested REPLACE() functions.
 */
function buildIndexedLookupVariants(raw: string): string[] {
  const clean = stripArabicMarks(raw);
  const folded = normalizeArabic(raw);
  if (!clean && !folded) return [];

  const seeds = new Set<string>();
  if (clean) seeds.add(clean);
  if (folded) seeds.add(folded);

  const expandInitial = (s: string): string[] => {
    if (!s) return [];
    const first = s[0];
    const rest = s.slice(1);
    if (['ا', 'أ', 'إ', 'آ', 'ٱ'].includes(first)) {
      return ['ا', 'أ', 'إ', 'آ'].map((ch) => ch + rest);
    }
    return [s];
  };

  const expandFinal = (s: string): string[] => {
    if (!s) return [];
    const last = s[s.length - 1];
    const head = s.slice(0, -1);
    if (last === 'ة' || last === 'ه') {
      return [head + 'ة', head + 'ه'];
    }
    if (last === 'ى' || last === 'ي') {
      return [head + 'ى', head + 'ي'];
    }
    return [s];
  };

  const variants = new Set<string>();
  for (const seed of seeds) {
    variants.add(seed);
    for (const v1 of expandInitial(seed)) {
      variants.add(v1);
      for (const v2 of expandFinal(v1)) {
        variants.add(v2);
      }
    }
  }

  return Array.from(variants).slice(0, 16);
}


/**
 * GET /api/words
 * Filterable word search & vocabulary directory
 */
words.get('/', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const q = c.req.query('q')?.trim();
  const root = c.req.query('root')?.trim();
  const status = c.req.query('status'); // all | unlearned | learning | mastered
  const difficulty = c.req.query('difficulty'); // all | beginner | intermediate | advanced | syllabus...
  const group = c.req.query('group');
  const book = c.req.query('book');
  const bookLevel = c.req.query('book_level');

  let sql = 'SELECT * FROM words WHERE 1=1';
  const params: any[] = [];

  if (q) {
    const cleanAr = stripArabicMarks(q);
    if (cleanAr && cleanAr !== q) {
      sql +=
        ' AND (text_vocalized LIKE ? OR text_unvocalized LIKE ? OR text_unvocalized LIKE ? OR meaning_zh LIKE ? OR root LIKE ? OR wazn LIKE ?)';
      const wildcard = `%${q}%`;
      const cleanWildcard = `%${cleanAr}%`;
      params.push(wildcard, wildcard, cleanWildcard, wildcard, cleanWildcard, wildcard);
    } else {
      sql +=
        ' AND (text_vocalized LIKE ? OR text_unvocalized LIKE ? OR meaning_zh LIKE ? OR root LIKE ? OR wazn LIKE ?)';
      const wildcard = `%${q}%`;
      params.push(wildcard, wildcard, wildcard, wildcard, wildcard);
    }
  }

  if (root) {
    sql += ' AND root = ?';
    params.push(root);
  }

  const filterFrag = buildWordsQueryFilters({ difficulty, group, book, bookLevel });
  sql += filterFrag.clause;
  params.push(...filterFrag.params);

  // Personal status filters depend on this user's progress, so only the
  // unfiltered listing/search is shared through the edge cache.
  const personal = status === 'unlearned' || status === 'learning' || status === 'mastered';
  if (status === 'unlearned') {
    sql += ' AND id NOT IN (SELECT word_id FROM user_progress WHERE user_id = ?)';
    params.push(user.userId);
  } else if (status === 'learning') {
    sql += ' AND id IN (SELECT word_id FROM user_progress WHERE user_id = ? AND is_mastered = 0 AND interval < 21)';
    params.push(user.userId);
  } else if (status === 'mastered') {
    sql += ' AND id IN (SELECT word_id FROM user_progress WHERE user_id = ? AND (is_mastered = 1 OR interval >= 21))';
    params.push(user.userId);
  }

  sql += ' ORDER BY id ASC LIMIT 500';

  const loadRows = async (): Promise<Word[]> => {
    const stmt = db.prepare(sql);
    const result = params.length > 0 ? await stmt.bind(...params).all<Word>() : await stmt.all<Word>();
    return dedupeWords(result.results);
  };
  const cacheKey = `library:${JSON.stringify([q || '', root || '', difficulty || '', group || '', book || '', bookLevel || ''])}`;
  const uniqueWords = personal
    ? await loadRows()
    : await edgeCachedJson(new URL(c.req.url).origin, cacheKey, LIBRARY_CACHE_TTL_SECONDS, loadRows);

  const enriched = await enrichWordsBatch(uniqueWords, db, user.userId, [], true);

  return c.json({
    total: enriched.length,
    words: enriched,
  });
});

/**
 * GET /api/words/batch
 */
words.get('/batch', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const limit = Math.min(100, Math.max(1, parseInt(c.req.query('limit') || '20', 10)));
  const offset = Math.max(0, parseInt(c.req.query('offset') || '0', 10));
  const mode = c.req.query('mode') || 'random';
  const difficulty = c.req.query('difficulty');
  const group = c.req.query('group');
  const book = c.req.query('book');
  const bookLevel = c.req.query('book_level');

  const filterFrag = buildWordsQueryFilters({ difficulty, group, book, bookLevel });

  // Fetch a larger window because duplicate database rows are removed
  // after retrieval; this keeps the requested card count stable.
  const loadRows = async (): Promise<Word[]> => {
    if (mode === 'random') {
      return pickRandomWords(db, filterFrag.clause, filterFrag.params, Math.min(500, limit * 2));
    }
    const queryLimit = Math.min(500, limit + 200);
    return (
      await db
        .prepare(`SELECT * FROM words WHERE 1=1 ${filterFrag.clause} ORDER BY id ASC LIMIT ? OFFSET ?`)
        .bind(...filterFrag.params, queryLimit, offset)
        .all<Word>()
    ).results;
  };

  const [rows, cachedPool] = await Promise.all([loadRows(), getCachedSamplePool(db)]);
  const uniqueWords = dedupeWords(rows).slice(0, limit);
  const samplePool = dedupeWords([...uniqueWords, ...cachedPool]);

  const enriched = await enrichWordsBatch(uniqueWords, db, user.userId, samplePool);

  return c.json({
    count: enriched.length,
    mode,
    words: enriched,
  });
});

/**
 * GET /api/words/next
 */
words.get('/next', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const limit = Math.min(50, Math.max(1, parseInt(c.req.query('limit') || '15', 10)));

  const filter = `
      AND id NOT IN (SELECT word_id FROM user_progress WHERE user_id = ?)
      AND example_ar IS NOT NULL AND TRIM(example_ar) != ''`;
  const [unlearnedRows, cachedPool] = await Promise.all([
    pickRandomWords(db, filter, [user.userId], Math.min(500, limit * 2)),
    getCachedSamplePool(db),
  ]);
  const unlearned = dedupeWords(unlearnedRows).slice(0, limit);

  const samplePool = dedupeWords([...unlearned, ...cachedPool]);
  const enriched = await enrichWordsBatch(unlearned, db, user.userId, samplePool);

  return c.json({
    count: enriched.length,
    words: shuffle(enriched),
  });
});

/**
 * GET /api/words/lookup
 * Small, normalized lookup used by the synonym/antonym meaning popover.
 * Word results win; the lookup-only supplement table is used only when the
 * word table has no match.
 */
words.get('/lookup', async (c) => {
  const db = c.env.DB;
  const raw = (c.req.query('q') || '').trim();
  const senseHint = (c.req.query('sense') || '').trim();
  const q = normalizeArabic(raw);

  if (!q) {
    return c.json({ query: raw, matches: [] });
  }

  const rankBySense = <T extends LookupRow>(rows: T[], cleanExact: string): T[] => {
    if (rows.length <= 1) return rows;
    return [...rows].sort((a, b) => {
      const aExact = a.text_unvocalized === cleanExact ? 0 : 1;
      const bExact = b.text_unvocalized === cleanExact ? 0 : 1;
      if (aExact !== bExact) return aExact - bExact;
      if (senseHint) {
        const aSense = (a.meaning_zh || '').includes(senseHint) ? 0 : 1;
        const bSense = (b.meaning_zh || '').includes(senseHint) ? 0 : 1;
        if (aSense !== bSense) return aSense - bSense;
      }
      return a.id - b.id;
    });
  };

  // 1. Fast path: Indexed lookup on `words(text_unvocalized)` (reads ~1-3 rows instead of 12,525)
  const cleanExact = stripArabicMarks(raw);
  const variants = buildIndexedLookupVariants(raw);
  if (variants.length > 0) {
    const placeholders = variants.map(() => '?').join(',');
    const indexedWords = (
      await db
        .prepare(
          `SELECT id, text_vocalized, text_unvocalized, meaning_zh, pos, root
           FROM words
           WHERE text_unvocalized IN (${placeholders})
           ORDER BY id ASC
           LIMIT 6`
        )
        .bind(...variants)
        .all<LookupRow>()
    ).results;

    if (indexedWords.length > 0) {
      const ranked = rankBySense(indexedWords, cleanExact).slice(0, 3);
      return c.json({
        query: raw,
        matches: ranked.map((row) => ({ ...row, source: 'word', can_open_detail: true })),
      });
    }

    // 2. Fast path: Indexed lookup on `lookup_supplements(text_unvocalized)`
    try {
      const indexedSupps = (
        await db
          .prepare(
            `SELECT id, text_vocalized, text_unvocalized, meaning_zh, pos, root, source_name, source_url
             FROM lookup_supplements
             WHERE text_unvocalized IN (${placeholders})
             ORDER BY id ASC
             LIMIT 3`
          )
          .bind(...variants)
          .all<SupplementRow>()
      ).results;

      if (indexedSupps.length > 0) {
        const rankedSupps = rankBySense(indexedSupps, cleanExact).slice(0, 3);
        return c.json({
          query: raw,
          matches: rankedSupps.map((row) => ({
            ...row,
            source: 'supplement',
            can_open_detail: false,
          })),
        });
      }
    } catch {
      // Fall through to fallback search
    }
  }

  // 3. Fallback path: Normalized / prefix / substring search (only if exact index lookup misses)
  const wordMatch = normalizedSql('text_unvocalized');
  const prefix = `${q}%`;
  const contains = `%${q}%`;
  const wordSql = `
    SELECT id, text_vocalized, text_unvocalized, meaning_zh, pos, root
    FROM words
    WHERE ${wordMatch} = ? OR ${wordMatch} LIKE ? OR ${wordMatch} LIKE ?
    ORDER BY CASE
      WHEN ${wordMatch} = ? THEN 0
      WHEN ${wordMatch} LIKE ? THEN 1
      ELSE 2
    END, id ASC
    LIMIT 3
  `;
  const wordRows = (
    await db.prepare(wordSql).bind(q, prefix, contains, q, prefix).all<LookupRow>()
  ).results;

  if (wordRows.length > 0) {
    return c.json({
      query: raw,
      matches: rankBySense(wordRows, cleanExact).map((row) => ({
        ...row,
        source: 'word',
        can_open_detail: true,
      })),
    });
  }

  let supplementRows: SupplementRow[] = [];
  try {
    supplementRows = (
      await db
        .prepare(`
          SELECT id, text_vocalized, text_unvocalized, meaning_zh, pos, root, source_name, source_url
          FROM lookup_supplements
          WHERE text_unvocalized = ? OR text_unvocalized LIKE ? OR text_unvocalized LIKE ?
          ORDER BY CASE
            WHEN text_unvocalized = ? THEN 0
            WHEN text_unvocalized LIKE ? THEN 1
            ELSE 2
          END, id ASC
          LIMIT 3
        `)
        .bind(q, prefix, contains, q, prefix)
        .all<SupplementRow>()
    ).results;
  } catch {
    supplementRows = [];
  }

  return c.json({
    query: raw,
    matches: supplementRows.map((row) => ({
      ...row,
      source: 'supplement',
      can_open_detail: false,
    })),
  });
});

/**
 * GET /api/word/:id
 */
words.get('/word/:id', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const wordId = parsePositiveInt(c.req.param('id'));
  if (wordId === null) {
    return c.json({ error: 'Word not found' }, 404);
  }

  const word = await db.prepare('SELECT * FROM words WHERE id = ?').bind(wordId).first<Word>();
  if (!word) {
    return c.json({ error: 'Word not found' }, 404);
  }

  const enriched = await enrichWordData(word, db, user.userId);
  return c.json(enriched);
});

/**
 * POST /api/word/:id/master
 */
words.post('/word/:id/master', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const wordId = parsePositiveInt(c.req.param('id'));
  if (wordId === null) {
    return c.json({ error: 'Word not found' }, 404);
  }

  const word = await db.prepare('SELECT * FROM words WHERE id = ?').bind(wordId).first<Word>();
  if (!word) {
    return c.json({ error: 'Word not found' }, 404);
  }

  const existing = await db
    .prepare('SELECT * FROM user_progress WHERE user_id = ? AND word_id = ?')
    .bind(user.userId, wordId)
    .first<UserProgress>();

  const now = new Date();
  const nextDate = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000).toISOString();
  const nowIso = now.toISOString();

  if (existing) {
    await db
      .prepare(`
        UPDATE user_progress 
        SET is_mastered = 1, interval = 365, repetition = MAX(repetition, 10), last_review = ?, next_review = ?
        WHERE id = ?
      `)
      .bind(nowIso, nextDate, existing.id)
      .run();
  } else {
    await db
      .prepare(`
        INSERT INTO user_progress (user_id, word_id, repetition, interval, ease_factor, next_review, last_review, history_count, lapse_count, is_mastered)
        VALUES (?, ?, 10, 365, 2.8, ?, ?, 1, 0, 1)
      `)
      .bind(user.userId, wordId, nextDate, nowIso)
      .run();
  }

  return c.json({
    success: true,
    message: `已将「${word.text_vocalized}」标记为已熟记！`,
    word_id: wordId,
    user_id: user.userId,
  });
});

/**
 * POST /api/word/:id/unmaster
 */
words.post('/word/:id/unmaster', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const wordId = parsePositiveInt(c.req.param('id'));
  if (wordId === null) {
    return c.json({ error: 'Word not found' }, 404);
  }

  const now = new Date();
  const nextDate = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000).toISOString();

  await db
    .prepare('UPDATE user_progress SET is_mastered = 0, interval = 1, repetition = 1, next_review = ? WHERE user_id = ? AND word_id = ?')
    .bind(nextDate, user.userId, wordId)
    .run();

  return c.json({
    success: true,
    message: '已恢复为常规学习状态！',
    word_id: wordId,
    user_id: user.userId,
  });
});

/**
 * POST /api/words/check_spelling
 */
words.post('/check_spelling', async (c) => {
  const db = c.env.DB;
  let body: { word_id?: unknown; typed?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: '请求格式错误' }, 400);
  }
  const wordId = parsePositiveInt(body.word_id);
  if (wordId === null) {
    return c.json({ error: 'INVALID_WORD_ID' }, 400);
  }
  const userTyped = String(body.typed ?? '').trim().slice(0, 200);

  const word = await db.prepare('SELECT * FROM words WHERE id = ?').bind(wordId).first<Word>();
  if (!word) {
    return c.json({ error: 'Word not found' }, 404);
  }

  const targetClean = word.text_unvocalized.trim();
  const targetVocalized = word.text_vocalized.trim();
  const isCorrect = userTyped === targetClean || userTyped === targetVocalized;

  return c.json({
    word_id: word.id,
    is_correct: isCorrect,
    typed: userTyped,
    target_clean: targetClean,
    target_vocalized: targetVocalized,
    meaning: word.meaning_zh,
    audio_url: word.audio_url,
  });
});

/**
 * GET /api/root/:root
 */
words.get('/root/:root', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const rootName = c.req.param('root');

  const result = await db.prepare('SELECT * FROM words WHERE root = ? ORDER BY id ASC').bind(rootName).all<Word>();
  const uniqueWords = dedupeWords(result.results);

  const enriched = await enrichWordsBatch(uniqueWords, db, user.userId, [], true);

  return c.json({
    root: rootName,
    count: enriched.length,
    words: enriched,
  });
});

/**
 * POST /api/reset
 */
words.post('/reset', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');

  await db.prepare('DELETE FROM user_progress WHERE user_id = ?').bind(user.userId).run();
  await db.prepare('DELETE FROM user_daily_checkin WHERE user_id = ?').bind(user.userId).run();

  return c.json({
    success: true,
    user_id: user.userId,
    username: user.username,
    message: `用户【${user.username}】的复习进度与打卡数据已重置！`,
  });
});

export default words;
