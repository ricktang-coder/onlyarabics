import { Hono } from 'hono';
import { Env, LevelInfo, SubLevelInfo } from '../types';
import { AuthenticatedUser } from '../auth';
import { edgeCachedJson } from '../db';

const levels = new Hono<{ Bindings: Env; Variables: { user: AuthenticatedUser } }>();

interface BucketStats {
  total: number;
  learned: number;
  mastered: number;
}

function buildMetrics(stats: BucketStats): {
  total_count: number;
  learned_count: number;
  learning_count: number;
  mastered_count: number;
  unlearned_count: number;
  progress_percent: number;
  progress_pct: number;
} {
  const tot = stats.total || 0;
  const learned = stats.learned || 0;
  const mastered = stats.mastered || 0;
  const learning = Math.max(0, learned - mastered);
  const unlearned = Math.max(0, tot - learned);
  const pct = tot > 0 ? Math.round((learned / tot) * 1000) / 10 : 0;
  return {
    total_count: tot,
    learned_count: learned,
    learning_count: learning,
    mastered_count: mastered,
    unlearned_count: unlearned,
    progress_percent: pct,
    progress_pct: pct,
  };
}

const LEVEL_TOTALS_TTL_MS = 10 * 60 * 1000;
let cachedStaticTotals: { row: Record<string, number>; expiresAt: number } | null = null;

async function getStaticLevelTotals(db: D1Database, origin: string): Promise<Record<string, number>> {
  const now = Date.now();
  if (cachedStaticTotals && cachedStaticTotals.expiresAt > now) {
    return cachedStaticTotals.row;
  }
  const staticSql = `
    SELECT
      COUNT(w.id) AS total_all,
      SUM(CASE WHEN w.difficulty = 'beginner' AND COALESCE(w.tags,'') NOT LIKE '%教材组:%' THEN 1 ELSE 0 END) AS total_beginner,
      SUM(CASE WHEN w.difficulty = 'intermediate' AND COALESCE(w.tags,'') NOT LIKE '%教材组:%' THEN 1 ELSE 0 END) AS total_intermediate,
      SUM(CASE WHEN w.difficulty = 'advanced' AND COALESCE(w.tags,'') NOT LIKE '%教材组:%' THEN 1 ELSE 0 END) AS total_advanced,
      SUM(CASE WHEN w.tags LIKE '%教材组:新编阿拉伯语第一册%' THEN 1 ELSE 0 END) AS total_book1,
      SUM(CASE WHEN w.tags LIKE '%教材组:新编阿拉伯语第二册%' THEN 1 ELSE 0 END) AS total_book2,
      SUM(CASE WHEN w.book_page IS NOT NULL THEN 1 ELSE 0 END) AS total_syllabus,
      SUM(CASE WHEN w.book_level = 2 THEN 1 ELSE 0 END) AS total_s2,
      SUM(CASE WHEN w.book_level = 4 THEN 1 ELSE 0 END) AS total_s4,
      SUM(CASE WHEN w.book_level = 6 THEN 1 ELSE 0 END) AS total_s6,
      SUM(CASE WHEN w.book_level = 8 THEN 1 ELSE 0 END) AS total_s8,
      SUM(CASE WHEN w.book_page IS NOT NULL AND w.book_level IS NULL THEN 1 ELSE 0 END) AS total_sunmarked,
      SUM(CASE WHEN w.is_key_word = 1 THEN 1 ELSE 0 END) AS total_skey,
      SUM(CASE WHEN w.book_level IN (2, 4) THEN 1 ELSE 0 END) AS total_tem4,
      SUM(CASE WHEN w.book_level IN (2, 4) AND w.is_key_word = 1 THEN 1 ELSE 0 END) AS total_tem4_key
    FROM words w
  `;
  const row = await edgeCachedJson(
    origin,
    'levels:static-totals',
    LEVEL_TOTALS_TTL_MS / 1000,
    async () => (await db.prepare(staticSql).first<Record<string, number>>()) || {}
  );
  cachedStaticTotals = { row, expiresAt: now + LEVEL_TOTALS_TTL_MS };
  return row;
}

/**
 * GET /api/levels/info
 * Returns level definitions and user learning progress breakdown using cached static
 * totals + an indexed user_progress join (reads only the user's learned rows instead of 12,525).
 */
levels.get('/info', async (c) => {
  const db = c.env.DB;
  const user = c.get('user');

  const userProgressSql = `
    SELECT
      COUNT(p.id) AS learned_all,
      SUM(CASE WHEN (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_all,

      SUM(CASE WHEN w.difficulty = 'beginner' AND COALESCE(w.tags,'') NOT LIKE '%教材组:%' THEN 1 ELSE 0 END) AS learned_beginner,
      SUM(CASE WHEN w.difficulty = 'beginner' AND COALESCE(w.tags,'') NOT LIKE '%教材组:%' AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_beginner,

      SUM(CASE WHEN w.difficulty = 'intermediate' AND COALESCE(w.tags,'') NOT LIKE '%教材组:%' THEN 1 ELSE 0 END) AS learned_intermediate,
      SUM(CASE WHEN w.difficulty = 'intermediate' AND COALESCE(w.tags,'') NOT LIKE '%教材组:%' AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_intermediate,

      SUM(CASE WHEN w.difficulty = 'advanced' AND COALESCE(w.tags,'') NOT LIKE '%教材组:%' THEN 1 ELSE 0 END) AS learned_advanced,
      SUM(CASE WHEN w.difficulty = 'advanced' AND COALESCE(w.tags,'') NOT LIKE '%教材组:%' AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_advanced,

      SUM(CASE WHEN w.tags LIKE '%教材组:新编阿拉伯语第一册%' THEN 1 ELSE 0 END) AS learned_book1,
      SUM(CASE WHEN w.tags LIKE '%教材组:新编阿拉伯语第一册%' AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_book1,

      SUM(CASE WHEN w.tags LIKE '%教材组:新编阿拉伯语第二册%' THEN 1 ELSE 0 END) AS learned_book2,
      SUM(CASE WHEN w.tags LIKE '%教材组:新编阿拉伯语第二册%' AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_book2,

      SUM(CASE WHEN w.book_page IS NOT NULL THEN 1 ELSE 0 END) AS learned_syllabus,
      SUM(CASE WHEN w.book_page IS NOT NULL AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_syllabus,

      SUM(CASE WHEN w.book_level = 2 THEN 1 ELSE 0 END) AS learned_s2,
      SUM(CASE WHEN w.book_level = 2 AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_s2,

      SUM(CASE WHEN w.book_level = 4 THEN 1 ELSE 0 END) AS learned_s4,
      SUM(CASE WHEN w.book_level = 4 AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_s4,

      SUM(CASE WHEN w.book_level = 6 THEN 1 ELSE 0 END) AS learned_s6,
      SUM(CASE WHEN w.book_level = 6 AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_s6,

      SUM(CASE WHEN w.book_level = 8 THEN 1 ELSE 0 END) AS learned_s8,
      SUM(CASE WHEN w.book_level = 8 AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_s8,

      SUM(CASE WHEN w.book_page IS NOT NULL AND w.book_level IS NULL THEN 1 ELSE 0 END) AS learned_sunmarked,
      SUM(CASE WHEN w.book_page IS NOT NULL AND w.book_level IS NULL AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_sunmarked,

      SUM(CASE WHEN w.is_key_word = 1 THEN 1 ELSE 0 END) AS learned_skey,
      SUM(CASE WHEN w.is_key_word = 1 AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_skey,

      SUM(CASE WHEN w.book_level IN (2, 4) THEN 1 ELSE 0 END) AS learned_tem4,
      SUM(CASE WHEN w.book_level IN (2, 4) AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_tem4,

      SUM(CASE WHEN w.book_level IN (2, 4) AND w.is_key_word = 1 THEN 1 ELSE 0 END) AS learned_tem4_key,
      SUM(CASE WHEN w.book_level IN (2, 4) AND w.is_key_word = 1 AND (p.is_mastered = 1 OR p.interval >= 21) THEN 1 ELSE 0 END) AS mastered_tem4_key
    FROM user_progress p
    INNER JOIN words w ON w.id = p.word_id
    WHERE p.user_id = ?
  `;

  const [totalsRow, userRow] = await Promise.all([
    getStaticLevelTotals(db, new URL(c.req.url).origin),
    db.prepare(userProgressSql).bind(user.userId).first<Record<string, number>>(),
  ]);
  const row: Record<string, number> = { ...totalsRow, ...(userRow || {}) };

  const bucket = (key: string): BucketStats => ({
    total: Number(row[`total_${key}`] || 0),
    learned: Number(row[`learned_${key}`] || 0),
    mastered: Number(row[`mastered_${key}`] || 0),
  });

  const makeSublevel = (id: string, name: string, key: string): SubLevelInfo => ({
    id,
    name,
    ...buildMetrics(bucket(key)),
  });

  const levelsDef: LevelInfo[] = [
    {
      id: 'beginner',
      name: '初级',
      title: '初级 · 基础启航',
      cefr: 'A1 - A2',
      target: '零基础至初学者',
      description: '日常生活高频词、基础动词（如去、吃、写、看）、数字、家庭成员、常见物品、基础时间与方位词等。',
      examples: ['كِتَابٌ (书)', 'ذَهَبَ (去)', 'يَوْمٌ (天/日子)', 'بَيْتٌ (房子)'],
      badge_color: 'emerald',
      tag_bg: 'bg-emerald-50 text-emerald-700 border-emerald-200',
      icon: '🌱',
      gradient: 'from-emerald-500/10 to-teal-500/5',
      accent: 'emerald',
      ...buildMetrics(bucket('beginner')),
    },
    {
      id: 'intermediate',
      name: '中级',
      title: '中级 · 进阶自如',
      cefr: 'B1 - B2',
      target: '有语法基础的中阶学习者',
      description: '职场工作用语、社会生活、教育文化、基础新闻叙事、常用派生动词（II-X 型动词常用词）及抽象名词。',
      examples: ['دَوَامٌ (上班/持续)', 'مُؤْتَمَرٌ (会议)', 'تَطَوَّرَ (发展)', 'عَقْدٌ (合同)'],
      badge_color: 'amber',
      tag_bg: 'bg-amber-50 text-amber-700 border-amber-200',
      icon: '🚀',
      gradient: 'from-amber-500/10 to-orange-500/5',
      accent: 'amber',
      ...buildMetrics(bucket('intermediate')),
    },
    {
      id: 'advanced',
      name: '高级',
      title: '高级 · 深度精通',
      cefr: 'C1 - C2',
      target: '高阶学者与同传译员',
      description: '高阶派生动词、政治外交公报、军事防务、国际法条约、宏观金融与修辞哲学纯单字。',
      examples: ['يُفَكِّكُ (解构/拆解)', 'قَذِيفَةٌ (炮弹)', 'حَصَانَةٌ (豁免权)', 'اسْتِنْزَافٌ (消耗)'],
      badge_color: 'rose',
      tag_bg: 'bg-rose-50 text-rose-700 border-rose-200',
      icon: '👑',
      gradient: 'from-rose-500/10 to-purple-500/5',
      accent: 'rose',
      ...buildMetrics(bucket('advanced')),
    },
    {
      id: 'syllabus',
      name: '教学大纲词汇',
      title: '教学大纲词汇 · 全四级体系',
      cefr: '大纲 2/4/6/8 级',
      target: '高校阿语专业全阶段学习者',
      description: '完整收录《高等学校阿拉伯语教学大纲词汇表（第2版）》词条。',
      examples: ['دَرَجَةٌ (٢)*', 'تَطَوَّرَ (٤)*', 'مُعَاهَدَةٌ (٦)', '⭐ 重点复用词筛选'],
      badge_color: 'teal',
      tag_bg: 'bg-teal-50 text-teal-700 border-teal-200',
      icon: '🎓',
      gradient: 'from-teal-500/10 to-emerald-500/5',
      accent: 'teal',
      ...buildMetrics(bucket('syllabus')),
      sublevels: [
        makeSublevel('syllabus', '全部', 'syllabus'),
        makeSublevel('syllabus:2', '二级', 's2'),
        makeSublevel('syllabus:4', '四级', 's4'),
        makeSublevel('syllabus:6', '六级', 's6'),
        makeSublevel('syllabus:8', '八级', 's8'),
        makeSublevel('syllabus:unmarked', '未定级', 'sunmarked'),
        makeSublevel('syllabus:key', '⭐重点', 'skey'),
      ],
    },
    {
      id: 'tem4',
      name: '专业四级词汇',
      title: '专业四级词汇 · 本科基础核心',
      cefr: '',
      target: '备考全国阿语专业四级 (TEM-4) 考生',
      description: '专四高频词汇，支持一键切换「专四全部」与「⭐专四重点复用词」高效突击。',
      examples: ['سَفِيرٌ (大使)', 'عَلَاقَةٌ (关系)', 'مُؤْتَمَرٌ (会议)', 'تَعَاوَنَ (合作)'],
      badge_color: 'orange',
      tag_bg: 'bg-orange-50 text-orange-700 border-orange-200',
      icon: '🏆',
      gradient: 'from-orange-500/10 to-amber-500/5',
      accent: 'orange',
      ...buildMetrics(bucket('tem4')),
      sublevels: [
        makeSublevel('tem4', '专四全部', 'tem4'),
        makeSublevel('tem4:key', '⭐专四重点', 'tem4_key'),
      ],
    },
    {
      id: 'book1',
      name: '新编阿拉伯语第一册',
      title: '新编阿拉伯语第一册 · 教材词组',
      cefr: '教材',
      target: '《新编阿拉伯语》第一册',
      description: '来自《新编阿拉伯语》第一册的单词，独立于 CEFR 难度等级。',
      examples: ['教材词汇'],
      badge_color: 'sky',
      tag_bg: 'bg-sky-50 text-sky-700 border-sky-200',
      icon: '📘',
      gradient: 'from-sky-500/10 to-cyan-500/5',
      accent: 'sky',
      ...buildMetrics(bucket('book1')),
    },
    {
      id: 'book2',
      name: '新编阿拉伯语第二册',
      title: '新编阿拉伯语第二册 · 教材词组',
      cefr: '教材',
      target: '《新编阿拉伯语》第二册',
      description: '来自《新编阿拉伯语》第二册的单词，独立于 CEFR 难度等级。',
      examples: ['教材词汇'],
      badge_color: 'violet',
      tag_bg: 'bg-violet-50 text-violet-700 border-violet-200',
      icon: '📙',
      gradient: 'from-violet-500/10 to-fuchsia-500/5',
      accent: 'violet',
      ...buildMetrics(bucket('book2')),
    },
    {
      id: 'all',
      name: '全部',
      title: '全库词汇 · 融会贯通',
      cefr: 'A1 - C2',
      target: '全量词库混合学习',
      description: '覆盖初级、中级与高级及教学大纲全部核心词汇，自适应随机与艾宾浩斯复习调度。',
      examples: ['全难度智能混合调度', '4连对随机自测卡组', '智能艾宾浩斯抗遗忘'],
      badge_color: 'indigo',
      tag_bg: 'bg-indigo-50 text-indigo-700 border-indigo-200',
      icon: '📚',
      gradient: 'from-indigo-500/10 to-blue-500/5',
      accent: 'indigo',
      ...buildMetrics(bucket('all')),
    },
  ];

  // Keep the independent textbook levels next to the CEFR tiers, not buried
  // after the syllabus/TEM-4 groups.
  const levelOrder = ['beginner', 'intermediate', 'advanced', 'book1', 'book2', 'syllabus', 'tem4', 'all'];
  levelsDef.sort((a, b) => {
    const ai = levelOrder.indexOf(a.id);
    const bi = levelOrder.indexOf(b.id);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  return c.json({ levels: levelsDef });
});

export default levels;
