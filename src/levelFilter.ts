/**
 * Unified level and book filter helper for Cloudflare Workers D1 queries.
 * Supports:
 * - all
 * - beginner | intermediate | advanced
 * - book1 | book2
 * - syllabus | syllabus:2 | syllabus:4 | syllabus:6 | syllabus:8 | syllabus:unmarked | syllabus:key
 * - tem4 | tem4:key
 */

export interface SqlFilterFragment {
  clause: string;
  params: any[];
}

export function buildLevelFilter(
  level: string | undefined | null,
  tableAlias: string = ''
): SqlFilterFragment {
  const prefix = tableAlias ? `${tableAlias}.` : '';
  const lvl = (level || 'all').trim();

  if (!lvl || lvl === 'all') {
    return { clause: '', params: [] };
  }

  switch (lvl) {
    case 'beginner':
    case 'intermediate':
    case 'advanced':
      return {
        clause: ` AND ${prefix}difficulty = ? AND COALESCE(${prefix}tags,'') NOT LIKE '%教材组:%'`,
        params: [lvl],
      };

    case 'book1':
      return {
        clause: ` AND ${prefix}tags LIKE ?`,
        params: ['%教材组:新编阿拉伯语第一册%'],
      };

    case 'book2':
      return {
        clause: ` AND ${prefix}tags LIKE ?`,
        params: ['%教材组:新编阿拉伯语第二册%'],
      };

    case 'syllabus':
      return {
        clause: ` AND ${prefix}book_page IS NOT NULL`,
        params: [],
      };

    case 'syllabus:2':
    case 'syllabus:4':
    case 'syllabus:6':
    case 'syllabus:8': {
      const num = parseInt(lvl.split(':')[1], 10);
      return {
        clause: ` AND ${prefix}book_level = ?`,
        params: [num],
      };
    }

    case 'syllabus:unmarked':
      return {
        clause: ` AND ${prefix}book_page IS NOT NULL AND ${prefix}book_level IS NULL`,
        params: [],
      };

    case 'syllabus:key':
      return {
        clause: ` AND ${prefix}is_key_word = 1`,
        params: [],
      };

    case 'tem4':
      return {
        clause: ` AND ${prefix}book_level IN (2, 4)`,
        params: [],
      };

    case 'tem4:key':
      return {
        clause: ` AND ${prefix}book_level IN (2, 4) AND ${prefix}is_key_word = 1`,
        params: [],
      };

    default:
      return {
        clause: ` AND ${prefix}difficulty = ?`,
        params: [lvl],
      };
  }
}

export function buildWordsQueryFilters(options: {
  difficulty?: string | null;
  group?: string | null;
  book?: string | null;
  bookLevel?: string | null;
  tableAlias?: string;
}): SqlFilterFragment {
  const prefix = options.tableAlias ? `${options.tableAlias}.` : '';
  let clause = '';
  const params: any[] = [];

  const diff = (options.difficulty || '').trim();
  const group = (options.group || '').trim();
  const book = (options.book || '').trim();
  const bookLevel = (options.bookLevel || '').trim();

  // If difficulty or group uses composite level syntax (e.g. syllabus, syllabus:2, tem4, book1)
  if (diff && diff !== 'all') {
    const f = buildLevelFilter(diff, options.tableAlias);
    clause += f.clause;
    params.push(...f.params);
  }

  if (group && group !== 'all') {
    const f = buildLevelFilter(group, options.tableAlias);
    clause += f.clause;
    params.push(...f.params);
  }

  if (book === 'syllabus') {
    if (bookLevel === '2' || bookLevel === '4' || bookLevel === '6' || bookLevel === '8') {
      clause += ` AND ${prefix}book_level = ?`;
      params.push(parseInt(bookLevel, 10));
    } else if (bookLevel === 'unmarked') {
      clause += ` AND ${prefix}book_page IS NOT NULL AND ${prefix}book_level IS NULL`;
    } else if (bookLevel === 'key') {
      clause += ` AND ${prefix}is_key_word = 1`;
    } else {
      clause += ` AND ${prefix}book_page IS NOT NULL`;
    }
  } else if (book === 'tem4') {
    if (bookLevel === 'key') {
      clause += ` AND ${prefix}book_level IN (2, 4) AND ${prefix}is_key_word = 1`;
    } else {
      clause += ` AND ${prefix}book_level IN (2, 4)`;
    }
  } else if (bookLevel) {
    if (bookLevel === '2' || bookLevel === '4' || bookLevel === '6' || bookLevel === '8') {
      clause += ` AND ${prefix}book_level = ?`;
      params.push(parseInt(bookLevel, 10));
    } else if (bookLevel === 'unmarked') {
      clause += ` AND ${prefix}book_page IS NOT NULL AND ${prefix}book_level IS NULL`;
    } else if (bookLevel === 'key') {
      clause += ` AND ${prefix}is_key_word = 1`;
    }
  }

  return { clause, params };
}
