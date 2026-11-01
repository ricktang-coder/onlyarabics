import { Word, UserProgress, UserDailyCheckin, EnrichedWord, LevelInfo } from './types';

const ARABIC_ALPHABET = [
  'ا', 'ب', 'ت', 'ث', 'ج', 'ح', 'خ', 'د', 'ذ', 'ر', 'ز', 'س', 'ش', 'ص', 'ض', 'ط', 'ظ', 'ع', 'غ', 'ف', 'ق', 'ك', 'ل', 'م', 'ن', 'ه', 'و', 'ي'
];

/**
 * Parse a client-supplied database id. Returns null unless it is a positive safe integer.
 */
export function parsePositiveInt(value: unknown): number | null {
  const n = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * Shuffle array using Fisher-Yates algorithm
 */
export function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Remove duplicate vocabulary cards before they reach the UI.
 *
 * A card is considered the same when its normalized lemma, part of speech and
 * Chinese gloss match.  This deliberately keeps homographs with different
 * meanings, while collapsing importer duplicates such as four identical
 * `عَمِلَ` records.  The first row (lowest database id because all callers
 * query in a stable order, or the first random row for sessions) is retained.
 */
export function dedupeWords<T extends Word>(words: T[]): T[] {
  const seen = new Set<string>();
  const normalize = (value: string | null | undefined) =>
    (value || '')
      .normalize('NFKC')
      .replace(/[\u064B-\u0652\u0670\u0651]/g, '')
      .replace(/\s+/g, ' ')
      .trim();

  return words.filter((word) => {
    const key = [
      normalize(word.text_unvocalized || word.text_vocalized),
      normalize(word.pos),
      normalize(word.meaning_zh),
    ].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Synchronously enrich word in memory with multi-choice distractors, spelling bank, and user progress
 */
export function enrichWordDataSync(
  word: Word,
  prog: UserProgress | null,
  samplePool: Word[] = [],
  lite = false
): EnrichedWord {
  const isMastered = prog ? prog.is_mastered === 1 || prog.interval >= 21 : false;
  const status: 'learning' | 'reviewing' | 'mastered' = isMastered
    ? 'mastered'
    : prog && prog.repetition > 0
    ? 'reviewing'
    : 'learning';

  const progressObj = prog
    ? {
        id: prog.id,
        user_id: prog.user_id,
        word_id: prog.word_id,
        repetition: prog.repetition,
        interval: prog.interval,
        ease_factor: prog.ease_factor,
        next_review: prog.next_review,
        last_review: prog.last_review,
        history_count: prog.history_count,
        lapse_count: prog.lapse_count,
        is_mastered: prog.is_mastered === 1,
        status,
      }
    : null;

  const hasExample = Boolean(word.example_ar && word.example_ar.trim());
  const base = {
    ...word,
    word_vocalized: word.text_vocalized,
    word_clean: word.text_unvocalized,
    meaning: word.meaning_zh,
    example_status: hasExample ? 'approved' : 'pending_review',
    book_level: word.book_level ?? null,
    is_key_word: Boolean(word.is_key_word),
    book_page: word.book_page ?? null,
    audio_file: word.audio_url ? word.audio_url.split('/').pop() || null : null,
    progress: progressObj,
    root_family: [],
  };

  // Lists (library, root family) never quiz, so skip choices and the letter bank.
  if (lite) return base;

  // Multi-choice distractors: prioritize same POS category & difficulty so
  // learners cannot guess answers by part of speech alone.
  let distractors: Word[] = [];
  if (samplePool.length >= 4) {
    const posBroad = (p: string | null | undefined) => {
      if (!p) return '';
      if (p.includes('动词')) return 'verb';
      if (p.includes('名词') || p.includes('词根')) return 'noun';
      if (p.includes('形容') || p.includes('分词')) return 'adj';
      return p.slice(0, 2);
    };
    const targetPos = posBroad(word.pos);
    const pool = samplePool.filter(
      (w) =>
        w.id !== word.id &&
        w.meaning_zh !== word.meaning_zh &&
        w.text_unvocalized !== word.text_unvocalized
    );
    const samePosDiff = targetPos
      ? pool.filter((w) => posBroad(w.pos) === targetPos && w.difficulty === word.difficulty)
      : [];
    const samePos = targetPos ? pool.filter((w) => posBroad(w.pos) === targetPos) : [];

    if (samePosDiff.length >= 3) {
      distractors = shuffle(samePosDiff).slice(0, 3);
    } else if (samePos.length >= 3) {
      distractors = shuffle(samePos).slice(0, 3);
    } else {
      const chosen = shuffle(samePos);
      const chosenIds = new Set(chosen.map((w) => w.id));
      const rest = shuffle(pool.filter((w) => !chosenIds.has(w.id))).slice(0, 3 - chosen.length);
      distractors = [...chosen, ...rest];
    }
  }

  const zhChoices = shuffle([
    { id: word.id, text: word.meaning_zh, is_correct: true },
    ...distractors.map((d) => ({ id: d.id, text: d.meaning_zh, is_correct: false })),
  ]);

  const arChoices = shuffle([
    { id: word.id, text: word.text_vocalized, is_correct: true },
    ...distractors.map((d) => ({ id: d.id, text: d.text_vocalized, is_correct: false })),
  ]);

  // Spelling letter bank
  const cleanText = (word.text_unvocalized || '').replace(/\s+/g, '');
  const correctLetters = cleanText.split('');
  const distractorLetters = ARABIC_ALPHABET.filter((c) => !correctLetters.includes(c));
  const randomDistractorLetters = shuffle(distractorLetters).slice(0, Math.min(3, distractorLetters.length));
  const letterBank = shuffle([...correctLetters, ...randomDistractorLetters]);

  return {
    ...base,
    zh_choices: zhChoices,
    ar_choices: arChoices,
    spelling: {
      target_clean: cleanText,
      target_unvocalized: cleanText,
      target_vocalized: word.text_vocalized,
      correct_letters: correctLetters,
      letter_bank: letterBank,
    },
  };
}

/**
 * Enrich single word with multi-choice distractors, spelling bank, and user progress
 */
export async function enrichWordData(
  word: Word,
  db: D1Database,
  userId: string,
  samplePool: Word[] = []
): Promise<EnrichedWord> {
  try {
    const prog = await db
      .prepare('SELECT * FROM user_progress WHERE user_id = ? AND word_id = ?')
      .bind(userId, word.id)
      .first<UserProgress>();

    return enrichWordDataSync(word, prog, samplePool);
  } catch {
    return enrichWordDataSync(word, null, samplePool);
  }
}

/** `words.rand_key` values are uniform in [0, RAND_KEY_SPACE). */
const RAND_KEY_SPACE = 1_000_000_000;

/**
 * Draw up to `limit` random words matching `filterClause` (a string of
 * ` AND ...` conditions on `words`) without `ORDER BY RANDOM()`: walk
 * idx_words_rand_key from a random point and wrap around once, so only
 * about `limit` matching rows are read instead of the whole table.
 */
export async function pickRandomWords(
  db: D1Database,
  filterClause: string,
  params: unknown[],
  limit: number
): Promise<Word[]> {
  const start = Math.floor(Math.random() * RAND_KEY_SPACE);
  const sql = (range: string) =>
    `SELECT * FROM words WHERE ${range} ${filterClause} ORDER BY rand_key LIMIT ?`;
  const head = (
    await db.prepare(sql('rand_key >= ?')).bind(start, ...params, limit).all<Word>()
  ).results;
  if (head.length >= limit) return head;
  const tail = (
    await db.prepare(sql('rand_key < ?')).bind(start, ...params, limit - head.length).all<Word>()
  ).results;
  return [...head, ...tail];
}

/**
 * Read-through cache for data that is the same for every user (vocabulary
 * counts, search hits). Layered on the colo-wide Cache API so new isolates
 * do not each repeat full-table scans; falls back to `load()` when the Cache
 * API is unavailable (e.g. workers.dev, local dev).
 */
export async function edgeCachedJson<T>(
  origin: string,
  key: string,
  ttlSeconds: number,
  load: () => Promise<T>
): Promise<T> {
  const cache = typeof caches !== 'undefined' ? (caches as unknown as { default?: Cache }).default : undefined;
  const cacheKey = new Request(`${origin}/__edge-cache/${encodeURIComponent(key)}`);
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return (await hit.json()) as T;
    } catch {
      // Treat cache errors as a miss.
    }
  }
  const value = await load();
  if (cache) {
    try {
      await cache.put(
        cacheKey,
        new Response(JSON.stringify(value), {
          headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${ttlSeconds}` },
        })
      );
    } catch {
      // Caching is best effort.
    }
  }
  return value;
}

const SAMPLE_POOL_TTL_MS = 10 * 60 * 1000;
let cachedSamplePool: { words: Word[]; expiresAt: number } | null = null;

/**
 * Return a cached pool of active words for multi-choice distractors so
 * `/api/session/learn` and `/api/session/review` do not trigger a 12,525-row
 * `ORDER BY RANDOM()` full-table scan on every session start.
 */
export async function getCachedSamplePool(db: D1Database): Promise<Word[]> {
  const now = Date.now();
  if (cachedSamplePool && cachedSamplePool.expiresAt > now && cachedSamplePool.words.length >= 20) {
    return cachedSamplePool.words;
  }
  try {
    // Random window over the whole vocabulary via idx_words_rand_key.
    const rows = await pickRandomWords(db, "AND example_ar IS NOT NULL AND TRIM(example_ar) != ''", [], 120);
    const pool = dedupeWords(rows);
    if (pool.length >= 20) {
      cachedSamplePool = { words: pool, expiresAt: now + SAMPLE_POOL_TTL_MS };
      return pool;
    }
  } catch {
    // Fallback below
  }
  return cachedSamplePool?.words || [];
}

/**
 * Batch-enrich an array of words using a single `WHERE word_id IN (...)` query
 * instead of N+1 individual `SELECT * FROM user_progress` queries.
 */
export async function enrichWordsBatch(
  wordList: Word[],
  db: D1Database,
  userId: string,
  samplePool: Word[] = [],
  lite = false
): Promise<EnrichedWord[]> {
  if (wordList.length === 0) return [];
  const progMap = new Map<number, UserProgress>();
  const wordIds = wordList.map((w) => Number(w.id)).filter(Number.isFinite);
  if (wordIds.length > 0) {
    try {
      // Chunk IN clauses at 250 IDs for SQLite parameter safety
      for (let i = 0; i < wordIds.length; i += 250) {
        const chunk = wordIds.slice(i, i + 250);
        const idList = chunk.join(',');
        const progs = await db
          .prepare(`SELECT * FROM user_progress WHERE user_id = ? AND word_id IN (${idList})`)
          .bind(userId)
          .all<UserProgress>();
        progs.results.forEach((p) => progMap.set(p.word_id, p));
      }
    } catch {
      // Continue with empty progress map if query fails
    }
  }
  const combinedPool = samplePool.length >= 15 ? samplePool : dedupeWords([...wordList, ...samplePool]);
  return wordList.map((w) => enrichWordDataSync(w, progMap.get(w.id) || null, combinedPool, lite));
}

/**
 * Get current date and formatted display string in Beijing Time (UTC+8)
 */
export function getBeijingDateInfo(now: Date = new Date()): {
  todayStr: string;
  yesterdayStr: string;
  dateDisplay: string;
  beijingDate: Date;
} {
  const beijingMs = now.getTime() + 8 * 60 * 60 * 1000;
  const beijingDate = new Date(beijingMs);
  const todayStr = beijingDate.toISOString().split('T')[0];

  const yesterdayDate = new Date(beijingMs - 24 * 60 * 60 * 1000);
  const yesterdayStr = yesterdayDate.toISOString().split('T')[0];

  const weekdays = ['Sun.', 'Mon.', 'Tue.', 'Wed.', 'Thu.', 'Fri.', 'Sat.'];
  const mm = String(beijingDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(beijingDate.getUTCDate()).padStart(2, '0');
  const dateDisplay = `${mm}/${dd} ${weekdays[beijingDate.getUTCDay()]}`;

  return { todayStr, yesterdayStr, dateDisplay, beijingDate };
}

/**
 * Calculate user check-in streak in days (Beijing Time UTC+8)
 */
export async function calculateCheckinStreak(db: D1Database, userId: string): Promise<number> {
  const checkins = await db
    .prepare('SELECT checkin_date FROM user_daily_checkin WHERE user_id = ? ORDER BY checkin_date DESC')
    .bind(userId)
    .all<{ checkin_date: string }>();

  const checkinSet = new Set(checkins.results.map((c) => c.checkin_date));
  let streak = 0;

  const { todayStr, beijingDate } = getBeijingDateInfo();
  let currMs = beijingDate.getTime();

  // If today is not checked in, start checking from yesterday
  if (!checkinSet.has(todayStr)) {
    currMs -= 24 * 60 * 60 * 1000;
  }

  while (true) {
    const dateStr = new Date(currMs).toISOString().split('T')[0];
    if (checkinSet.has(dateStr)) {
      streak++;
      currMs -= 24 * 60 * 60 * 1000;
    } else {
      break;
    }
  }

  return streak;
}
