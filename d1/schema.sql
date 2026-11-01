-- ==============================================================================
-- Cloudflare D1 (Serverless Distributed SQLite) Schema Definition
-- Arabic Vocabulary App
-- ==============================================================================

-- 1. 词汇表 (Words Table)
CREATE TABLE IF NOT EXISTS words (
    id INTEGER PRIMARY KEY,
    text_vocalized TEXT NOT NULL,
    text_unvocalized TEXT NOT NULL,
    root TEXT,
    wazn TEXT,
    pos TEXT,
    plural TEXT,
    meaning_zh TEXT NOT NULL,
    difficulty TEXT DEFAULT 'intermediate',
    collocation TEXT,
    related_verb TEXT,
    example_ar TEXT,
    example_zh TEXT,
    highlight_ar TEXT,
    simple_example_ar TEXT,
    simple_example_zh TEXT,
    simple_example_highlight_ar TEXT,
    audio_url TEXT,
    tags TEXT
    ,verb_past TEXT
    ,verb_present TEXT
    ,verb_imperative TEXT
    ,verb_conjugations TEXT
    ,synonyms TEXT
    ,antonyms TEXT
    ,book_level INTEGER
    ,is_key_word INTEGER DEFAULT 0
    ,book_page INTEGER
    ,rand_key INTEGER
);

CREATE INDEX IF NOT EXISTS idx_words_difficulty ON words(difficulty);
CREATE INDEX IF NOT EXISTS idx_words_root ON words(root);
CREATE INDEX IF NOT EXISTS idx_words_unvocalized ON words(text_unvocalized);
CREATE INDEX IF NOT EXISTS idx_words_book_level ON words(book_level);
CREATE INDEX IF NOT EXISTS idx_words_key_word ON words(is_key_word);
CREATE INDEX IF NOT EXISTS idx_words_book_page ON words(book_page);
CREATE INDEX IF NOT EXISTS idx_words_rand_key ON words(rand_key);
CREATE INDEX IF NOT EXISTS idx_words_level_rand ON words(book_level, rand_key);
CREATE INDEX IF NOT EXISTS idx_words_difficulty_rand ON words(difficulty, rand_key);
CREATE INDEX IF NOT EXISTS idx_words_key_rand ON words(is_key_word, rand_key);

-- Random sort key for indexed session sampling; filled in for every new row.
CREATE TRIGGER IF NOT EXISTS trg_words_rand_key
AFTER INSERT ON words
WHEN NEW.rand_key IS NULL
BEGIN
    UPDATE words SET rand_key = ABS(RANDOM()) % 1000000000 WHERE id = NEW.id;
END;

-- 2. 多用户独立学习进度表 (User Progress Table - Multi-Tenant by Clerk user_id)
CREATE TABLE IF NOT EXISTS user_progress (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    word_id INTEGER NOT NULL,
    repetition INTEGER DEFAULT 0,
    interval INTEGER DEFAULT 0,
    ease_factor REAL DEFAULT 2.5,
    next_review TEXT NOT NULL,
    last_review TEXT,
    history_count INTEGER DEFAULT 0,
    lapse_count INTEGER DEFAULT 0,
    is_mastered INTEGER DEFAULT 0,
    UNIQUE(user_id, word_id),
    FOREIGN KEY(word_id) REFERENCES words(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_user_progress_user ON user_progress(user_id);
CREATE INDEX IF NOT EXISTS idx_user_progress_next_review ON user_progress(user_id, next_review);
CREATE INDEX IF NOT EXISTS idx_user_progress_mastered ON user_progress(user_id, is_mastered);

-- 3. 多用户每日签到表 (User Daily Checkin Table)
CREATE TABLE IF NOT EXISTS user_daily_checkin (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    checkin_date TEXT NOT NULL,
    created_at TEXT NOT NULL,
    UNIQUE(user_id, checkin_date)
);

CREATE INDEX IF NOT EXISTS idx_user_checkin_user_date ON user_daily_checkin(user_id, checkin_date);

-- 4. 近/反义词释义补充表 (lookup-only, never enters study sessions)
CREATE TABLE IF NOT EXISTS lookup_supplements (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    text_vocalized TEXT NOT NULL,
    text_unvocalized TEXT NOT NULL UNIQUE,
    meaning_zh TEXT NOT NULL,
    pos TEXT,
    root TEXT,
    source_name TEXT,
    source_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_lookup_supplements_text ON lookup_supplements(text_unvocalized);

-- 5. 近/反义词审计表 (source of truth; published arrays are materialized from it)
CREATE TABLE IF NOT EXISTS word_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL,
    group_key TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('synonym','antonym')),
    token TEXT NOT NULL,
    token_key TEXT NOT NULL,
    sense_zh TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence REAL,
    status TEXT NOT NULL DEFAULT 'pending',
    evidence_json TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(group_key, kind, token_key)
);

CREATE INDEX IF NOT EXISTS idx_word_relations_group ON word_relations(group_key, status);
CREATE INDEX IF NOT EXISTS idx_word_relations_token ON word_relations(token_key);

-- 6. 词条义项表 (Sense-level source of truth; pre-materialized to words for zero extra D1 row reads)
CREATE TABLE IF NOT EXISTS word_senses (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    word_id INTEGER NOT NULL,
    sense_index INTEGER NOT NULL,
    sense_zh TEXT NOT NULL,
    sense_ar TEXT,
    pos TEXT,
    source_dict TEXT,
    is_card_primary INTEGER DEFAULT 1,
    UNIQUE(word_id, sense_index),
    FOREIGN KEY(word_id) REFERENCES words(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_word_senses_word ON word_senses(word_id);

-- 7. 义项级同反义关系表 (Sense-level relations)
CREATE TABLE IF NOT EXISTS sense_relations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sense_id INTEGER NOT NULL,
    target_word_id INTEGER,
    target_sense_id INTEGER,
    kind TEXT NOT NULL CHECK (kind IN ('synonym','antonym')),
    token_vocalized TEXT NOT NULL,
    token_unvocalized TEXT NOT NULL,
    sense_label_zh TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'accepted',
    evidence_json TEXT,
    UNIQUE(sense_id, kind, token_unvocalized),
    FOREIGN KEY(sense_id) REFERENCES word_senses(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_sense_relations_sense ON sense_relations(sense_id, status);
CREATE INDEX IF NOT EXISTS idx_sense_relations_target ON sense_relations(target_word_id);

-- 8. 用户账户与个人偏好主表 (Multi-Tenant User Accounts & Cloud Preferences)
CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'student',
    email_verified INTEGER NOT NULL DEFAULT 1,
    token_version INTEGER NOT NULL DEFAULT 1,
    daily_goal INTEGER NOT NULL DEFAULT 20,
    review_goal INTEGER NOT NULL DEFAULT 20,
    selected_level TEXT NOT NULL DEFAULT 'all',
    theme TEXT NOT NULL DEFAULT 'theme-cream',
    register_ip TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    last_login_at TEXT,
    last_active_at TEXT,
    legal_agreed_at TEXT,
    legal_version TEXT,
    avatar_url TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_email ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);
CREATE INDEX IF NOT EXISTS idx_users_username_nocase ON users(username COLLATE NOCASE);
CREATE INDEX IF NOT EXISTS idx_users_uid ON users(uid);

-- 9. 邮箱验证码与限流审计表 (Email OTP & Rate-Limit Audit Table)
CREATE TABLE IF NOT EXISTS email_verification_codes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL,
    purpose TEXT NOT NULL CHECK (purpose IN ('register', 'reset_password')),
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    expires_at TEXT NOT NULL,
    used_at TEXT,
    request_ip TEXT,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_evc_email_purpose ON email_verification_codes(email, purpose, created_at);
CREATE INDEX IF NOT EXISTS idx_evc_ip_created ON email_verification_codes(request_ip, created_at);

-- 10. 用户学习批次历史流水表 (Per-User Study Session History Retention)
CREATE TABLE IF NOT EXISTS user_study_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    mode TEXT NOT NULL CHECK (mode IN ('learn', 'review')),
    level TEXT NOT NULL DEFAULT 'all',
    total_words INTEGER NOT NULL DEFAULT 0,
    completed_words INTEGER NOT NULL DEFAULT 0,
    mistakes_count INTEGER NOT NULL DEFAULT 0,
    accuracy_pct INTEGER NOT NULL DEFAULT 100,
    duration_sec INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_study_sessions_user ON user_study_sessions(user_id, created_at DESC);

-- 10. 用户反馈表 (User Feedback)
CREATE TABLE IF NOT EXISTS user_feedback (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    uid TEXT NOT NULL,
    email TEXT,
    username TEXT,
    content TEXT NOT NULL,
    source TEXT,
    status TEXT NOT NULL DEFAULT 'new',
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_feedback_created ON user_feedback(created_at);
CREATE INDEX IF NOT EXISTS idx_feedback_uid ON user_feedback(uid);

-- 12. 登录失败限流 (Login Brute-Force Throttle)
-- Login brute-force throttle: one row per failed login attempt.
-- Rows older than 24h are purged by the login handler.
CREATE TABLE IF NOT EXISTS auth_login_failures (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_key TEXT NOT NULL,
    ip TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_login_failures_account ON auth_login_failures(account_key, created_at);
CREATE INDEX IF NOT EXISTS idx_login_failures_ip ON auth_login_failures(ip, created_at);
CREATE INDEX IF NOT EXISTS idx_login_failures_created ON auth_login_failures(created_at);

