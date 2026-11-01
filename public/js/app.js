/**
 * 不背阿语 (BuBei AYu) · 沉浸式碎片化背单词 Web 应用
 * 前端核心控制器：基于 Fisher-Yates 洗牌的随机多模态 4 连对调度引擎、莫兰迪色板、TTS 发音与 SM-2 联动。
 */

// 7 款极简莫兰迪与纯色纸质色调
const THEMES = [
    { id: 'theme-cream', name: '奶油白纸' },
    { id: 'theme-sage', name: '鼠尾草绿' },
    { id: 'theme-slate', name: '柔雾灰蓝' },
    { id: 'theme-terracotta', name: '陶土粉灰' },
    { id: 'theme-matcha', name: '京都抹茶' },
    { id: 'theme-sand', name: '沙漠暖驼' },
    { id: 'theme-lavender', name: '暮光浅紫' },
];

const CHALLENGE_MODES = ['flashcard', 'ar_to_zh', 'zh_to_ar', 'spelling'];
const MODE_NAMES = {
    'flashcard': '两段自测',
    'ar_to_zh': '看阿选汉',
    'zh_to_ar': '看汉选阿',
    'spelling': '阿语拼写',
};

// Helper: Strip Tashkeel & Harakat
function stripTashkeel(text) {
    if (!text) return '';
    return text
        .normalize('NFC')
        .replace(/[\u0610-\u061A\u064B-\u065F\u0670\u06D6-\u06ED\u0640]/g, '');
}

// Application Global State
const state = {
    currentView: 'dashboard', // 'dashboard' | 'flashcard'
    currentThemeIndex: 0,
    sessionMode: 'learn', // 'learn' | 'review'
    selectedLevel: 'all',
    dailyGoal: 20,
    reviewGoal: 20,
    sessionLimit: 20,
    deck: [], // Shuffled array of { wordId, word, mode }
    wordTracker: {}, // Map: wordId -> { word, streak: 0..4, mistakes: 0, completed: bool }
    currentTask: null,
    currentWord: null,
    currentChallengeMode: 'flashcard',
    isTashkeelEnabled: true,
    hasArabicVoice: null, // null = not checked yet, true/false = speechSynthesis result
    voiceWarningShown: false,
    step: 1, // 1: Question, 2: Details
    dashboardData: {
        total_words: 0,
        learn_count: 0,
        review_count: 0,
        total_reviewing: 0,
        mastered_count: 0,
        today_checked: false,
        streak_days: 0,
        date_display: '08/24 Mon.',
    },
    sessionStats: {
        totalWords: 0,
        completedCount: 0,
        totalAttempts: 0,
        mistakesCount: 0,
        startTime: null,
    },
    voices: [],
    selectedVoice: null,
    allWordsCache: [],
    levelsCache: [],
};

const LEVEL_LABELS_MAP = {
    'beginner': '🌱 初级 · A1-A2',
    'intermediate': '🚀 中级 · B1-B2',
    'advanced': '👑 高级 · C1-C2',
    'syllabus': '🎓 教学大纲词汇 · 全部',
    'syllabus:2': '🎓 大纲二级',
    'syllabus:4': '🎓 大纲四级',
    'syllabus:6': '🎓 大纲六级',
    'syllabus:8': '🎓 大纲八级',
    'syllabus:unmarked': '🎓 大纲未定级',
    'syllabus:key': '⭐ 大纲重点复用词',
    'tem4': '🏆 专业四级词汇 · 全部',
    'tem4:key': '⭐ 专四重点词汇',
    'book1': '📘 新编阿拉伯语第一册',
    'book2': '📙 新编阿拉伯语第二册',
    'all': '📚 全库 · 综合',
};

function getLevelDisplayTitle(levelId) {
    if (LEVEL_LABELS_MAP[levelId]) return LEVEL_LABELS_MAP[levelId];
    for (const lvl of (state.levelsCache || [])) {
        if (lvl.id === levelId) return `${lvl.icon || ''} ${lvl.name}`.trim();
        if (Array.isArray(lvl.sublevels)) {
            const sub = lvl.sublevels.find(s => s.id === levelId);
            if (sub) return `${lvl.icon || ''} ${lvl.name} · ${sub.name}`.trim();
        }
    }
    return '📚 全库 · 综合';
}

function getSyllabusBadgesHtml(word) {
    if (!word) return '';
    const badges = [];
    if (word.book_page !== null && word.book_page !== undefined) {
        const lvlText = word.book_level ? `大纲${word.book_level}级` : '大纲未定级';
        badges.push(`<span class="meta-chip meta-chip--teal">${lvlText}</span>`);
    }
    if (word.is_key_word) {
        badges.push(`<span class="meta-chip meta-chip--amber"><svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/></svg><span>重点</span></span>`);
    }
    return badges.join('');
}

function getWordLevelTag(word) {
    const tags = (word && word.tags) || '';
    if (tags.includes('新编阿拉伯语第一册')) return { label: '教材一册', cls: 'meta-chip--sky' };
    if (tags.includes('新编阿拉伯语第二册')) return { label: '教材二册', cls: 'meta-chip--violet' };
    if (word && word.difficulty === 'beginner') return { label: '初级', cls: 'meta-chip--green' };
    if (word && word.difficulty === 'advanced') return { label: '高级', cls: 'meta-chip--rose' };
    return { label: '中级', cls: 'meta-chip--amber' };
}

/**
 * Beginner-friendly supplemental example wins over the original sentence.
 * The original is still kept for the collapsible "查看原例句" block.
 */
function getPrimaryExample(word) {
    const simpleAr = ((word && word.simple_example_ar) || '').trim();
    if (simpleAr) {
        return {
            ar: simpleAr,
            zh: ((word.simple_example_zh) || '').trim(),
            highlight: ((word.simple_example_highlight_ar) || '').trim(),
            isSimple: true,
            originalAr: ((word.example_ar) || '').trim(),
            originalZh: ((word.example_zh) || '').trim(),
            originalHighlight: ((word.highlight_ar) || '').trim(),
        };
    }
    return {
        ar: ((word && word.example_ar) || '').trim(),
        zh: ((word && word.example_zh) || '').trim(),
        highlight: ((word && word.highlight_ar) || '').trim(),
        isSimple: false,
        originalAr: '',
        originalZh: '',
        originalHighlight: '',
    };
}

// DOM Elements
const elements = {
    // Views
    dashboardView: document.getElementById('dashboardView'),
    flashcardView: document.getElementById('flashcardView'),
    btnBackToDashboard: document.getElementById('btnBackToDashboard'),

    // Theme Switcher
    btnSwitchTheme: document.getElementById('btnSwitchTheme'),
    themeNameBadge: document.getElementById('themeNameBadge'),

    // Dashboard
    checkinWidget: document.getElementById('checkinWidget'),
    checkinTitle: document.getElementById('checkinTitle'),
    checkinDateText: document.getElementById('checkinDateText'),
    streakBadge: document.getElementById('streakBadge'),
    streakCountText: document.getElementById('streakCountText'),
    btnCardLearn: document.getElementById('btnCardLearn'),
    learnCountBadge: document.getElementById('learnCountBadge'),
    learnSubtext: document.getElementById('learnSubtext'),
    learnTotalRemainingText: document.getElementById('learnTotalRemainingText'),
    btnLevelTrigger: document.getElementById('btnLevelTrigger'),
    activeLevelDisplayBadge: document.getElementById('activeLevelDisplayBadge'),
    btnDailyGoalTrigger: document.getElementById('btnDailyGoalTrigger'),
    dailyGoalDisplayBadge: document.getElementById('dailyGoalDisplayBadge'),
    btnCardReview: document.getElementById('btnCardReview'),
    btnOpenReviewGoalModal: document.getElementById('btnOpenReviewGoalModal'),
    reviewGoalDisplayBadge: document.getElementById('reviewGoalDisplayBadge'),
    reviewCountBadge: document.getElementById('reviewCountBadge'),
    // Bottom Nav Tabs
    tabLevel: document.getElementById('tabLevel'), // 图二红圈左侧图标 -> 难度等级选择弹窗
    tabLibrary: document.getElementById('tabLibrary'), // 中间图标 -> 词库总览抽屉
    tabSettings: document.getElementById('tabSettings'), // 右侧图标 -> 设置与统计

    // Level Selection Modal
    levelSelectModal: document.getElementById('levelSelectModal'),
    btnCloseLevelModal: document.getElementById('btnCloseLevelModal'),
    levelCardsContainer: document.getElementById('levelCardsContainer'),
    btnBrowseLibraryDirect: document.getElementById('btnBrowseLibraryDirect'),

    // Flashcard Header Progress
    sessionProgressLabel: document.getElementById('sessionProgressLabel'),
    sessionProgressBar: document.getElementById('sessionProgressBar'),
    streakDotsContainer: document.getElementById('streakDotsContainer'),
    quizModeBadge: document.getElementById('quizModeBadge'),
    cardCategoryText: document.getElementById('cardCategoryText'),
    tashkeelToggleBtn: document.getElementById('tashkeelToggleBtn'),
    tashkeelStatusBadge: document.getElementById('tashkeelStatusBadge'),
    btnMarkMastered: document.getElementById('btnMarkMastered'),

    // Mode Containers
    flashcardModeContainer: document.getElementById('flashcardModeContainer'),
    arToZhModeContainer: document.getElementById('arToZhModeContainer'),
    zhToArModeContainer: document.getElementById('zhToArModeContainer'),
    spellingModeContainer: document.getElementById('spellingModeContainer'),

    // Mode 1: Flashcard elements
    headwordArabic: document.getElementById('headwordArabic'),
    audioWordBtn: document.getElementById('audioWordBtn'),
    contextSentenceBox: document.getElementById('contextSentenceBox'),
    exampleArText: document.getElementById('exampleArText'),
    audioSentenceBtn: document.getElementById('audioSentenceBtn'),
    contextExampleLabel: document.getElementById('contextExampleLabel'),
    btnToggleSimpleZh: document.getElementById('btnToggleSimpleZh'),
    exampleSimpleZhText: document.getElementById('exampleSimpleZhText'),

    // Mode 2: Arabic -> Chinese
    arToZhHeadword: document.getElementById('arToZhHeadword'),
    audioArToZhBtn: document.getElementById('audioArToZhBtn'),
    arToZhOptionsList: document.getElementById('arToZhOptionsList'),

    // Mode 3: Chinese -> Arabic
    zhToArPosTag: document.getElementById('zhToArPosTag'),
    zhToArMeaningText: document.getElementById('zhToArMeaningText'),
    zhToArOptionsList: document.getElementById('zhToArOptionsList'),

    // Mode 4: Spelling
    spellingPosTag: document.getElementById('spellingPosTag'),
    spellingMeaningText: document.getElementById('spellingMeaningText'),
    spellingSentenceText: document.getElementById('spellingSentenceText'),
    spellingInput: document.getElementById('spellingInput'),
    spellingDiffHint: document.getElementById('spellingDiffHint'),
    btnSpellingClear: document.getElementById('btnSpellingClear'),
    btnSpellingBackspace: document.getElementById('btnSpellingBackspace'),
    letterTilesBank: document.getElementById('letterTilesBank'),
    btnSubmitSpelling: document.getElementById('btnSubmitSpelling'),

    // Step 2 Details
    detailsSection: document.getElementById('detailsSection'),
    posTag: document.getElementById('posTag'),
    meaningZhText: document.getElementById('meaningZhText'),
    pluralBox: document.getElementById('pluralBox'),
    pluralText: document.getElementById('pluralText'),
    collocationBox: document.getElementById('collocationBox'),
    collocationText: document.getElementById('collocationText'),
    exampleZhText: document.getElementById('exampleZhText'),
    detailExampleLabel: document.getElementById('detailExampleLabel'),
    detailExampleArText: document.getElementById('detailExampleArText'),
    detailExampleZhText: document.getElementById('detailExampleZhText'),
    btnDetailAudioSentence: document.getElementById('btnDetailAudioSentence'),
    detailOriginalExample: document.getElementById('detailOriginalExample'),
    detailOriginalExampleAr: document.getElementById('detailOriginalExampleAr'),
    detailOriginalExampleZh: document.getElementById('detailOriginalExampleZh'),
    btnDetailAudioOriginal: document.getElementById('btnDetailAudioOriginal'),
    rootFamilySection: document.getElementById('rootFamilySection'),
    rootFamilyList: document.getElementById('rootFamilyList'),
    nounLexiconSection: document.getElementById('nounLexiconSection'),
    nounRootText: document.getElementById('nounRootText'),
    nounDerivativesList: document.getElementById('nounDerivativesList'),

    // Action Bars
    step1ActionBar: document.getElementById('step1ActionBar'),
    step2ActionBar: document.getElementById('step2ActionBar'),
    btnDontKnow: document.getElementById('btnDontKnow'),
    btnKnow: document.getElementById('btnKnow'),
    btnNextChallenge: document.getElementById('btnNextChallenge'),

    // Session Modal
    sessionModal: document.getElementById('sessionModal'),
    sessionTotalWords: document.getElementById('sessionTotalWords'),
    sessionMasteryRate: document.getElementById('sessionMasteryRate'),
    sessionMistakeCount: document.getElementById('sessionMistakeCount'),
    btnNextSession: document.getElementById('btnNextSession'),
    btnReturnHomeFromModal: document.getElementById('btnReturnHomeFromModal'),

    // Library Drawer
    libraryDrawer: document.getElementById('libraryDrawer'),
    btnCloseLibrary: document.getElementById('btnCloseLibrary'),
    librarySearchInput: document.getElementById('librarySearchInput'),
    libraryDifficultyFilter: document.getElementById('libraryDifficultyFilter'),
    libraryStatusFilter: document.getElementById('libraryStatusFilter'),
    libraryWordList: document.getElementById('libraryWordList'),
    libraryStatsTotal: document.getElementById('libraryStatsTotal'),

    // Daily Goal Modal
    dailyGoalModal: document.getElementById('dailyGoalModal'),
    btnCloseDailyGoalModal: document.getElementById('btnCloseDailyGoalModal'),
    customGoalInput: document.getElementById('customGoalInput'),
    btnSaveCustomGoal: document.getElementById('btnSaveCustomGoal'),

    // Review Goal Modal
    reviewGoalModal: document.getElementById('reviewGoalModal'),
    btnCloseReviewGoalModal: document.getElementById('btnCloseReviewGoalModal'),
    customReviewGoalInput: document.getElementById('customReviewGoalInput'),
    btnSaveCustomReviewGoal: document.getElementById('btnSaveCustomReviewGoal'),
    reviewLearnedCountNotice: document.getElementById('reviewLearnedCountNotice'),

    // Word Detail Modal (词库单词详情弹窗)
    wordDetailModal: document.getElementById('wordDetailModal'),
    btnCloseWordDetailModal: document.getElementById('btnCloseWordDetailModal'),
    btnWordDetailBack: document.getElementById('btnWordDetailBack'),
    btnModalCloseAction: document.getElementById('btnModalCloseAction'),
    modalWordDiffBadge: document.getElementById('modalWordDiffBadge'),
    modalWordStatusBadge: document.getElementById('modalWordStatusBadge'),
    modalWordVocalized: document.getElementById('modalWordVocalized'),
    modalWordMeaning: document.getElementById('modalWordMeaning'),
    btnModalPlayAudio: document.getElementById('btnModalPlayAudio'),
    modalWordPos: document.getElementById('modalWordPos'),
    modalWordPluralCard: document.getElementById('modalWordPluralCard'),
    modalWordPlural: document.getElementById('modalWordPlural'),
    modalNounLexiconSection: document.getElementById('modalNounLexiconSection'),
    modalNounRootText: document.getElementById('modalNounRootText'),
    modalNounDerivativesList: document.getElementById('modalNounDerivativesList'),
    btnModalPlaySentence: document.getElementById('btnModalPlaySentence'),
    modalExampleLabel: document.getElementById('modalExampleLabel'),
    modalExampleAr: document.getElementById('modalExampleAr'),
    modalExampleZh: document.getElementById('modalExampleZh'),
    modalOriginalExample: document.getElementById('modalOriginalExample'),
    modalOriginalExampleAr: document.getElementById('modalOriginalExampleAr'),
    modalOriginalExampleZh: document.getElementById('modalOriginalExampleZh'),
    btnModalPlayOriginal: document.getElementById('btnModalPlayOriginal'),
    btnModalToggleMastered: document.getElementById('btnModalToggleMastered'),

    // Synonyms & Antonyms (Study View)
    synonymsAntonymsSection: document.getElementById('synonymsAntonymsSection'),
    synonymsBox: document.getElementById('synonymsBox'),
    synonymsList: document.getElementById('synonymsList'),
    antonymsBox: document.getElementById('antonymsBox'),
    antonymsList: document.getElementById('antonymsList'),

    // Verb Tenses Summary (Study View)
    verbTensesSection: document.getElementById('verbTensesSection'),
    verbFormTag: document.getElementById('verbFormTag'),
    btnOpenConjugationModal: document.getElementById('btnOpenConjugationModal'),
    verbPastCard: document.getElementById('verbPastCard'),
    verbPastText: document.getElementById('verbPastText'),
    verbPresentCard: document.getElementById('verbPresentCard'),
    verbPresentText: document.getElementById('verbPresentText'),
    verbImperativeCard: document.getElementById('verbImperativeCard'),
    verbImperativeText: document.getElementById('verbImperativeText'),

    // Synonyms & Antonyms (Modal View)
    modalSynonymsAntonymsSection: document.getElementById('modalSynonymsAntonymsSection'),
    modalSynonymsBox: document.getElementById('modalSynonymsBox'),
    modalSynonymsList: document.getElementById('modalSynonymsList'),
    modalAntonymsBox: document.getElementById('modalAntonymsBox'),
    modalAntonymsList: document.getElementById('modalAntonymsList'),

    // Verb Tenses Summary (Modal View)
    modalVerbTensesSection: document.getElementById('modalVerbTensesSection'),
    modalVerbFormTag: document.getElementById('modalVerbFormTag'),
    btnModalOpenConjugationModal: document.getElementById('btnModalOpenConjugationModal'),
    modalVerbPastCard: document.getElementById('modalVerbPastCard'),
    modalVerbPastText: document.getElementById('modalVerbPastText'),
    modalVerbPresentCard: document.getElementById('modalVerbPresentCard'),
    modalVerbPresentText: document.getElementById('modalVerbPresentText'),
    modalVerbImperativeCard: document.getElementById('modalVerbImperativeCard'),
    modalVerbImperativeText: document.getElementById('modalVerbImperativeText'),

    // Verb Conjugation Popover Modal
    verbConjugationModal: document.getElementById('verbConjugationModal'),
    modalConjugationVerbName: document.getElementById('modalConjugationVerbName'),
    modalConjugationFormTag: document.getElementById('modalConjugationFormTag'),
    btnCloseConjugationModal: document.getElementById('btnCloseConjugationModal'),
    btnCloseConjugationBottom: document.getElementById('btnCloseConjugationBottom'),
    tabConjugationPresent: document.getElementById('tabConjugationPresent'),
    tabConjugationPast: document.getElementById('tabConjugationPast'),
    tabConjugationImperative: document.getElementById('tabConjugationImperative'),
    conjugationCardsContainer: document.getElementById('conjugationCardsContainer'),

    // Settings Modal
    btnOpenSettingsAvatar: document.getElementById('btnOpenSettingsAvatar'),
    headerUsernameText: document.getElementById('headerUsernameText'),
    headerAvatarImg: document.getElementById('headerAvatarImg'),
    btnChangeAvatar: document.getElementById('btnChangeAvatar'),
    avatarFileInput: document.getElementById('avatarFileInput'),
    settingsModal: document.getElementById('settingsModal'),
    btnCloseSettings: document.getElementById('btnCloseSettings'),
    settingsDailyGoalSelect: document.getElementById('settingsDailyGoalSelect'),
    sessionSizeSelect: document.getElementById('sessionSizeSelect'),
    btnResetProgress: document.getElementById('btnResetProgress'),

    // User Authentication & Registration
    loginOverlay: document.getElementById('loginOverlay'),
    authModeTabs: document.getElementById('authModeTabs'),
    tabAuthLogin: document.getElementById('tabAuthLogin'),
    tabAuthRegister: document.getElementById('tabAuthRegister'),
    authResetHeader: document.getElementById('authResetHeader'),
    loginForm: document.getElementById('loginForm'),
    loginUsername: document.getElementById('loginUsername'),
    loginPassword: document.getElementById('loginPassword'),
    btnLoginSubmit: document.getElementById('btnLoginSubmit'),
    registerForm: document.getElementById('registerForm'),
    registerEmail: document.getElementById('registerEmail'),
    registerCode: document.getElementById('registerCode'),
    btnSendRegisterCode: document.getElementById('btnSendRegisterCode'),
    registerPassword: document.getElementById('registerPassword'),
    registerUsername: document.getElementById('registerUsername'),
    registerAgree: document.getElementById('registerAgree'),
    registerAgreeLabel: document.getElementById('registerAgreeLabel'),
    btnRegisterSubmit: document.getElementById('btnRegisterSubmit'),
    resetPasswordForm: document.getElementById('resetPasswordForm'),
    resetEmail: document.getElementById('resetEmail'),
    resetCode: document.getElementById('resetCode'),
    btnSendResetCode: document.getElementById('btnSendResetCode'),
    resetNewPassword: document.getElementById('resetNewPassword'),
    btnResetSubmit: document.getElementById('btnResetSubmit'),
    loginErrorAlert: document.getElementById('loginErrorAlert'),
    loginErrorMsg: document.getElementById('loginErrorMsg'),
    btnLogout: document.getElementById('btnLogout'),
    currentAccountBadge: document.getElementById('currentAccountBadge'),
    currentRoleBadge: document.getElementById('currentRoleBadge'),
    currentEmailBadge: document.getElementById('currentEmailBadge'),
    accountInitialBadge: document.getElementById('accountInitialBadge'),
    btnToggleEditNickname: document.getElementById('btnToggleEditNickname'),
    editNicknamePanel: document.getElementById('editNicknamePanel'),
    inputNewNickname: document.getElementById('inputNewNickname'),
    btnSaveNickname: document.getElementById('btnSaveNickname'),
    btnToggleChangePassword: document.getElementById('btnToggleChangePassword'),
    changePasswordPanel: document.getElementById('changePasswordPanel'),
    inputCurrentPassword: document.getElementById('inputCurrentPassword'),
    inputChangedPassword: document.getElementById('inputChangedPassword'),
    btnSaveChangedPassword: document.getElementById('btnSaveChangedPassword'),
    btnToggleFeedback: document.getElementById('btnToggleFeedback'),
    feedbackPanel: document.getElementById('feedbackPanel'),
    inputFeedback: document.getElementById('inputFeedback'),
    feedbackCounter: document.getElementById('feedbackCounter'),
    btnSubmitFeedback: document.getElementById('btnSubmitFeedback'),
    tabAdminUsers: document.getElementById('tabAdminUsers'),
    tabAdminFeedback: document.getElementById('tabAdminFeedback'),
    adminUsersPane: document.getElementById('adminUsersPane'),
    adminFeedbackPane: document.getElementById('adminFeedbackPane'),
    adminFeedbackListContainer: document.getElementById('adminFeedbackListContainer'),
    adminFeedbackBadge: document.getElementById('adminFeedbackBadge'),

    // Admin User Overview Modal
    btnOpenAdminOverview: document.getElementById('btnOpenAdminOverview'),
    adminOverviewModal: document.getElementById('adminOverviewModal'),
    btnCloseAdminOverview: document.getElementById('btnCloseAdminOverview'),
    btnRefreshAdminOverview: document.getElementById('btnRefreshAdminOverview'),
    adminStatUsers: document.getElementById('adminStatUsers'),
    adminStatActiveToday: document.getElementById('adminStatActiveToday'),
    adminStatProgress: document.getElementById('adminStatProgress'),
    adminStatSessions: document.getElementById('adminStatSessions'),
    adminUsersListContainer: document.getElementById('adminUsersListContainer'),

    // Toast
    toast: document.getElementById('toast'),
    toastMessage: document.getElementById('toastMessage'),

    // Synonym / antonym meaning popover
    wordPeekPopover: document.getElementById('wordPeekPopover'),
    wordPeekQuery: document.getElementById('wordPeekQuery'),
    wordPeekLoading: document.getElementById('wordPeekLoading'),
    wordPeekResults: document.getElementById('wordPeekResults'),
    wordPeekEmpty: document.getElementById('wordPeekEmpty'),
    wordPeekError: document.getElementById('wordPeekError'),
    wordPeekClose: document.getElementById('wordPeekClose'),
};

// ---------------- User Authentication, Multi-Tenant Isolation & Cloud Preferences ----------------

const auth = {
    TOKEN_KEY: 'kalima_auth_token',
    USER_KEY: 'kalima_user_info',

    getPrefsStorageKey(uid) {
        return `kalima_prefs_${uid || 'guest'}`;
    },

    getToken() {
        return localStorage.getItem(this.TOKEN_KEY);
    },

    setSession(token, user) {
        if (token) localStorage.setItem(this.TOKEN_KEY, token);
        if (user) {
            localStorage.setItem(this.USER_KEY, JSON.stringify(user));
            if (user.preferences && user.id) {
                localStorage.setItem(this.getPrefsStorageKey(user.id), JSON.stringify(user.preferences));
            }
        }
    },

    clearSession() {
        localStorage.removeItem(this.TOKEN_KEY);
        localStorage.removeItem(this.USER_KEY);
    },

    getUser() {
        const str = localStorage.getItem(this.USER_KEY);
        try { return str ? JSON.parse(str) : null; } catch { return null; }
    },

    getLocalUserPrefs(uid) {
        if (!uid) return null;
        try {
            const raw = localStorage.getItem(this.getPrefsStorageKey(uid));
            return raw ? JSON.parse(raw) : null;
        } catch {
            return null;
        }
    }
};

let codeTimers = {
    register: null,
    reset_password: null,
};

function showAuthBanner(msg, kind = 'error') {
    const alertEl = elements.loginErrorAlert || document.getElementById('loginErrorAlert');
    const msgEl = elements.loginErrorMsg || document.getElementById('loginErrorMsg');
    if (!alertEl || !msgEl) return;
    msgEl.textContent = msg;
    alertEl.classList.remove(
        'hidden',
        'bg-rose-50',
        'border-rose-200',
        'text-rose-700',
        'bg-emerald-50',
        'border-emerald-200',
        'text-emerald-800'
    );
    if (kind === 'success') {
        alertEl.classList.add('bg-emerald-50', 'border-emerald-200', 'text-emerald-800');
    } else {
        alertEl.classList.add('bg-rose-50', 'border-rose-200', 'text-rose-700');
    }
}

function hideAuthBanner() {
    const alertEl = elements.loginErrorAlert || document.getElementById('loginErrorAlert');
    if (alertEl) alertEl.classList.add('hidden');
}

function switchAuthMode(mode = 'login') {
    hideAuthBanner();
    const isLogin = mode === 'login';
    const isRegister = mode === 'register';
    const isReset = mode === 'reset';

    if (elements.authModeTabs) {
        elements.authModeTabs.classList.toggle('hidden', isReset);
        elements.authModeTabs.classList.toggle('grid', !isReset);
    }
    if (elements.authResetHeader) {
        elements.authResetHeader.classList.toggle('hidden', !isReset);
        elements.authResetHeader.classList.toggle('flex', isReset);
    }

    if (elements.tabAuthLogin && elements.tabAuthRegister) {
        elements.tabAuthLogin.className = isLogin
            ? 'py-2 rounded-xl text-xs font-bold transition cursor-pointer bg-white text-stone-900 shadow-xs'
            : 'py-2 rounded-xl text-xs font-bold transition cursor-pointer text-stone-500 hover:text-stone-800';
        elements.tabAuthRegister.className = isRegister
            ? 'py-2 rounded-xl text-xs font-bold transition cursor-pointer bg-white text-stone-900 shadow-xs'
            : 'py-2 rounded-xl text-xs font-bold transition cursor-pointer text-stone-500 hover:text-stone-800';
    }

    if (elements.loginForm) {
        elements.loginForm.classList.toggle('hidden', !isLogin);
        elements.loginForm.classList.toggle('flex', isLogin);
    }
    if (elements.registerForm) {
        elements.registerForm.classList.toggle('hidden', !isRegister);
        elements.registerForm.classList.toggle('flex', isRegister);
    }
    if (elements.resetPasswordForm) {
        elements.resetPasswordForm.classList.toggle('hidden', !isReset);
        elements.resetPasswordForm.classList.toggle('flex', isReset);
    }

    if (isLogin && elements.loginUsername) elements.loginUsername.focus();
    if (isRegister && elements.registerEmail) elements.registerEmail.focus();
    if (isReset && elements.resetEmail) elements.resetEmail.focus();

    // Consent must be re-given every time the register tab is opened.
    if (isRegister) {
        resetLegalConsentState();
    }
}

/**
 * Reset the registration consent checkbox to its default (unchecked, submit locked).
 */
function resetLegalConsentState() {
    const box = elements.registerAgree || document.getElementById('registerAgree');
    const label = elements.registerAgreeLabel || document.getElementById('registerAgreeLabel');
    const submitBtn = elements.btnRegisterSubmit || document.getElementById('btnRegisterSubmit');
    if (box) box.checked = false;
    if (label) label.classList.remove('legal-agree--error');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
    }
}

function syncLegalConsentState() {
    const box = elements.registerAgree || document.getElementById('registerAgree');
    const label = elements.registerAgreeLabel || document.getElementById('registerAgreeLabel');
    const submitBtn = elements.btnRegisterSubmit || document.getElementById('btnRegisterSubmit');
    const checked = !!(box && box.checked);
    if (label && checked) label.classList.remove('legal-agree--error');
    if (submitBtn) {
        submitBtn.disabled = !checked;
        submitBtn.classList.toggle('opacity-50', !checked);
        submitBtn.classList.toggle('cursor-not-allowed', !checked);
    }
}

function flagLegalConsentError() {
    const box = elements.registerAgree || document.getElementById('registerAgree');
    const label = elements.registerAgreeLabel || document.getElementById('registerAgreeLabel');
    if (label) {
        label.classList.remove('legal-agree--error');
        // force reflow so the shake animation can replay
        void label.offsetWidth;
        label.classList.add('legal-agree--error');
        label.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
    if (box) box.focus();
}

// ---------------- Legal documents modal (terms / privacy) ----------------

const legalDocCache = new Map();

async function openLegalModal(kind) {
    const modal = document.getElementById('legalModal');
    const title = document.getElementById('legalModalTitle');
    const body = document.getElementById('legalModalBody');
    if (!modal || !title || !body) return;

    const meta = {
        terms: { title: '用户服务协议', path: '/legal/terms' },
        privacy: { title: '隐私政策', path: '/legal/privacy' },
    }[kind] || { title: '用户协议', path: '/legal/terms' };

    title.textContent = meta.title;
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.body.style.overflow = 'hidden';

    if (legalDocCache.has(kind)) {
        body.innerHTML = legalDocCache.get(kind);
        body.scrollTop = 0;
        return;
    }

    body.innerHTML = '<div class="text-xs text-stone-400 py-8 text-center">正在加载…</div>';
    try {
        const res = await fetch(meta.path, { cache: 'force-cache' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const html = await res.text();
        legalDocCache.set(kind, html);
        body.innerHTML = html;
        body.scrollTop = 0;
    } catch (err) {
        console.error('load legal doc failed:', err);
        body.innerHTML = '<div class="text-xs text-rose-500 py-8 text-center">协议加载失败，请检查网络后重试</div>';
    }
}

function closeLegalModal() {
    const modal = document.getElementById('legalModal');
    if (!modal) return;
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    document.body.style.overflow = '';
}

function togglePasswordVisibility(inputId, btnEl) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const nextType = input.type === 'password' ? 'text' : 'password';
    input.type = nextType;
    if (btnEl) {
        btnEl.classList.toggle('text-amber-600', nextType === 'text');
    }
}

async function authFetch(url, options = {}) {
    const token = auth.getToken();
    const headers = { ...(options.headers || {}) };
    if (token) {
        headers['Authorization'] = `Bearer ${token}`;
    }
    const res = await fetch(url, { ...options, headers });
    if (res.status === 401 && !url.startsWith('/api/auth/login') && !url.startsWith('/api/login')) {
        auth.clearSession();
        resetUserRuntimeState();
        showLoginOverlay();
    }
    return res;
}

function showLoginOverlay(mode = 'login') {
    if (elements.loginOverlay) {
        elements.loginOverlay.classList.remove('hidden');
        elements.loginOverlay.classList.add('flex');
        switchAuthMode(mode);
    }
}

function hideLoginOverlay() {
    if (elements.loginOverlay) {
        elements.loginOverlay.classList.add('hidden');
        elements.loginOverlay.classList.remove('flex');
    }
}

/**
 * Clears all user-specific in-memory caches and UI drawers/modals so switching
 * accounts never leaks data from the previous user.
 */
function resetUserRuntimeState() {
    state.currentView = 'dashboard';
    state.selectedLevel = 'all';
    state.dailyGoal = 20;
    state.reviewGoal = 20;
    state.sessionLimit = 20;
    state.deck = [];
    state.wordTracker = {};
    state.currentTask = null;
    state.currentWord = null;
    state.allWordsCache = [];
    state.levelsCache = [];
    state.dashboardData = {
        total_words: 0,
        learn_count: 0,
        review_count: 0,
        total_reviewing: 0,
        mastered_count: 0,
        today_checked: false,
        streak_days: 0,
        date_display: '',
    };

    if (elements.dashboardView) elements.dashboardView.classList.remove('hidden');
    if (elements.flashcardView) elements.flashcardView.classList.add('hidden');
    if (elements.libraryWordList) elements.libraryWordList.innerHTML = '';
    if (elements.librarySearchInput) elements.librarySearchInput.value = '';
    if (elements.libraryStatusFilter) elements.libraryStatusFilter.value = 'all';
    if (elements.libraryDifficultyFilter) elements.libraryDifficultyFilter.value = 'all';
    if (elements.settingsModal) {
        elements.settingsModal.classList.add('hidden');
        elements.settingsModal.classList.remove('flex');
    }
    if (elements.adminOverviewModal) {
        elements.adminOverviewModal.classList.add('hidden');
        elements.adminOverviewModal.classList.remove('flex');
    }
    if (elements.editNicknamePanel) elements.editNicknamePanel.classList.add('hidden');
    if (elements.changePasswordPanel) elements.changePasswordPanel.classList.add('hidden');
    if (elements.btnOpenAdminOverview) elements.btnOpenAdminOverview.classList.add('hidden');
    if (elements.headerUsernameText) elements.headerUsernameText.textContent = '未登录';
    setHeaderAvatar(null);
}

/** Default avatar shown when the account has not uploaded one. */
const DEFAULT_AVATAR_URL = '/images/avatar-default.svg';

function setHeaderAvatar(url) {
    const img = elements.headerAvatarImg || document.getElementById('headerAvatarImg');
    if (img) img.src = url || DEFAULT_AVATAR_URL;
}

/** Center-crop + downscale an image file to a small square JPEG data URL. */
function resizeAvatarFile(file, size = 256) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new Error('read failed'));
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error('decode failed'));
            img.onload = () => {
                const canvas = document.createElement('canvas');
                canvas.width = size;
                canvas.height = size;
                const ctx = canvas.getContext('2d');
                const side = Math.min(img.width, img.height);
                const sx = (img.width - side) / 2;
                const sy = (img.height - side) / 2;
                ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
                let quality = 0.85;
                let out = canvas.toDataURL('image/jpeg', quality);
                // Server caps decoded size at 64KB (~86KB base64).
                while (out.length > 86000 && quality > 0.4) {
                    quality -= 0.1;
                    out = canvas.toDataURL('image/jpeg', quality);
                }
                resolve(out);
            };
            img.src = reader.result;
        };
        reader.readAsDataURL(file);
    });
}

async function handleAvatarFileChange(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;

    if (!/^image\/(png|jpeg|webp)$/.test(file.type)) {
        showToast('请选择 PNG / JPEG / WebP 图片');
        return;
    }
    if (file.size > 8 * 1024 * 1024) {
        showToast('图片过大，请选择 8MB 以内的图片');
        return;
    }

    try {
        const dataUrl = await resizeAvatarFile(file);
        const res = await authFetch('/api/auth/avatar', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ avatar: dataUrl }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(data.error || '头像更新失败，请重试');
            return;
        }
        auth.setSession(auth.getToken(), data.user);
        updateAccountDisplay(data.user);
        showToast('头像已更新');
    } catch (err) {
        console.error('avatar upload failed:', err);
        showToast('头像处理失败，请换一张图片试试');
    }
}

function updateAccountDisplay(user) {
    if (!user) user = auth.getUser();
    if (!user) return;

    const uname = user.username || '学习者';
    const email = user.email || '';
    const isAdmin = user.role === 'admin';

    if (elements.currentAccountBadge) elements.currentAccountBadge.textContent = uname;
    if (elements.accountInitialBadge) elements.accountInitialBadge.textContent = uname.charAt(0).toUpperCase();
    if (elements.currentEmailBadge) elements.currentEmailBadge.textContent = email || '独立词库账户';
    if (elements.headerUsernameText) elements.headerUsernameText.textContent = uname;
    setHeaderAvatar(user.avatar_url);

    if (elements.currentRoleBadge) {
        elements.currentRoleBadge.textContent = isAdmin ? '管理员' : '独立账户';
        elements.currentRoleBadge.className = isAdmin
            ? 'px-1.5 py-0.2 rounded text-3xs font-bold bg-amber-200 text-amber-950 shrink-0'
            : 'px-1.5 py-0.2 rounded text-3xs font-semibold bg-emerald-100 text-emerald-800 shrink-0';
    }
    if (elements.btnOpenAdminOverview) {
        elements.btnOpenAdminOverview.classList.toggle('hidden', !isAdmin);
    }
}

function applyUserSessionAndPreferences(user) {
    if (!user) return;
    const localPrefs = auth.getLocalUserPrefs(user.id) || {};
    const cloudPrefs = user.preferences || {};

    const dailyGoal = parseInt(cloudPrefs.daily_goal ?? localPrefs.daily_goal ?? 20, 10) || 20;
    const reviewGoal = parseInt(cloudPrefs.review_goal ?? localPrefs.review_goal ?? 20, 10) || 20;
    const selectedLevel = cloudPrefs.selected_level || localPrefs.selected_level || 'all';
    const savedTheme = cloudPrefs.theme || localPrefs.theme || 'theme-cream';

    state.dailyGoal = dailyGoal;
    state.sessionLimit = dailyGoal;
    state.reviewGoal = reviewGoal;
    state.selectedLevel = selectedLevel;

    const themeIdx = THEMES.findIndex(t => t.id === savedTheme);
    state.currentThemeIndex = themeIdx >= 0 ? themeIdx : 0;
    applyCurrentTheme();

    if (elements.libraryDifficultyFilter) {
        const hasOpt = Array.from(elements.libraryDifficultyFilter.options || []).some(o => o.value === selectedLevel);
        elements.libraryDifficultyFilter.value = hasOpt ? selectedLevel : 'all';
    }

    updateDailyGoalUI();
    updateReviewGoalUI();
    updateAccountDisplay(user);
}

async function persistUserPreferencesPatch(patch) {
    const user = auth.getUser();
    if (!user || !user.id) return;

    const existing = auth.getLocalUserPrefs(user.id) || user.preferences || {
        daily_goal: state.dailyGoal,
        review_goal: state.reviewGoal,
        selected_level: state.selectedLevel,
        theme: THEMES[state.currentThemeIndex]?.id || 'theme-cream',
    };
    const merged = { ...existing, ...patch };
    user.preferences = merged;
    auth.setSession(auth.getToken(), user);

    try {
        await authFetch('/api/auth/preferences', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(patch),
        });
    } catch (err) {
        console.warn('Failed to sync user preferences to cloud:', err);
    }
}

async function checkAuthOnStartup() {
    const token = auth.getToken();
    if (!token) {
        resetUserRuntimeState();
        showLoginOverlay('login');
        return false;
    }

    try {
        const res = await fetch('/api/auth/verify', {
            headers: { 'Authorization': `Bearer ${token}` },
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.valid && data.user) {
            auth.setSession(token, data.user);
            applyUserSessionAndPreferences(data.user);
            hideLoginOverlay();
            return true;
        }
    } catch (err) {
        console.warn('Startup session verify network error:', err);
    }

    auth.clearSession();
    resetUserRuntimeState();
    showLoginOverlay('login');
    return false;
}

async function handleLogout() {
    try {
        await authFetch('/api/logout', { method: 'POST' });
    } catch {
        // Ignore network failure on logout
    }
    auth.clearSession();
    resetUserRuntimeState();
    if (elements.loginPassword) elements.loginPassword.value = '';
    showLoginOverlay('login');
    showToast('已安全退出当前账号');
}

function startSendCodeCountdown(purpose, seconds = 60) {
    const btn = purpose === 'reset_password'
        ? (elements.btnSendResetCode || document.getElementById('btnSendResetCode'))
        : (elements.btnSendRegisterCode || document.getElementById('btnSendRegisterCode'));
    if (!btn) return;

    if (codeTimers[purpose]) {
        clearInterval(codeTimers[purpose]);
        codeTimers[purpose] = null;
    }

    let remaining = seconds;
    btn.disabled = true;
    btn.classList.add('opacity-60', 'cursor-not-allowed');
    btn.textContent = `${remaining}s 后重发`;

    codeTimers[purpose] = setInterval(() => {
        remaining -= 1;
        if (remaining <= 0) {
            clearInterval(codeTimers[purpose]);
            codeTimers[purpose] = null;
            btn.disabled = false;
            btn.classList.remove('opacity-60', 'cursor-not-allowed');
            btn.textContent = '重新获取';
        } else {
            btn.textContent = `${remaining}s 后重发`;
        }
    }, 1000);
}

async function handleSendVerificationCode(purpose = 'register') {
    hideAuthBanner();
    const emailInput = purpose === 'reset_password'
        ? (elements.resetEmail || document.getElementById('resetEmail'))
        : (elements.registerEmail || document.getElementById('registerEmail'));
    const btn = purpose === 'reset_password'
        ? (elements.btnSendResetCode || document.getElementById('btnSendResetCode'))
        : (elements.btnSendRegisterCode || document.getElementById('btnSendRegisterCode'));

    const email = emailInput ? emailInput.value.trim() : '';
    if (!email || !email.includes('@')) {
        showAuthBanner('请先输入正确的邮箱地址', 'error');
        if (emailInput) emailInput.focus();
        return;
    }

    if (btn) {
        btn.disabled = true;
        btn.textContent = '发送中...';
    }

    try {
        const res = await fetch('/api/auth/send-code', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, purpose }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data.success) {
            const devHint = data.dev_code ? `（开发调试验证码：${data.dev_code}）` : '';
            showAuthBanner(`${data.message || '验证码已发送至邮箱'}${devHint}`, 'success');
            startSendCodeCountdown(purpose, data.cooldown || 60);
            const codeField = purpose === 'reset_password' ? elements.resetCode : elements.registerCode;
            if (codeField) codeField.focus();
        } else {
            showAuthBanner(data.error || data.message || '验证码发送失败，请稍后重试', 'error');
            if (data.retry_after && Number(data.retry_after) > 0) {
                startSendCodeCountdown(purpose, Number(data.retry_after));
            } else if (btn) {
                btn.disabled = false;
                btn.textContent = '获取验证码';
            }
        }
    } catch {
        showAuthBanner('网络连接异常，请检查网络后重试', 'error');
        if (btn) {
            btn.disabled = false;
            btn.textContent = '获取验证码';
        }
    }
}

async function handleLogin() {
    hideAuthBanner();
    const userEl = elements.loginUsername || document.getElementById('loginUsername');
    const passEl = elements.loginPassword || document.getElementById('loginPassword');
    const submitBtn = elements.btnLoginSubmit || document.getElementById('btnLoginSubmit');

    const identifier = userEl ? userEl.value.trim() : '';
    const password = passEl ? passEl.value : '';

    if (!identifier || !password) {
        showAuthBanner('请输入注册邮箱/用户名和登录密码', 'error');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div><span>正在登录...</span>`;
    }

    try {
        const res = await fetch('/api/auth/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ identifier, password }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data.token && data.user) {
            resetUserRuntimeState();
            auth.setSession(data.token, data.user);
            applyUserSessionAndPreferences(data.user);
            hideLoginOverlay();
            if (passEl) passEl.value = '';
            showToast(`🎉 欢迎回来，${data.user.username}！`);
            loadDashboardData();
        } else {
            showAuthBanner(data.error || data.message || '账号或密码错误，请核对后重试', 'error');
            if (passEl) {
                passEl.value = '';
                passEl.focus();
            }
        }
    } catch {
        showAuthBanner('网络连接异常，请检查后重试', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<span>登 录</span><svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M14 5l7 7m0 0l-7 7m7-7H3"></path></svg>`;
        }
    }
}

async function handleRegister() {
    hideAuthBanner();
    const email = elements.registerEmail ? elements.registerEmail.value.trim() : '';
    const code = elements.registerCode ? elements.registerCode.value.trim() : '';
    const password = elements.registerPassword ? elements.registerPassword.value : '';
    const username = elements.registerUsername ? elements.registerUsername.value.trim() : '';
    const submitBtn = elements.btnRegisterSubmit;

    if (!email || !code || !password) {
        showAuthBanner('请完整填写邮箱、6位验证码和登录密码', 'error');
        return;
    }
    if (password.length < 6) {
        showAuthBanner('登录密码长度至少需要 6 位', 'error');
        return;
    }

    const agreeBox = document.getElementById('registerAgree');
    if (!agreeBox || !agreeBox.checked) {
        flagLegalConsentError();
        showAuthBanner('请先勾选同意《用户服务协议》与《隐私政策》', 'error');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div><span>正在创建独立账户...</span>`;
    }

    try {
        const res = await fetch('/api/auth/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code, password, username, agreed_legal: true }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data.token && data.user) {
            resetUserRuntimeState();
            auth.setSession(data.token, data.user);
            applyUserSessionAndPreferences(data.user);
            hideLoginOverlay();
            if (elements.registerCode) elements.registerCode.value = '';
            if (elements.registerPassword) elements.registerPassword.value = '';
            resetLegalConsentState();
            showToast(data.message || `🎉 注册成功，欢迎 ${data.user.username}！`);
            loadDashboardData();
        } else {
            showAuthBanner(data.error || data.message || '注册失败，请核对验证码后重试', 'error');
        }
    } catch {
        showAuthBanner('网络连接异常，请稍后重试', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<span>注册并建立独立词库档案</span>`;
        }
    }
}

async function handleResetPassword() {
    hideAuthBanner();
    const email = elements.resetEmail ? elements.resetEmail.value.trim() : '';
    const code = elements.resetCode ? elements.resetCode.value.trim() : '';
    const newPassword = elements.resetNewPassword ? elements.resetNewPassword.value : '';
    const submitBtn = elements.btnResetSubmit;

    if (!email || !code || !newPassword) {
        showAuthBanner('请填写注册邮箱、6位验证码和新密码', 'error');
        return;
    }
    if (newPassword.length < 6) {
        showAuthBanner('新密码长度至少需要 6 位', 'error');
        return;
    }

    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.innerHTML = `<div class="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin"></div><span>重置中...</span>`;
    }

    try {
        const res = await fetch('/api/auth/reset-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, code, new_password: newPassword }),
        });
        const data = await res.json().catch(() => ({}));

        if (res.ok && data.success) {
            if (elements.loginUsername) elements.loginUsername.value = email;
            if (elements.resetCode) elements.resetCode.value = '';
            if (elements.resetNewPassword) elements.resetNewPassword.value = '';
            switchAuthMode('login');
            showAuthBanner(data.message || '密码重置成功，请使用新密码登录', 'success');
            if (elements.loginPassword) elements.loginPassword.focus();
        } else {
            showAuthBanner(data.error || data.message || '密码重置失败，请核对验证码', 'error');
        }
    } catch {
        showAuthBanner('网络连接异常，请稍后重试', 'error');
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<span>确认重置密码</span>`;
        }
    }
}

async function handleSaveNickname() {
    const input = elements.inputNewNickname;
    const btn = elements.btnSaveNickname;
    if (!input) return;
    const newName = input.value.trim();
    if (newName.length < 2 || newName.length > 24) {
        showToast('昵称长度需在 2 到 24 个字符之间');
        return;
    }

    if (btn) btn.disabled = true;
    try {
        const res = await authFetch('/api/auth/profile', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username: newName }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success && data.user) {
            auth.setSession(data.token || auth.getToken(), data.user);
            updateAccountDisplay(data.user);
            if (elements.editNicknamePanel) elements.editNicknamePanel.classList.add('hidden');
            input.value = '';
            showToast('✨ 昵称已更新！');
        } else {
            showToast(data.error || '昵称修改失败');
        }
    } catch {
        showToast('网络异常，请重试');
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function handleSaveChangedPassword() {
    const curEl = elements.inputCurrentPassword;
    const newEl = elements.inputChangedPassword;
    const btn = elements.btnSaveChangedPassword;
    if (!curEl || !newEl) return;

    const currentPassword = curEl.value;
    const newPassword = newEl.value;
    if (!currentPassword || newPassword.length < 6) {
        showToast('请输入原密码，且新密码不少于 6 位');
        return;
    }

    if (btn) btn.disabled = true;
    try {
        const res = await authFetch('/api/auth/change-password', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ current_password: currentPassword, new_password: newPassword }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.success && data.token) {
            auth.setSession(data.token, auth.getUser());
            curEl.value = '';
            newEl.value = '';
            if (elements.changePasswordPanel) elements.changePasswordPanel.classList.add('hidden');
            showToast('🔒 密码修改成功，旧设备登录已自动失效');
        } else {
            showToast(data.error || '密码修改失败');
        }
    } catch {
        showToast('网络异常，请重试');
    } finally {
        if (btn) btn.disabled = false;
    }
}

function formatBeijingShortTime(isoStr) {
    if (!isoStr) return '—';
    try {
        const d = new Date(isoStr);
        if (isNaN(d.getTime())) return '—';
        return d.toLocaleString('zh-CN', {
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        });
    } catch {
        return '—';
    }
}

async function openAdminOverviewModal() {
    if (!elements.adminOverviewModal) return;
    if (elements.settingsModal) {
        elements.settingsModal.classList.add('hidden');
        elements.settingsModal.classList.remove('flex');
    }
    elements.adminOverviewModal.classList.remove('hidden');
    elements.adminOverviewModal.classList.add('flex');
    switchAdminTab('users');
    await loadAdminOverviewData();
    loadAdminFeedback();
}

function closeAdminOverviewModal() {
    if (!elements.adminOverviewModal) return;
    elements.adminOverviewModal.classList.add('hidden');
    elements.adminOverviewModal.classList.remove('flex');
}

async function loadAdminOverviewData() {
    if (!elements.adminUsersListContainer) return;
    elements.adminUsersListContainer.innerHTML = `<div class="text-center py-10 text-xs text-stone-400">正在读取 D1 后台用户数据...</div>`;

    try {
        const res = await authFetch('/api/admin/overview');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            elements.adminUsersListContainer.innerHTML = `<div class="text-center py-10 text-xs text-rose-500">${escapeHtml(data.message || data.error || '加载失败')}</div>`;
            return;
        }

        const sum = data.summary || {};
        if (elements.adminStatUsers) elements.adminStatUsers.textContent = sum.total_users ?? 0;
        if (elements.adminStatActiveToday) elements.adminStatActiveToday.textContent = sum.active_today_users ?? 0;
        if (elements.adminStatProgress) elements.adminStatProgress.textContent = sum.total_progress_records ?? 0;
        if (elements.adminStatSessions) elements.adminStatSessions.textContent = sum.total_study_sessions ?? 0;

        const users = data.users || [];
        if (users.length === 0) {
            elements.adminUsersListContainer.innerHTML = `<div class="text-center py-10 text-xs text-stone-400">暂无注册用户记录</div>`;
            return;
        }

        elements.adminUsersListContainer.innerHTML = users.map(u => {
            const roleTag = u.role === 'admin'
                ? `<span class="px-1.5 py-0.5 rounded bg-amber-100 text-amber-900 text-3xs font-bold">管理员</span>`
                : `<span class="px-1.5 py-0.5 rounded bg-stone-100 text-stone-600 text-3xs font-medium">学员</span>`;
            return `
                <div class="p-3.5 rounded-2xl bg-stone-50/80 border border-stone-200/80 flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <div class="min-w-0">
                        <div class="flex items-center gap-1.5 flex-wrap">
                            <span class="text-xs font-bold text-stone-900">${escapeHtml(u.username)}</span>
                            ${roleTag}
                            <span class="text-2xs text-stone-500 font-mono truncate">${escapeHtml(u.email)}</span>
                        </div>
                        <div class="text-2xs text-stone-400 mt-1 flex flex-wrap items-center gap-x-3 gap-y-0.5">
                            <span>注册: ${escapeHtml(formatBeijingShortTime(u.created_at))}</span>
                            <span>最近活跃: ${escapeHtml(formatBeijingShortTime(u.last_active_at || u.last_login_at))}</span>
                            <span>词书: ${escapeHtml(getLevelDisplayTitle(u.selected_level || 'all'))} (${u.daily_goal || 20}词/日)</span>
                        </div>
                    </div>
                    <div class="flex items-center gap-2 shrink-0 text-2xs font-mono">
                        <span class="px-2 py-1 rounded-lg bg-white border border-stone-200 text-stone-700">已学 <strong class="text-amber-700">${u.learned_count}</strong></span>
                        <span class="px-2 py-1 rounded-lg bg-white border border-stone-200 text-stone-700">熟记 <strong class="text-emerald-700">${u.mastered_count}</strong></span>
                        <span class="px-2 py-1 rounded-lg bg-white border border-stone-200 text-stone-700">打卡 <strong class="text-rose-600">${u.checkin_days}</strong>天</span>
                        <span class="px-2 py-1 rounded-lg bg-white border border-stone-200 text-stone-700">批次 <strong class="text-blue-700">${u.session_count}</strong></span>
                    </div>
                </div>
            `;
        }).join('');
    } catch {
        elements.adminUsersListContainer.innerHTML = `<div class="text-center py-10 text-xs text-rose-500">网络错误，请点击刷新重试</div>`;
    }
}

function switchAdminTab(tab) {
    const isUsers = tab !== 'feedback';
    if (elements.adminUsersPane) elements.adminUsersPane.classList.toggle('hidden', !isUsers);
    if (elements.adminFeedbackPane) elements.adminFeedbackPane.classList.toggle('hidden', isUsers);
    if (elements.tabAdminUsers) {
        elements.tabAdminUsers.className = isUsers
            ? 'flex-1 py-1.5 rounded-lg bg-white text-xs font-bold text-stone-900 transition cursor-pointer'
            : 'flex-1 py-1.5 rounded-lg text-xs font-bold text-stone-500 hover:text-stone-800 transition cursor-pointer';
    }
    if (elements.tabAdminFeedback) {
        elements.tabAdminFeedback.className = isUsers
            ? 'flex-1 py-1.5 rounded-lg text-xs font-bold text-stone-500 hover:text-stone-800 transition cursor-pointer flex items-center justify-center gap-1'
            : 'flex-1 py-1.5 rounded-lg bg-white text-xs font-bold text-stone-900 transition cursor-pointer flex items-center justify-center gap-1';
    }
    if (!isUsers) loadAdminFeedback();
}

function setAdminFeedbackBadge(count) {
    const badge = elements.adminFeedbackBadge;
    if (!badge) return;
    if (count > 0) {
        badge.textContent = String(count);
        badge.classList.remove('hidden');
    } else {
        badge.classList.add('hidden');
    }
}

async function loadAdminFeedback() {
    const box = elements.adminFeedbackListContainer;
    if (!box) return;
    box.innerHTML = '<div class="text-center py-10 text-xs text-stone-400">正在加载用户反馈...</div>';
    try {
        const res = await authFetch('/api/admin/feedback');
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            box.innerHTML = `<div class="text-center py-10 text-xs text-rose-500">${escapeHtml(data.message || data.error || '加载失败')}</div>`;
            return;
        }
        setAdminFeedbackBadge(data.total_new || 0);
        const items = data.feedback || [];
        if (!items.length) {
            box.innerHTML = '<div class="text-center py-10 text-xs text-stone-400">还没有用户提交反馈</div>';
            return;
        }
        box.innerHTML = items.map(f => `
            <div class="p-3.5 rounded-2xl bg-stone-50/80 border border-stone-200/80">
                <div class="flex items-center justify-between gap-2 mb-1.5">
                    <div class="flex items-center gap-1.5 min-w-0">
                        <span class="text-xs font-bold text-stone-900 truncate">${escapeHtml(f.username || '匿名用户')}</span>
                        <span class="text-2xs text-stone-500 font-mono truncate">${escapeHtml(f.email || f.uid)}</span>
                    </div>
                    <span class="text-2xs text-stone-400 shrink-0">${escapeHtml(formatBeijingShortTime(f.created_at))}</span>
                </div>
                <p class="text-xs text-stone-700 leading-relaxed whitespace-pre-wrap break-words">${escapeHtml(f.content)}</p>
            </div>
        `).join('');
    } catch {
        box.innerHTML = '<div class="text-center py-10 text-xs text-rose-500">网络错误，请点击刷新重试</div>';
    }
}

async function handleSubmitFeedback() {
    const box = elements.inputFeedback;
    if (!box) return;
    const content = box.value.trim();
    if (content.length < 2) {
        showToast('请至少写 2 个字');
        box.focus();
        return;
    }
    if (content.length > 500) {
        showToast('反馈不能超过 500 字');
        return;
    }

    const btn = elements.btnSubmitFeedback;
    if (btn) {
        btn.disabled = true;
        btn.textContent = '提交中…';
    }
    try {
        const res = await authFetch('/api/feedback', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ content, source: 'settings' }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            showToast(data.error || data.message || '提交失败，请稍后再试');
            return;
        }
        box.value = '';
        if (elements.feedbackCounter) elements.feedbackCounter.textContent = '0 / 500';
        if (elements.feedbackPanel) elements.feedbackPanel.classList.add('hidden');
        showToast(data.message || '反馈已提交，感谢你的建议！');
    } catch {
        showToast('网络异常，请稍后重试');
    } finally {
        if (btn) {
            btn.disabled = false;
            btn.textContent = '提交反馈';
        }
    }
}

// ---------------- Fisher-Yates Shuffle Utility ----------------

function shuffleArray(arr) {
    const array = [...arr];
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// ---------------- Arabic Tashkeel Normalization & Robust Highlighting/Clozing ----------------

function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function stripArabicTashkeel(text) {
    if (!text) return '';
    return text
        .replace(/[\u0610-\u061a\u064b-\u065f\u0670\u06d6-\u06ed]/g, '')
        .replace(/ـ/g, '')
        .replace(/[أإآٱ]/g, 'ا')
        .trim();
}

function renderArabicExampleSentence(sentence, word, isCloze = false, highlightOverride = '') {
    if (!sentence) return '';
    const highlightTarget = (highlightOverride || word.highlight_ar || word.text_vocalized || '').trim();
    const clozeSpan = `<span class="px-2 py-0.5 rounded-lg bg-amber-100 text-amber-900 font-bold border-b-2 border-amber-400">______</span>`;
    
    // 1. Direct match if highlightTarget is exact substring
    if (highlightTarget && sentence.includes(highlightTarget)) {
        const idx = sentence.indexOf(highlightTarget);
        const before = escapeHtml(sentence.slice(0, idx));
        const after = escapeHtml(sentence.slice(idx + highlightTarget.length));
        if (isCloze) {
            return `${before}${clozeSpan}${after}`;
        } else {
            return `${before}<span class="ar-highlight">${escapeHtml(highlightTarget)}</span>${after}`;
        }
    }

    // 2. Token-by-token normalized match
    const targetClean = stripArabicTashkeel(word.text_unvocalized || word.text_vocalized || '');
    if (!targetClean) return escapeHtml(sentence);

    const tokens = sentence.split(/(\s+)/);
    let matched = false;

    const processed = tokens.map(token => {
        if (matched || !token.trim()) return escapeHtml(token);
        const cleanTok = stripArabicTashkeel(token);
        if (cleanTok === targetClean || cleanTok.includes(targetClean)) {
            matched = true;
            if (isCloze) {
                return clozeSpan;
            } else {
                return `<span class="ar-highlight">${escapeHtml(token)}</span>`;
            }
        }
        return escapeHtml(token);
    });

    return processed.join('');
}

// ---------------- Web Speech API ----------------

function initSpeech() {
    if (!('speechSynthesis' in window)) return;
    function populateVoices() {
        state.voices = window.speechSynthesis.getVoices();
        state.selectedVoice = state.voices.find(v => v.lang.startsWith('ar')) || null;
        state.hasArabicVoice = !!state.selectedVoice;
        if (!state.hasArabicVoice) {
            console.warn('[audio] no Arabic voice pack found; TTS will use the default voice');
        }
    }
    populateVoices();
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
        window.speechSynthesis.onvoiceschanged = populateVoices;
    }
}

function speakArabic(text, btnElement = null) {
    if (!('speechSynthesis' in window)) {
        showToast('当前浏览器不支持语音合成');
        return;
    }
    // Voice-pack detection: without an ar-* voice the browser reads Arabic with
    // the default voice, which sounds wrong. Warn once instead of failing silently.
    if (state.hasArabicVoice === null) {
        state.voices = window.speechSynthesis.getVoices();
        state.selectedVoice = state.voices.find(v => v.lang.startsWith('ar')) || null;
        state.hasArabicVoice = !!state.selectedVoice;
    }
    if (!state.hasArabicVoice && !state.voiceWarningShown) {
        state.voiceWarningShown = true;
        showToast('本机未安装阿拉伯语语音包，朗读可能不准确。可在系统「语言与区域」中安装阿拉伯语（语音）后重试。', 5000);
    }
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.lang = 'ar-SA';
    utterance.rate = 0.85;
    utterance.pitch = 1.0;
    if (state.selectedVoice) utterance.voice = state.selectedVoice;

    if (btnElement) {
        btnElement.classList.add('audio-playing', 'text-emerald-600', 'scale-110');
        utterance.onend = () => btnElement.classList.remove('audio-playing', 'text-emerald-600', 'scale-110');
        utterance.onerror = () => btnElement.classList.remove('audio-playing', 'text-emerald-600', 'scale-110');
    }
    window.speechSynthesis.speak(utterance);
}

// ---------------- Dual-Engine Audio Player (MP3 File + TTS Fallback) ----------------

function playWordAudio(word, btnElement = null) {
    if (!word) return;
    
    // 1. If genuine MP3 recording exists, play with HTML5 Audio
    if (word.audio_url) {
        if (btnElement) btnElement.classList.add('audio-playing', 'text-emerald-600', 'scale-110');
        const audio = new Audio(word.audio_url);
        audio.play().then(() => {
            audio.onended = () => {
                if (btnElement) btnElement.classList.remove('audio-playing', 'text-emerald-600', 'scale-110');
            };
            audio.onerror = () => {
                if (btnElement) btnElement.classList.remove('audio-playing', 'text-emerald-600', 'scale-110');
                speakArabic(word.text_vocalized || word.word_vocalized, btnElement);
            };
        }).catch(err => {
            console.warn('MP3 playback fallback to Web Speech TTS:', err);
            if (btnElement) btnElement.classList.remove('audio-playing', 'text-emerald-600', 'scale-110');
            speakArabic(word.text_vocalized || word.word_vocalized, btnElement);
        });
    } else {
        // 2. Web Speech TTS Fallback
        speakArabic(word.text_vocalized || word.word_vocalized, btnElement);
    }
}

function showToast(msg, duration = 2500) {
    if (!elements.toast) return;
    elements.toastMessage.textContent = msg;
    elements.toast.classList.remove('opacity-0', 'pointer-events-none', 'translate-y-4');
    elements.toast.classList.add('opacity-100', 'translate-y-0');
    setTimeout(() => {
        elements.toast.classList.add('opacity-0', 'pointer-events-none', 'translate-y-4');
        elements.toast.classList.remove('opacity-100', 'translate-y-0');
    }, duration);
}

// ---------------- Theme Management ----------------

function initTheme() {
    const user = auth.getUser();
    const prefs = user ? (auth.getLocalUserPrefs(user.id) || user.preferences || {}) : {};
    let savedTheme = prefs.theme || 'theme-cream';
    if (savedTheme === 'theme-photo') savedTheme = 'theme-cream';
    const index = THEMES.findIndex(t => t.id === savedTheme);
    state.currentThemeIndex = index >= 0 ? index : 0;
    applyCurrentTheme();
}

function cycleTheme() {
    state.currentThemeIndex = (state.currentThemeIndex + 1) % THEMES.length;
    applyCurrentTheme();
    persistUserPreferencesPatch({ theme: THEMES[state.currentThemeIndex].id });
    showToast(`已切换至: ${THEMES[state.currentThemeIndex].name}`);
}

function applyCurrentTheme() {
    const theme = THEMES[state.currentThemeIndex];
    document.body.className = `${theme.id} text-stone-800 min-h-screen flex flex-col justify-between selection:bg-amber-100 selection:text-amber-900`;
    elements.themeNameBadge.textContent = theme.name;
}

// ---------------- Daily Goal Management ----------------

function openDailyGoalModal() {
    if (!elements.dailyGoalModal) return;
    elements.dailyGoalModal.classList.remove('hidden');
    elements.dailyGoalModal.classList.add('flex');
    updateDailyGoalUI();
}

function closeDailyGoalModal() {
    if (!elements.dailyGoalModal) return;
    elements.dailyGoalModal.classList.add('hidden');
    elements.dailyGoalModal.classList.remove('flex');
}

function setDailyGoal(goal) {
    const parsed = Math.max(5, Math.min(200, parseInt(goal, 10) || 20));
    state.dailyGoal = parsed;
    state.sessionLimit = parsed;
    persistUserPreferencesPatch({ daily_goal: parsed });
    
    updateDailyGoalUI();
    closeDailyGoalModal();
    showToast(`已将每日学习目标设为 ${parsed} 词/天 🎯`);
}

function updateDailyGoalUI() {
    if (elements.learnCountBadge) elements.learnCountBadge.textContent = state.dailyGoal;
    if (elements.dailyGoalDisplayBadge) elements.dailyGoalDisplayBadge.textContent = `${state.dailyGoal} 词/日`;
    if (elements.settingsDailyGoalSelect) elements.settingsDailyGoalSelect.value = state.dailyGoal.toString();
    if (elements.sessionSizeSelect) elements.sessionSizeSelect.value = state.sessionLimit.toString();

    // Highlight active preset button in modal
    const buttons = document.querySelectorAll('.goal-option-btn');
    buttons.forEach(btn => {
        const g = parseInt(btn.getAttribute('data-goal'), 10);
        if (g === state.dailyGoal) {
            btn.className = 'goal-option-btn p-3 rounded-2xl border-2 border-amber-500 bg-amber-50 text-amber-900 font-bold text-sm transition text-center active-goal shadow-xs';
        } else {
            btn.className = 'goal-option-btn p-3 rounded-2xl border border-stone-200 bg-stone-50 hover:bg-amber-50 hover:border-amber-400 text-stone-800 font-bold text-sm transition text-center';
        }
    });
}

// ---------------- Review Goal Management (自定义复习抽词管理) ----------------

function openReviewGoalModal() {
    if (!elements.reviewGoalModal) return;
    elements.reviewGoalModal.classList.remove('hidden');
    elements.reviewGoalModal.classList.add('flex');
    updateReviewGoalUI();
}

function closeReviewGoalModal() {
    if (!elements.reviewGoalModal) return;
    elements.reviewGoalModal.classList.add('hidden');
    elements.reviewGoalModal.classList.remove('flex');
}

function setReviewGoal(goal) {
    const parsed = Math.max(5, Math.min(200, parseInt(goal, 10) || 20));
    state.reviewGoal = parsed;
    persistUserPreferencesPatch({ review_goal: parsed });
    
    updateReviewGoalUI();
    closeReviewGoalModal();
    showToast(`已将每次复习抽词量设为 ${parsed} 词 🎯`);
}

function updateReviewGoalUI() {
    if (elements.reviewCountBadge) elements.reviewCountBadge.textContent = state.reviewGoal;
    if (elements.reviewGoalDisplayBadge) elements.reviewGoalDisplayBadge.textContent = `${state.reviewGoal} 词/次`;
    
    // Highlight active preset button in modal
    const buttons = document.querySelectorAll('.review-goal-option-btn');
    buttons.forEach(btn => {
        const g = parseInt(btn.getAttribute('data-goal'), 10);
        if (g === state.reviewGoal) {
            btn.className = 'review-goal-option-btn p-3 rounded-2xl border-2 border-blue-500 bg-blue-50 text-blue-900 font-bold text-sm transition text-center active-goal shadow-xs cursor-pointer';
        } else {
            btn.className = 'review-goal-option-btn p-3 rounded-2xl border border-stone-200 bg-stone-50 hover:bg-blue-50 hover:border-blue-400 text-stone-800 font-bold text-sm transition text-center cursor-pointer';
        }
    });
}

// ---------------- Level Selection Management ----------------

async function openLevelModal() {
    if (!elements.levelSelectModal) return;
    elements.levelSelectModal.classList.remove('hidden');
    elements.levelSelectModal.classList.add('flex');
    await loadLevelsInfo();
}

function closeLevelModal() {
    if (!elements.levelSelectModal) return;
    elements.levelSelectModal.classList.add('hidden');
    elements.levelSelectModal.classList.remove('flex');
}

async function loadLevelsInfo() {
    if (!elements.levelCardsContainer) return;
    elements.levelCardsContainer.innerHTML = `
        <div class="py-12 text-center text-stone-400">
            <div class="inline-block animate-spin w-6 h-6 border-2 border-stone-300 border-t-amber-500 rounded-full mb-2"></div>
            <p class="text-xs">正在加载难度分级数据...</p>
        </div>
    `;

    try {
        const response = await authFetch('/api/levels/info');
        const data = await response.json();
        state.levelsCache = data.levels || [];
        renderLevelCards(state.levelsCache);
    } catch (err) {
        console.error('Error loading levels info:', err);
        elements.levelCardsContainer.innerHTML = `<p class="text-xs text-rose-500 text-center py-6">加载失败，请重试</p>`;
    }
}

function renderLevelCards(levels) {
    elements.levelCardsContainer.innerHTML = '';

    levels.forEach(lvl => {
        const subIds = Array.isArray(lvl.sublevels) ? lvl.sublevels.map(s => s.id) : [];
        const isSelected = state.selectedLevel === lvl.id || subIds.includes(state.selectedLevel);
        const card = document.createElement('div');

        let borderClass = isSelected
            ? 'border-2 border-amber-500 bg-amber-50/40 shadow-sm ring-2 ring-amber-400/20'
            : 'border border-stone-200/90 bg-white hover:border-amber-300 shadow-2xs';

        let examplesHtml = (lvl.examples || []).map(ex => `
            <span class="inline-block px-2 py-0.5 rounded-md bg-stone-100/90 text-stone-700 text-2xs font-arabic font-medium border border-stone-200/50">
                ${escapeHtml(ex)}
            </span>
        `).join('');

        let sublevelsHtml = '';
        if (Array.isArray(lvl.sublevels) && lvl.sublevels.length > 0) {
            const chips = lvl.sublevels.map(sub => {
                const subActive = state.selectedLevel === sub.id;
                const chipCls = subActive
                    ? 'bg-amber-500 text-white border-amber-600 font-bold shadow-2xs'
                    : 'bg-stone-50 hover:bg-amber-50 text-stone-700 border-stone-200 hover:border-amber-300 font-medium';
                return `
                    <button type="button" class="sublevel-chip px-2.5 py-1 rounded-xl border text-2xs transition flex items-center gap-1 cursor-pointer active:scale-95 ${chipCls}" data-sublevel="${escapeHtml(sub.id)}" data-subtitle="${escapeHtml(lvl.name + ' · ' + sub.name)}">
                        <span>${escapeHtml(sub.name)}</span>
                        <span class="font-mono opacity-80">(${sub.total_count})</span>
                    </button>
                `;
            }).join('');
            sublevelsHtml = `
                <div class="pt-1.5 flex flex-wrap items-center gap-1.5">
                    <span class="text-2xs text-stone-400 font-semibold">子级筛选:</span>
                    ${chips}
                </div>
            `;
        }

        let activeTag = isSelected
            ? `<span class="px-2.5 py-1 rounded-full bg-amber-500 text-white text-2xs font-bold shadow-2xs flex items-center gap-1">✓ ${escapeHtml(getLevelDisplayTitle(state.selectedLevel))}</span>`
            : `<button class="btn-select-level px-3 py-1 rounded-xl bg-stone-900 hover:bg-stone-800 text-white text-xs font-semibold transition active:scale-95 shadow-xs" data-level="${escapeHtml(lvl.id)}">选择该等级</button>`;

        card.className = `p-4 rounded-2xl transition duration-200 cursor-pointer flex flex-col gap-2.5 ${borderClass}`;
        card.innerHTML = `
            <div class="flex items-center justify-between gap-2 flex-wrap">
                <div class="flex items-center gap-2">
                    <span class="text-lg">${lvl.icon || '📌'}</span>
                    <span class="font-bold text-sm text-stone-900">${escapeHtml(lvl.title)}</span>
                    ${lvl.cefr ? `<span class="text-2xs px-2 py-0.5 rounded-full font-semibold border ${lvl.tag_bg}">${escapeHtml(lvl.cefr)}</span>` : ''}
                </div>
                ${activeTag}
            </div>

            <!-- Target Audience -->
            <div class="text-2xs text-stone-600 flex items-start gap-1">
                <span class="font-bold text-stone-800 shrink-0">适用人群:</span>
                <span>${escapeHtml(lvl.target)}</span>
            </div>

            <!-- Features -->
            <div class="text-2xs text-stone-500 leading-relaxed">
                <span class="font-bold text-stone-700">词汇特征:</span>
                <span>${escapeHtml(lvl.description)}</span>
            </div>

            ${sublevelsHtml}

            <!-- Examples -->
            <div class="flex flex-wrap items-center gap-1 pt-1">
                <span class="text-2xs text-stone-400 font-medium">示例:</span>
                ${examplesHtml}
            </div>

            <!-- Stats & Progress -->
            <div class="pt-2 border-t border-stone-100 flex items-center justify-between text-2xs text-stone-500">
                <span>待学: <strong class="text-amber-600 font-mono">${lvl.unlearned_count}</strong> / 总计 ${lvl.total_count} 词</span>
                <span>已熟记: <strong class="text-emerald-600 font-mono">${lvl.mastered_count}</strong> 词 (${lvl.progress_percent ?? lvl.progress_pct ?? 0}%)</span>
            </div>
            <div class="w-full bg-stone-100 rounded-full h-1.5 overflow-hidden">
                <div class="bg-emerald-500 h-1.5 rounded-full transition-all duration-300" style="width: ${lvl.progress_percent ?? lvl.progress_pct ?? 0}%;"></div>
            </div>
        `;

        card.querySelectorAll('.sublevel-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                e.stopPropagation();
                const subId = chip.getAttribute('data-sublevel');
                const subTitle = chip.getAttribute('data-subtitle');
                if (subId) selectLevel(subId, subTitle || '');
            });
        });

        // Click on card to select level
        card.addEventListener('click', () => {
            selectLevel(lvl.id, lvl.title);
        });

        elements.levelCardsContainer.appendChild(card);
    });
}

function selectLevel(levelId, levelTitle = '') {
    state.selectedLevel = levelId;
    persistUserPreferencesPatch({ selected_level: levelId });

    const title = getLevelDisplayTitle(levelId) || levelTitle || '📚 全库 · 综合';
    if (elements.activeLevelDisplayBadge) {
        elements.activeLevelDisplayBadge.textContent = title;
    }
    if (elements.libraryDifficultyFilter) {
        elements.libraryDifficultyFilter.value = levelId;
    }

    closeLevelModal();
    loadDashboardData();
    showToast(`已切换至「${title}」学习范围 🎯`);
}

// ---------------- Dashboard & Navigation ----------------

async function loadDashboardData() {
    try {
        let url = `/api/dashboard`;
        if (state.selectedLevel && state.selectedLevel !== 'all') {
            url += `?level=${encodeURIComponent(state.selectedLevel)}`;
        }
        const response = await authFetch(url);
        const data = await response.json();
        state.dashboardData = data;

        // Display user-configured daily goal on Learn card
        if (elements.learnCountBadge) elements.learnCountBadge.textContent = state.dailyGoal;
        if (elements.dailyGoalDisplayBadge) elements.dailyGoalDisplayBadge.textContent = `${state.dailyGoal} 词/日`;
        
        // Active level badge
        const levelText = getLevelDisplayTitle(state.selectedLevel);
        if (elements.activeLevelDisplayBadge) {
            elements.activeLevelDisplayBadge.textContent = levelText;
        }

        if (elements.learnTotalRemainingText) {
            const cleanPrefix = levelText.replace(/^[^\u4e00-\u9fa5A-Za-z0-9]+/, '').split(' · ')[0] || '当前范围';
            elements.learnTotalRemainingText.textContent = `${cleanPrefix}可学 ${data.learn_count} 词 / 共 ${data.level_total_words || data.total_words} 词`;
        }
        
        elements.reviewCountBadge.textContent = state.reviewGoal;
        const totalLearned = (data.mastered_count || 0) + (data.total_reviewing || 0);
        if (elements.reviewTotalLearnedText) {
            elements.reviewTotalLearnedText.textContent = totalLearned > 0 ? `从已学 ${totalLearned} 词中抽选` : '从已学词库中抽选';
        }
        if (elements.reviewLearnedCountNotice) {
            elements.reviewLearnedCountNotice.textContent = `已累计学习 ${totalLearned} 个单词`;
        }

        elements.checkinDateText.textContent = data.date_display;
        
        if (data.today_checked) {
            elements.checkinTitle.textContent = '已签到';
            elements.checkinWidget.classList.add('bg-emerald-50/80', 'border-emerald-200');
        } else {
            elements.checkinTitle.textContent = '签到';
            elements.checkinWidget.classList.remove('bg-emerald-50/80', 'border-emerald-200');
        }

        if (data.streak_days > 0) {
            elements.streakBadge.classList.remove('hidden');
            elements.streakCountText.textContent = data.streak_days;
        } else {
            elements.streakBadge.classList.add('hidden');
        }

        if (elements.libraryStatsTotal) {
            elements.libraryStatsTotal.textContent = `已熟记/掌握 ${data.mastered_count} · 学习中 ${data.total_reviewing} · 总词库 ${data.total_words}`;
        }
        
        updateDailyGoalUI();
        updateReviewGoalUI();
    } catch (err) {
        console.error('Error loading dashboard data:', err);
    }
}

async function handleCheckin() {
    try {
        elements.checkinWidget.classList.add('checkin-animated');
        const response = await authFetch('/api/checkin', { method: 'POST' });
        const res = await response.json();
        showToast(res.message);
        setTimeout(() => elements.checkinWidget.classList.remove('checkin-animated'), 500);
        await loadDashboardData();
    } catch (err) {
        showToast('签到失败，请稍后重试');
    }
}

function showDashboard() {
    state.currentView = 'dashboard';
    elements.dashboardView.classList.remove('hidden');
    elements.flashcardView.classList.add('hidden');
    loadDashboardData();
}

function showFlashcardView() {
    state.currentView = 'flashcard';
    elements.dashboardView.classList.add('hidden');
    elements.flashcardView.classList.remove('hidden');
}

// 严格按照 01 两段自测 -> 02 看阿选汉 -> 03 看汉选阿 -> 04 阿语拼写 阶梯式逻辑进阶
const STRICT_MODES_ORDER = ['flashcard', 'ar_to_zh', 'zh_to_ar', 'spelling'];

function buildInterleavedSessionDeck(wordList) {
    const interleavedDeck = [];
    
    // 构造 4 轮考核，每轮都将整组词汇进行独立随机洗牌 (Fisher-Yates)
    // 第 1 轮：全组随机顺序，考核 01 两段自测 (streak 0)
    // 第 2 轮：全组重新随机，考核 02 看阿选汉 (streak 1)
    // 第 3 轮：全组重新随机，考核 03 看汉选阿 (streak 2)
    // 第 4 轮：全组重新随机，考核 04 阿语拼写 (streak 3)
    for (let round = 0; round < 4; round++) {
        const roundWords = shuffleArray([...wordList]);
        roundWords.forEach(w => {
            interleavedDeck.push({
                wordId: w.id,
                word: w
            });
        });
    }

    // 相邻防碰撞算法：确保跨轮衔接处不会连续两次出现同一个单词
    for (let i = 1; i < interleavedDeck.length; i++) {
        if (interleavedDeck[i].wordId === interleavedDeck[i - 1].wordId) {
            for (let j = i + 1; j < interleavedDeck.length; j++) {
                if (interleavedDeck[j].wordId !== interleavedDeck[i - 1].wordId &&
                    (j + 1 >= interleavedDeck.length || interleavedDeck[j].wordId !== interleavedDeck[j + 1].wordId)) {
                    const temp = interleavedDeck[i];
                    interleavedDeck[i] = interleavedDeck[j];
                    interleavedDeck[j] = temp;
                    break;
                }
            }
        }
    }

    console.log('✨ [Strict Deck Generated] Total Tasks:', interleavedDeck.length);
    return interleavedDeck;
}

// ---------------- 4-Streak Session Initialization ----------------

async function startSession(mode = 'learn') {
    state.sessionMode = mode;
    const limit = mode === 'learn' ? state.dailyGoal : (state.reviewGoal || 20);
    let url = `/api/session/${mode}?limit=${limit}`;
    if (mode === 'learn' && state.selectedLevel && state.selectedLevel !== 'all') {
        url += `&level=${encodeURIComponent(state.selectedLevel)}`;
    }

    try {
        const response = await authFetch(url);
        const data = await response.json();

        if (!data.words || data.words.length === 0) {
            if (mode === 'learn') {
                showToast('恭喜！所有新词都已学完，去【Review】复习吧 👏');
            } else {
                showToast(data.message || '暂无到期待复习的单词，太棒了！👏');
            }
            return;
        }

        // Initialize Word Tracker
        state.wordTracker = {};
        data.words.forEach(w => {
            state.wordTracker[w.id] = {
                word: w,
                streak: 0, // must reach 4
                mistakes: 0,
                completed: false
            };
        });

        // Build fully interleaved and randomized task deck
        state.deck = buildInterleavedSessionDeck(data.words);

        state.sessionStats = {
            totalWords: data.words.length,
            completedCount: 0,
            totalAttempts: 0,
            mistakesCount: 0,
            startTime: Date.now(),
        };

        showFlashcardView();
        pullNextChallenge();
    } catch (err) {
        console.error('Error starting session:', err);
        showToast('获取词库数据失败，请重试');
    }
}

// Pull next challenge from interleaved deck
function pullNextChallenge() {
    // 1. Check if all words have graduated
    const uncompletedWords = Object.values(state.wordTracker).filter(w => !w.completed);
    if (uncompletedWords.length === 0) {
        showSessionCompleteModal();
        return;
    }

    // 2. Filter out tasks for words that are already completed/mastered
    state.deck = state.deck.filter(t => !state.wordTracker[t.wordId].completed);

    // 3. If deck is exhausted due to wrong answer streak resets, generate remaining tasks
    if (state.deck.length === 0) {
        const shuffledRemaining = shuffleArray(uncompletedWords);
        shuffledRemaining.forEach(wState => {
            state.deck.push({
                wordId: wState.word.id,
                word: wState.word
            });
        });
    }

    // 4. Pop the next task
    state.currentTask = state.deck.shift();
    state.currentWord = state.currentTask.word;
    
    // 严格根据该词当前连对进度，匹配 01 -> 02 -> 03 -> 04 考核模式
    const currentStreak = state.wordTracker[state.currentWord.id].streak;
    const modeIndex = Math.min(3, Math.max(0, currentStreak));
    state.currentChallengeMode = STRICT_MODES_ORDER[modeIndex];
    state.step = 1;

    renderChallenge();
}

// ---------------- Challenge Rendering ----------------

function renderChallenge() {
    const word = state.currentWord;
    if (!word) return;
    const wState = state.wordTracker[word.id];
    if (!wState) return;

    hideWordPeek();

    // 1. Update Progress Header
    const completed = state.sessionStats.completedCount;
    const total = state.sessionStats.totalWords;
    const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
    
    elements.sessionProgressLabel.textContent = `已掌握: ${completed} / ${total} 词`;
    elements.sessionProgressBar.style.width = `${percent}%`;

    // 2. Render 4-Streak Dots
    renderStreakDots(wState.streak);
    elements.cardCategoryText.textContent = `${MODE_NAMES[state.currentChallengeMode]} · 连对 ${wState.streak}/4`;

    // 3. Hide all mode containers
    elements.flashcardModeContainer.classList.add('hidden');
    elements.arToZhModeContainer.classList.add('hidden');
    elements.zhToArModeContainer.classList.add('hidden');
    elements.spellingModeContainer.classList.add('hidden');

    // 4. Fill Common Details Section (Step 2)
    fillDetailsSection(word);

    // 5. Hide Details Section during Step 1
    elements.detailsSection.classList.remove('slide-down-show');
    elements.detailsSection.classList.add('slide-down-enter');
    elements.step2ActionBar.classList.add('hidden');

    // 6. Render the specific random challenge mode
    if (state.currentChallengeMode === 'flashcard') {
        renderModeFlashcard(word, wState.streak);
    } else if (state.currentChallengeMode === 'ar_to_zh') {
        renderModeArToZh(word, wState.streak);
    } else if (state.currentChallengeMode === 'zh_to_ar') {
        renderModeZhToAr(word, wState.streak);
    } else if (state.currentChallengeMode === 'spelling') {
        renderModeSpelling(word, wState.streak);
    }
}

function renderStreakDots(streak) {
    elements.streakDotsContainer.innerHTML = '';
    for (let i = 0; i < 4; i++) {
        const dot = document.createElement('span');
        if (i < streak) {
            dot.className = 'text-emerald-500 font-bold';
            dot.textContent = '●';
        } else {
            dot.className = 'text-stone-300 font-normal';
            dot.textContent = '○';
        }
        elements.streakDotsContainer.appendChild(dot);
    }
}

let nounFamilyRequestToken = 0;

function hideNounLexicon(isModal = false) {
    const section = isModal ? elements.modalNounLexiconSection : elements.nounLexiconSection;
    if (section) section.classList.add('hidden');
}

function renderDerivativeItems(items, list, currentId) {
    if (!list) return;
    list.innerHTML = '';
    const seen = new Set();
    const derivatives = (Array.isArray(items) ? items : [])
        .filter(item => item && item.id !== currentId)
        // The noun card intentionally never surfaces a same-root verb
        // prototype; verb learning remains in the dedicated verb card.
        .filter(item => !(item.pos || '').includes('动词'))
        .filter(item => {
            const key = stripTashkeel(item.text_unvocalized || item.text_vocalized || '').trim();
            if (!key || seen.has(key)) return false;
            seen.add(key);
            return true;
        })
        .slice(0, 8);
    derivatives.forEach(item => {
        const card = document.createElement('div');
        card.setAttribute('role', 'button');
        card.tabIndex = 0;
        card.className = 'w-full min-w-0 text-left p-2.5 rounded-xl bg-white/80 border border-stone-200/80 hover:border-amber-300 hover:bg-amber-50/70 transition active:scale-[.98] flex flex-col gap-1 cursor-pointer';
        const pos = item.pos || '词条';
        const meaning = item.meaning_zh || '暂无释义';
        const displayWord = item.text_vocalized || item.text_unvocalized;
        card.innerHTML = `<div class="flex items-center justify-between gap-2"><span class="flex-1 min-w-0 font-arabic text-base font-bold text-stone-900 truncate leading-tight text-right" dir="rtl">${escapeHtml(displayWord)}</span><button type="button" class="derivative-audio shrink-0 p-1 rounded-lg text-amber-700 hover:bg-amber-100" aria-label="朗读 ${escapeHtml(displayWord)}">🔊</button></div><div class="flex items-center gap-1.5 min-w-0"><span class="text-3xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 whitespace-nowrap shrink-0">${escapeHtml(pos)}</span><span class="text-2xs text-stone-500 truncate">${escapeHtml(meaning)}</span></div>`;
        card.addEventListener('click', (event) => {
            event.stopPropagation();
            if (event.target.closest('.derivative-audio')) {
                speakArabic(displayWord);
                showToast(`派生词发音：${displayWord}`);
                return;
            }
            openWordDetailModal(item);
        });
        card.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' || event.key === ' ') {
                event.preventDefault();
                openWordDetailModal(item);
            }
        });
        list.appendChild(card);
    });
    if (!derivatives.length) {
        const empty = document.createElement('div');
        empty.className = 'text-2xs text-stone-400 py-1';
        empty.textContent = '暂无可靠的同根派生词';
        list.appendChild(empty);
    }
}

async function renderNounLexiconSection(word, isModal = false) {
    const token = ++nounFamilyRequestToken;
    const section = isModal ? elements.modalNounLexiconSection : elements.nounLexiconSection;
    const rootText = isModal ? elements.modalNounRootText : elements.nounRootText;
    const list = isModal ? elements.modalNounDerivativesList : elements.nounDerivativesList;
    const isVerb = word && word.pos && word.pos.includes('动词');
    if (!section || !word || isVerb || !word.root || !String(word.root).trim()) {
        hideNounLexicon(isModal);
        return;
    }
    section.classList.remove('hidden');
    if (rootText) rootText.textContent = String(word.root).replace(/-/g, ' · ');
    if (list) list.innerHTML = '<div class="text-2xs text-stone-400 py-1">正在加载同根词…</div>';
    try {
        const response = await authFetch(`/api/root/${encodeURIComponent(word.root)}`);
        if (!response.ok) throw new Error(`root request ${response.status}`);
        const data = await response.json();
        if (token !== nounFamilyRequestToken) return;
        renderDerivativeItems(data.words, list, word.id);
    } catch (error) {
        if (token !== nounFamilyRequestToken) return;
        if (list) list.innerHTML = '<div class="text-2xs text-stone-400 py-1">暂时无法载入同根派生词</div>';
    }
}

function fillDetailsSection(word) {
    const isVerb = word.pos && word.pos.includes('动词');

    elements.posTag.textContent = word.pos || '常用核心词汇';
    const parentFlex = elements.posTag.parentElement;
    if (parentFlex) {
        parentFlex.querySelectorAll('.syllabus-dynamic-badge').forEach(el => el.remove());
        const temp = document.createElement('div');
        temp.innerHTML = getSyllabusBadgesHtml(word);
        Array.from(temp.children).forEach(child => {
            child.classList.add('syllabus-dynamic-badge');
            parentFlex.appendChild(child);
        });
    }
    elements.meaningZhText.textContent = word.meaning_zh;

    if (isVerb) {
        // ================= VERB PRESENTATION =================
        if (elements.pluralBox) elements.pluralBox.classList.add('hidden');
        hideNounLexicon(false);

        // Verb Preposition Collocations
        if (word.collocation && word.collocation.trim()) {
            elements.collocationBox.classList.remove('hidden');
            elements.collocationText.textContent = word.collocation;
            elements.collocationBox.onclick = (e) => {
                e.stopPropagation();
                const arPart = word.collocation.split('(')[0].trim();
                speakArabic(arPart);
                showToast(`搭配发音：${arPart}`);
            };
        } else {
            elements.collocationBox.classList.add('hidden');
        }

        renderVerbTensesSection(word, false);
    } else {
        // ================= NOUN PRESENTATION =================
        // Preposition collocations and verb tenses MUST BE HIDDEN for nouns!
        if (elements.collocationBox) elements.collocationBox.classList.add('hidden');
        if (elements.verbTensesSection) elements.verbTensesSection.classList.add('hidden');

        // Noun Plural
        if (word.plural && word.plural.trim() && word.plural.trim() !== 'ـ' && word.plural.trim() !== '-') {
            elements.pluralBox.classList.remove('hidden');
            elements.pluralText.textContent = word.plural;
        } else {
            elements.pluralBox.classList.add('hidden');
        }

        renderNounLexiconSection(word, false);
    }

    // Contextual example: the simple beginner phrase becomes primary when present.
    const examplePending = word.example_status === 'pending_review';
    const primaryExample = getPrimaryExample(word);
    const hasPrimaryExample = !examplePending && Boolean(primaryExample.ar);

    if (elements.detailExampleLabel) {
        elements.detailExampleLabel.textContent = (hasPrimaryExample && primaryExample.isSimple) ? '简单例句' : '语境例句与翻译';
    }
    if (elements.detailExampleArText) {
        elements.detailExampleArText.innerHTML = examplePending
            ? '例句待语言学复核，暂不展示。'
            : renderArabicExampleSentence(primaryExample.ar || '', word, false, primaryExample.highlight);
    }
    if (elements.detailExampleZhText) {
        elements.detailExampleZhText.textContent = examplePending ? '该词不会进入学习或复习抽题。' : (primaryExample.zh || '');
    }

    if (elements.exampleZhText) {
        elements.exampleZhText.textContent = examplePending ? '例句待语言学复核，暂不展示。' : (primaryExample.zh || '');
    }

    const showOriginalExample = hasPrimaryExample && primaryExample.isSimple && Boolean(primaryExample.originalAr);
    if (elements.detailOriginalExample) {
        elements.detailOriginalExample.classList.toggle('hidden', !showOriginalExample);
        elements.detailOriginalExample.open = false;
        if (showOriginalExample) {
            elements.detailOriginalExampleAr.innerHTML = renderArabicExampleSentence(
                primaryExample.originalAr,
                word,
                false,
                primaryExample.originalHighlight
            );
            elements.detailOriginalExampleZh.textContent = primaryExample.originalZh || '';
        }
    }

    renderSynonymsAndAntonyms(word, false);
}

// ---------------- Mode 1: Two-step Flashcard ----------------

function renderModeFlashcard(word, streak) {
    if (elements.quizModeBadge) elements.quizModeBadge.classList.add('hidden');
    elements.flashcardModeContainer.classList.remove('hidden');
    elements.step1ActionBar.classList.remove('hidden');
    if (elements.contextSentenceBox) elements.contextSentenceBox.classList.remove('hidden');

    const displayText = state.isTashkeelEnabled ? word.text_vocalized : word.text_unvocalized;
    elements.headwordArabic.textContent = displayText;

    const primaryExample = getPrimaryExample(word);
    elements.exampleArText.innerHTML = renderArabicExampleSentence(
        primaryExample.ar || '',
        word,
        false,
        primaryExample.highlight
    );

    if (elements.contextExampleLabel) {
        elements.contextExampleLabel.textContent = primaryExample.isSimple ? '简单例句' : '语境例句';
    }
    const canShowSimpleZh = primaryExample.isSimple && Boolean(primaryExample.zh);
    if (elements.btnToggleSimpleZh) {
        elements.btnToggleSimpleZh.classList.toggle('hidden', !canShowSimpleZh);
        elements.btnToggleSimpleZh.textContent = '看中文';
    }
    if (elements.exampleSimpleZhText) {
        elements.exampleSimpleZhText.textContent = primaryExample.zh || '';
        elements.exampleSimpleZhText.classList.add('hidden');
    }
}

// ---------------- Mode 2: Arabic to Chinese Choice ----------------

function renderModeArToZh(word, streak) {
    if (elements.quizModeBadge) elements.quizModeBadge.classList.add('hidden');
    elements.arToZhModeContainer.classList.remove('hidden');
    elements.step1ActionBar.classList.add('hidden');

    elements.arToZhHeadword.textContent = state.isTashkeelEnabled ? word.text_vocalized : word.text_unvocalized;

    elements.arToZhOptionsList.innerHTML = '';
    const choices = word.zh_choices || [{ id: word.id, text: word.meaning_zh, is_correct: true }];

    choices.forEach((choice, idx) => {
        const btn = document.createElement('button');
        btn.className = 'w-full py-3.5 px-4 rounded-2xl bg-stone-50 hover:bg-amber-50 border border-stone-200/80 text-left text-sm font-medium text-stone-800 transition active:scale-98 flex items-center justify-between shadow-2xs group cursor-pointer';
        btn.innerHTML = `
            <div class="flex items-center gap-3">
                <span class="w-6 h-6 rounded-lg bg-stone-200/80 text-stone-600 text-xs font-mono font-bold flex items-center justify-center group-hover:bg-amber-200 group-hover:text-amber-900">${idx + 1}</span>
                <span>${escapeHtml(choice.text)}</span>
            </div>
        `;

        btn.addEventListener('click', () => handleChoiceAnswer(choice.is_correct, btn, elements.arToZhOptionsList));
        elements.arToZhOptionsList.appendChild(btn);
    });
}

// ---------------- Mode 3: Chinese to Arabic Choice ----------------

function renderModeZhToAr(word, streak) {
    if (elements.quizModeBadge) elements.quizModeBadge.classList.add('hidden');
    elements.zhToArModeContainer.classList.remove('hidden');
    elements.step1ActionBar.classList.add('hidden');

    if (elements.zhToArPosTag) elements.zhToArPosTag.textContent = word.pos || '';
    elements.zhToArMeaningText.textContent = word.meaning_zh;

    elements.zhToArOptionsList.innerHTML = '';
    const choices = word.ar_choices || [{ id: word.id, text: word.text_vocalized, is_correct: true }];

    choices.forEach((choice, idx) => {
        const btn = document.createElement('button');
        btn.className = 'w-full py-4 px-3 rounded-2xl bg-stone-50 hover:bg-blue-50 border border-stone-200/80 text-center transition active:scale-98 flex flex-col items-center justify-center shadow-2xs group cursor-pointer relative';
        btn.innerHTML = `
            <span class="w-5 h-5 rounded-md bg-stone-200/70 text-stone-600 text-2xs font-mono font-bold flex items-center justify-center absolute top-2.5 left-2.5">${idx + 1}</span>
            <span class="text-2xl font-serif text-stone-900 font-arabic my-1">${escapeHtml(choice.text)}</span>
        `;

        btn.addEventListener('click', () => handleChoiceAnswer(choice.is_correct, btn, elements.zhToArOptionsList));
        elements.zhToArOptionsList.appendChild(btn);
    });
}

// Full Arabic Alphabet (28 standard letters + special forms & Hamza variants)
const FULL_ARABIC_ALPHABET_ROWS = [
    ['ض', 'ص', 'ث', 'ق', 'ف', 'غ', 'ع', 'ه', 'خ', 'ح', 'ج', 'د', 'ذ'],
    ['ش', 'س', 'ي', 'ب', 'ل', 'ا', 'ت', 'ن', 'م', 'ك', 'ط', 'ظ'],
    ['أ', 'إ', 'آ', 'ء', 'ئ', 'ؤ', 'ر', 'ز', 'و', 'ة', 'ى'],
];

function renderModeSpelling(word, streak) {
    if (elements.quizModeBadge) elements.quizModeBadge.classList.add('hidden');
    elements.spellingModeContainer.classList.remove('hidden');
    elements.step1ActionBar.classList.add('hidden');

    if (elements.spellingPosTag) elements.spellingPosTag.textContent = word.pos || '';
    elements.spellingMeaningText.textContent = word.meaning_zh;
    
    const primaryExample = getPrimaryExample(word);
    if (primaryExample.ar && word.example_status !== 'pending_review') {
        elements.spellingSentenceText.innerHTML = renderArabicExampleSentence(
            primaryExample.ar,
            word,
            true,
            primaryExample.highlight
        );
    } else {
        elements.spellingSentenceText.textContent = '本词暂无例句，请根据释义拼写';
    }

    elements.spellingInput.value = '';
    elements.spellingInput.classList.remove(
        'bg-emerald-50', 'border-emerald-500', 'text-emerald-900',
        'bg-rose-50', 'border-rose-500', 'text-rose-900', 'shake-wrong'
    );
    if (elements.spellingDiffHint) {
        elements.spellingDiffHint.classList.add('hidden');
        elements.spellingDiffHint.innerHTML = '';
    }

    // Render Full Arabic Alphabet Keyboard (All 28+ letters)
    elements.letterTilesBank.innerHTML = '';
    FULL_ARABIC_ALPHABET_ROWS.forEach(rowLetters => {
        const rowEl = document.createElement('div');
        rowEl.className = 'letter-row';

        rowLetters.forEach(letter => {
            const tile = document.createElement('button');
            tile.className = 'letter-tile';
            if (['أ', 'إ', 'آ', 'ء', 'ئ', 'ؤ', 'ة', 'ى'].includes(letter)) {
                tile.classList.add('letter-tile-special');
            }
            tile.textContent = letter;
            tile.title = `输入 ${letter}`;
            tile.addEventListener('click', () => {
                elements.spellingInput.value += letter;
                speakArabic(letter);
            });
            rowEl.appendChild(tile);
        });

        elements.letterTilesBank.appendChild(rowEl);
    });
}

// ---------------- Answer Processing & 4-Streak Scheduling ----------------

function handleChoiceAnswer(isCorrect, clickedBtn, optionsContainer) {
    const btns = optionsContainer.querySelectorAll('button');
    btns.forEach(b => b.disabled = true);

    if (isCorrect) {
        clickedBtn.classList.remove('bg-stone-50', 'hover:bg-amber-50', 'hover:bg-blue-50');
        clickedBtn.classList.add('bg-emerald-100', 'border-emerald-400', 'text-emerald-900', 'success-pop');
        onAnswerCorrect();
    } else {
        clickedBtn.classList.remove('bg-stone-50');
        clickedBtn.classList.add('bg-rose-100', 'border-rose-400', 'text-rose-900', 'shake-wrong');
        onAnswerWrong();
    }
}

function handleSpellingSubmit() {
    if (!state.currentWord) return;
    const typed = elements.spellingInput.value.trim();
    const typedClean = stripTashkeel(typed).trim();
    const targetUnvocalized = (state.currentWord.text_unvocalized || '').trim();
    const targetVocalized = (state.currentWord.text_vocalized || '').trim();

    if (typed === targetUnvocalized || typed === targetVocalized || (typedClean && typedClean === targetUnvocalized)) {
        elements.spellingInput.classList.add('bg-emerald-50', 'border-emerald-500', 'text-emerald-900');
        if (elements.spellingDiffHint) elements.spellingDiffHint.classList.add('hidden');
        onAnswerCorrect();
    } else {
        elements.spellingInput.classList.add('bg-rose-50', 'border-rose-500', 'text-rose-900', 'shake-wrong');
        setTimeout(() => elements.spellingInput.classList.remove('shake-wrong'), 400);
        if (elements.spellingDiffHint) {
            const targetChars = Array.from(targetUnvocalized);
            const typedChars = Array.from(typedClean || typed);
            const diffSpans = targetChars.map((ch, idx) => {
                const match = typedChars[idx] === ch;
                const cls = match ? 'text-emerald-700 font-bold' : 'text-rose-600 underline decoration-2 font-bold';
                return `<span class="${cls}">${escapeHtml(ch)}</span>`;
            }).join('');
            elements.spellingDiffHint.innerHTML = `
                <span class="text-stone-500 font-sans">标准拼写对照：</span>
                <span class="font-arabic text-base tracking-wider" dir="rtl">${diffSpans} <span class="text-stone-500 text-xs">(${escapeHtml(targetVocalized)})</span></span>
            `;
            elements.spellingDiffHint.classList.remove('hidden');
        }
        onAnswerWrong();
    }
}

function onAnswerCorrect() {
    if (!state.currentWord) return;
    const wState = state.wordTracker[state.currentWord.id];
    state.sessionStats.totalAttempts++;
    wState.streak++;

    if (wState.streak >= 4) {
        wState.completed = true;
        state.sessionStats.completedCount++;
        showToast(`✨ 达成 4 连对！「${wState.word.text_vocalized}」已完全掌握`);
        graduateWord(wState);
        // Remove any future duplicate tasks for this word from the remaining deck
        state.deck = state.deck.filter(t => t.wordId !== wState.word.id);
    } else {
        showToast(`✅ 回答正确！已连对 ${wState.streak}/4 次`);
    }

    revealDetailsAndNext();
}

function onAnswerWrong() {
    if (!state.currentWord) return;
    const wState = state.wordTracker[state.currentWord.id];
    state.sessionStats.totalAttempts++;
    state.sessionStats.mistakesCount++;
    wState.mistakes++;
    // 答错/遗忘时不从头重置，保留当前连对进度，后续轮次继续攻克该阶段 (01..04)
    
    // 确保牌组中包含该词剩余阶段所需的任务数量
    const existingTasksCount = state.deck.filter(t => t.wordId === wState.word.id).length;
    const neededTasks = Math.max(0, (4 - wState.streak) - existingTasksCount);
    if (neededTasks > 0) {
        for (let i = 0; i < neededTasks; i++) {
            const insertPos = state.deck.length <= 1
                ? state.deck.length
                : Math.min(state.deck.length, Math.floor(Math.random() * state.deck.length) + 1);
            state.deck.splice(insertPos, 0, {
                wordId: wState.word.id,
                word: wState.word
            });
        }
    }

    const modeStageNames = ['01 两段自测', '02 看阿选汉', '03 看汉选阿', '04 阿语拼写'];
    const currentStageName = modeStageNames[Math.min(3, wState.streak)] || '当前';
    showToast(`❌ 答错/遗忘，已记录错题，后续轮次将重新挑战【${currentStageName}】`);
    revealDetailsAndNext();
}

async function graduateWord(wState) {
    try {
        await authFetch('/api/session/graduate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                word_id: wState.word.id,
                mistakes: wState.mistakes
            })
        });
    } catch (err) {
        console.error('Error graduating word:', err);
    }
}

function revealDetailsAndNext() {
    state.step = 2;
    if (elements.contextSentenceBox) elements.contextSentenceBox.classList.add('hidden');
    elements.detailsSection.classList.remove('slide-down-enter');
    elements.detailsSection.classList.add('slide-down-show');
    elements.step1ActionBar.classList.add('hidden');
    elements.step2ActionBar.classList.remove('hidden');

    setTimeout(() => {
        elements.meaningZhText.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 150);
}

// ---------------- Synonyms & Antonyms Engine ----------------

function parseRelationEntry(raw) {
    if (!raw) return null;
    if (typeof raw === 'object' && raw.word) {
        const w = String(raw.word).trim();
        const s = raw.sense ? String(raw.sense).trim() : '';
        return /[\u0600-\u06ff]/.test(w) ? { word: w, sense: s } : null;
    }
    if (typeof raw === 'string') {
        const trimmed = raw.trim();
        if (!/[\u0600-\u06ff]/.test(trimmed) || trimmed.includes(':')) return null;
        if (trimmed.includes('|')) {
            const [w, s] = trimmed.split('|', 2);
            return { word: w.trim(), sense: (s || '').trim() };
        }
        return { word: trimmed, sense: '' };
    }
    return null;
}

function getSynonymsAndAntonyms(word) {
    // Use only the audited per-entry fields (up to 2 items per relation kind).
    try {
        const syn = typeof word.synonyms === 'string' ? JSON.parse(word.synonyms) : word.synonyms;
        const ant = typeof word.antonyms === 'string' ? JSON.parse(word.antonyms) : word.antonyms;
        const clean = (items) => (Array.isArray(items) ? items : [])
            .map(parseRelationEntry)
            .filter(Boolean)
            .slice(0, 2);
        const audited = { synonyms: clean(syn), antonyms: clean(ant) };
        if (audited.synonyms.length || audited.antonyms.length) return audited;
    } catch (_) { /* ignore malformed JSON */ }
    return { synonyms: [], antonyms: [] };
}

function renderSynonymsAndAntonyms(word, isModal = false) {
    const section = isModal ? elements.modalSynonymsAntonymsSection : elements.synonymsAntonymsSection;
    const synBox = isModal ? elements.modalSynonymsBox : elements.synonymsBox;
    const synList = isModal ? elements.modalSynonymsList : elements.synonymsList;
    const antBox = isModal ? elements.modalAntonymsBox : elements.antonymsBox;
    const antList = isModal ? elements.modalAntonymsList : elements.antonymsList;

    if (!section || !synList || !antList) return;

    const data = getSynonymsAndAntonyms(word);
    const hasSyn = data.synonyms && data.synonyms.length > 0;
    const hasAnt = data.antonyms && data.antonyms.length > 0;

    if (!hasSyn && !hasAnt) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');

    if (hasSyn) {
        synBox.classList.remove('hidden');
        synList.innerHTML = '';
        data.synonyms.forEach(item => {
            synList.appendChild(createPeekPill(item, 'syn'));
        });
    } else {
        synBox.classList.add('hidden');
    }

    if (hasAnt) {
        antBox.classList.remove('hidden');
        antList.innerHTML = '';
        data.antonyms.forEach(item => {
            antList.appendChild(createPeekPill(item, 'ant'));
        });
    } else {
        antBox.classList.add('hidden');
    }
}

function createPeekPill(item, kind) {
    const isSyn = kind === 'syn';
    const entry = typeof item === 'object' && item ? item : (parseRelationEntry(item) || { word: String(item || ''), sense: '' });
    const token = entry.word;
    const sense = entry.sense || '';

    const wrap = document.createElement('div');
    wrap.className = `flex items-center overflow-hidden rounded-xl bg-white border shadow-2xs ${isSyn ? 'border-amber-300/80' : 'border-stone-300/80'}`;

    const wordBtn = document.createElement('button');
    wordBtn.type = 'button';
    wordBtn.className = `word-peek-trigger px-2.5 py-1 text-xs text-stone-900 transition cursor-pointer active:scale-95 flex items-center gap-1 ${isSyn ? 'hover:bg-amber-100/60' : 'hover:bg-stone-100'}`;
    const wordSpan = document.createElement('span');
    wordSpan.textContent = token;
    wordBtn.appendChild(wordSpan);
    if (sense) {
        const senseSpan = document.createElement('span');
        senseSpan.className = 'text-2xs text-stone-500 font-sans';
        senseSpan.textContent = `· ${sense}`;
        wordBtn.appendChild(senseSpan);
    }
    wordBtn.title = sense ? `查看释义（${sense}）` : '查看释义';
    wordBtn.setAttribute('aria-label', `查看释义：${token}`);
    wordBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        openWordPeek(token, wordBtn, sense);
    });

    const audioBtn = document.createElement('button');
    audioBtn.type = 'button';
    audioBtn.className = `peek-audio px-1.5 py-1 border-l transition cursor-pointer ${isSyn ? 'border-amber-200/80 text-amber-600 hover:bg-amber-100/60' : 'border-stone-200/80 text-stone-500 hover:bg-stone-100'}`;
    audioBtn.title = '发音';
    audioBtn.setAttribute('aria-label', `发音：${token}`);
    audioBtn.innerHTML = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path></svg>`;
    audioBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        speakArabic(token, audioBtn);
    });

    wrap.append(wordBtn, audioBtn);
    return wrap;
}

// ---------------- Synonym / antonym meaning popover ----------------

function hideWordPeek() {
    peekRequestId++;
    peekTrigger = null;
    if (!elements.wordPeekPopover) return;
    elements.wordPeekPopover.classList.add('hidden');
    if (elements.wordPeekResults) elements.wordPeekResults.innerHTML = '';
    if (elements.wordPeekLoading) elements.wordPeekLoading.classList.add('hidden');
    if (elements.wordPeekEmpty) elements.wordPeekEmpty.classList.add('hidden');
    if (elements.wordPeekError) elements.wordPeekError.classList.add('hidden');
}

function positionWordPeek(trigger) {
    if (!elements.wordPeekPopover || elements.wordPeekPopover.classList.contains('hidden')) return;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const pop = elements.wordPeekPopover;
    const pw = pop.offsetWidth || 320;
    const ph = pop.offsetHeight || 180;
    let left = rect.left + rect.width / 2 - pw / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - pw - 12));
    let top = rect.bottom + 8;
    if (top + ph > window.innerHeight - 12) {
        top = Math.max(12, rect.top - ph - 8);
    }
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
}

function openWordPeek(item, trigger, senseHint = '') {
    if (!elements.wordPeekPopover) return;
    const token = (item || '').trim();
    if (!token) return;

    const requestId = ++peekRequestId;
    peekTrigger = trigger;
    elements.wordPeekQuery.textContent = token;
    elements.wordPeekQuery.dir = 'rtl';
    elements.wordPeekResults.innerHTML = '';
    elements.wordPeekEmpty.classList.add('hidden');
    elements.wordPeekError.classList.add('hidden');
    elements.wordPeekLoading.classList.remove('hidden');
    elements.wordPeekPopover.classList.remove('hidden');
    positionWordPeek(trigger);

    const q = stripArabicTashkeel(token).trim();
    if (!q) {
        elements.wordPeekLoading.classList.add('hidden');
        elements.wordPeekEmpty.classList.remove('hidden');
        positionWordPeek(trigger);
        return;
    }

    const senseParam = senseHint ? `&sense=${encodeURIComponent(senseHint)}` : '';
    authFetch(`/api/words/lookup?q=${encodeURIComponent(q)}${senseParam}`)
        .then((res) => {
            if (!res.ok) throw new Error(`lookup ${res.status}`);
            return res.json();
        })
        .then((data) => {
            if (requestId !== peekRequestId) return;
            elements.wordPeekLoading.classList.add('hidden');
            const matches = Array.isArray(data.matches) ? data.matches.slice(0, 3) : [];
            if (!matches.length) {
                elements.wordPeekEmpty.classList.remove('hidden');
                positionWordPeek(trigger);
                return;
            }
            renderWordPeekMatches(matches, token);
            positionWordPeek(trigger);
        })
        .catch(() => {
            if (requestId !== peekRequestId) return;
            elements.wordPeekLoading.classList.add('hidden');
            elements.wordPeekError.classList.remove('hidden');
            positionWordPeek(trigger);
        });
}

function renderWordPeekMatches(matches, token) {
    if (!elements.wordPeekResults) return;
    elements.wordPeekResults.innerHTML = '';
    const speaker = `<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path></svg>`;

    matches.forEach((match) => {
        const row = document.createElement('div');
        row.className = 'flex items-start gap-2 p-2 rounded-xl border border-stone-100 bg-white/70 hover:border-amber-200 transition';

        const canOpen = Boolean(match.can_open_detail);
        const content = document.createElement(canOpen ? 'button' : 'div');
        if (canOpen) {
            content.type = 'button';
            content.className = 'word-peek-open flex-1 min-w-0 text-left cursor-pointer';
            content.addEventListener('click', () => openPeekMatchDetail(match));
        } else {
            content.className = 'flex-1 min-w-0 text-left';
        }

        const sourceBadge = match.source === 'supplement'
            ? '<span class="text-xs px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">词典补充</span>'
            : '';
        const sourceLink = match.source === 'supplement' && match.source_url
            ? `<a href="${escapeHtml(match.source_url)}" target="_blank" rel="noopener noreferrer" class="text-xs text-amber-700 underline mt-1 inline-block">${escapeHtml(match.source_name || '词典来源')}</a>`
            : '';
        const detailHint = canOpen
            ? '<span class="text-xs text-stone-400 shrink-0">详情 ›</span>'
            : '';
        content.innerHTML = `
            <div class="flex items-center gap-1.5 flex-wrap">
                <span class="font-arabic text-base font-bold text-stone-900 leading-relaxed" dir="rtl">${escapeHtml(match.text_vocalized || '')}</span>
                ${match.pos ? `<span class="text-xs px-1.5 py-0.5 rounded bg-stone-100 text-stone-500">${escapeHtml(match.pos)}</span>` : ''}
                ${sourceBadge}
                ${detailHint}
            </div>
            <p class="text-sm text-stone-700 leading-relaxed mt-1">${escapeHtml(match.meaning_zh || '')}</p>
            ${sourceLink}
        `;

        const audio = document.createElement('button');
        audio.type = 'button';
        audio.className = 'p-1.5 rounded-lg text-amber-600 hover:bg-amber-50 transition cursor-pointer shrink-0';
        audio.title = '发音';
        audio.setAttribute('aria-label', `发音：${match.text_vocalized || token}`);
        audio.innerHTML = speaker;
        audio.addEventListener('click', (e) => {
            e.stopPropagation();
            speakArabic(match.text_vocalized || token, audio);
        });

        row.append(content, audio);
        elements.wordPeekResults.appendChild(row);
    });
}

async function openPeekMatchDetail(match) {
    if (!match || !match.id) return;
    const modalOpen = Boolean(elements.wordDetailModal && !elements.wordDetailModal.classList.contains('hidden'));
    try {
        const res = await authFetch(`/api/word/${match.id}`);
        if (!res.ok) throw new Error(`word ${res.status}`);
        const word = await res.json();
        hideWordPeek();
        openWordDetailModal(word, { pushBack: modalOpen });
    } catch (err) {
        showToast('获取词条详情失败');
    }
}

// ---------------- Classical Arabic Verb Conjugation Engine ----------------

function isVerbWord(word) {
    if (!word) return false;
    const pos = word.pos || '';
    // Wazn labels are also used for deverbal nouns and participles.  The
    // audited POS is the single source of truth for deciding whether a verb
    // conjugation panel should be shown.
    return pos.includes('动词');
}

function conjugateArabicVerb(vocalizedVerb, pos = '', root = '', wazn = '') {
    const unvoc = stripTashkeel(vocalizedVerb || '').trim();
    
    // Extract 3 root consonants
    let c1 = 'ف', c2 = 'ع', c3 = 'ل';
    if (root && root.includes('-')) {
        const parts = root.split('-').map(s => s.trim()).filter(Boolean);
        if (parts.length >= 3) {
            c1 = parts[0];
            c2 = parts[1];
            c3 = parts[2];
        }
    } else if (unvoc.length >= 3) {
        if (unvoc.startsWith('است') && unvoc.length >= 6) {
            c1 = unvoc[3]; c2 = unvoc[4]; c3 = unvoc.slice(5);
        } else if (unvoc.startsWith('ان') && unvoc.length >= 5) {
            c1 = unvoc[2]; c2 = unvoc[3]; c3 = unvoc.slice(4);
        } else if (unvoc.startsWith('ت') && unvoc.length >= 5 && unvoc[2] === 'ا') {
            c1 = unvoc[1]; c2 = unvoc[3]; c3 = unvoc.slice(4);
        } else if (unvoc.startsWith('ت') && unvoc.length >= 4) {
            c1 = unvoc[1]; c2 = unvoc[2]; c3 = unvoc.slice(3);
        } else if (unvoc.startsWith('ا') && unvoc.length >= 5 && unvoc[2] === 'ت') {
            c1 = unvoc[1]; c2 = unvoc[3]; c3 = unvoc.slice(4);
        } else if (unvoc.startsWith('أ') && unvoc.length === 4) {
            c1 = unvoc[1]; c2 = unvoc[2]; c3 = unvoc[3];
        } else if (unvoc.length === 4 && unvoc[1] === 'ا') {
            c1 = unvoc[0]; c2 = unvoc[2]; c3 = unvoc[3];
        } else {
            c1 = unvoc[0]; c2 = unvoc[1]; c3 = unvoc.slice(2);
        }
    }

    let formName = '动词';
    let pastStem = '';
    let presentStem = '';
    let imperativeStem = '';
    let isPrefixU = false;

    const pStr = (pos || '') + ' ' + (wazn || '');
    
    if (pStr.includes('X') || pStr.includes('اسْتَفْعَلَ') || unvoc.startsWith('است') || unvoc.startsWith('يست')) {
        formName = 'X 型 (اسْتَفْعَلَ)';
        pastStem = `اسْتَ${c1}ْ${c2}َ${c3}`;
        presentStem = `سْتَ${c1}ْ${c2}ِ${c3}`;
        imperativeStem = `اسْتَ${c1}ْ${c2}ِ${c3}`;
        isPrefixU = false;
    } else if (pStr.includes('VII') || pStr.includes('انْفَعَلَ') || unvoc.startsWith('ان') || unvoc.startsWith('ين')) {
        formName = 'VII 型 (انْفَعَلَ)';
        pastStem = `انْ${c1}َ${c2}َ${c3}`;
        presentStem = `نْ${c1}َ${c2}ِ${c3}`;
        imperativeStem = `انْ${c1}َ${c2}ِ${c3}`;
        isPrefixU = false;
    } else if (pStr.includes('VIII') || pStr.includes('افْتَعَلَ') || (unvoc.startsWith('ا') && unvoc.length >= 5 && unvoc[2] === 'ت') || unvoc.startsWith('يفت')) {
        formName = 'VIII 型 (افْتَعَلَ)';
        pastStem = `ا${c1}ْتَ${c2}َ${c3}`;
        presentStem = `${c1}ْتَ${c2}ِ${c3}`;
        imperativeStem = `ا${c1}ْتَ${c2}ِ${c3}`;
        isPrefixU = false;
    } else if (pStr.includes('VI') || pStr.includes('تَفَاعَلَ') || (unvoc.startsWith('ت') && unvoc.length >= 5 && unvoc[2] === 'ا') || (unvoc.startsWith('يت') && unvoc[3] === 'ا')) {
        formName = 'VI 型 (تَفَاعَلَ)';
        pastStem = `تَ${c1}َا${c2}َ${c3}`;
        presentStem = `تَ${c1}َا${c2}َ${c3}`;
        imperativeStem = `تَ${c1}َا${c2}َ${c3}`;
        isPrefixU = false;
    } else if (pStr.includes('V') || pStr.includes('تَفَعَّلَ') || (unvoc.startsWith('ت') && unvoc.length >= 4) || unvoc.startsWith('يت')) {
        formName = 'V 型 (تَفَعَّلَ)';
        pastStem = `تَ${c1}َ${c2}َّ${c3}`;
        presentStem = `تَ${c1}َ${c2}َّ${c3}`;
        imperativeStem = `تَ${c1}َ${c2}َّ${c3}`;
        isPrefixU = false;
    } else if (pStr.includes('IV') || pStr.includes('أَفْعَلَ') || unvoc.startsWith('أ') || (wazn && wazn.includes('يُفْعِ'))) {
        formName = 'IV 型 (أَفْعَلَ)';
        pastStem = `أَ${c1}ْ${c2}َ${c3}`;
        presentStem = `${c1}ْ${c2}ِ${c3}`;
        imperativeStem = `أَ${c1}ْ${c2}ِ${c3}`;
        isPrefixU = true;
    } else if (pStr.includes('III') || pStr.includes('فَاعَلَ') || (unvoc.length === 4 && unvoc[1] === 'ا') || (unvoc.length === 5 && unvoc.startsWith('ي') && unvoc[2] === 'ا')) {
        formName = 'III 型 (فَاعَلَ)';
        pastStem = `${c1}َا${c2}َ${c3}`;
        presentStem = `${c1}َا${c2}ِ${c3}`;
        imperativeStem = `${c1}َا${c2}ِ${c3}`;
        isPrefixU = true;
    } else if (pStr.includes('II') || pStr.includes('فَعَّلَ') || (vocalizedVerb && vocalizedVerb.includes('ّ')) || (wazn && wazn.includes('يُفَعِّ'))) {
        formName = 'II 型 (فَعَّلَ)';
        pastStem = `${c1}َ${c2}َّ${c3}`;
        presentStem = `${c1}َ${c2}ِّ${c3}`;
        imperativeStem = `${c1}َ${c2}ِّ${c3}`;
        isPrefixU = true;
    } else {
        formName = 'I 型 (فَعَلَ)';
        pastStem = `${c1}َ${c2}َ${c3}`;
        presentStem = `${c1}ْ${c2}ُ${c3}`;
        imperativeStem = `اُ${c1}ْ${c2}ُ${c3}`;
        isPrefixU = false;
    }

    const pA = isPrefixU ? 'أُ' : 'أَ';
    const pT = isPrefixU ? 'تُ' : 'تَ';
    const pY = isPrefixU ? 'يُ' : 'يَ';
    const pN = isPrefixU ? 'نُ' : 'نَ';

    const past_3ms = `${pastStem}َ`;
    const present_3ms = `${pY}${presentStem}ُ`;
    const imperative_2ms = `${imperativeStem}ْ`;

    const presentList = [
        { pronoun: 'أَنَا', pronounZh: '我 (1s)', ar: `${pA}${presentStem}ُ` },
        { pronoun: 'نَحْنُ', pronounZh: '我们 (1p)', ar: `${pN}${presentStem}ُ` },
        { pronoun: 'أَنْتَ', pronounZh: '你·阳 (2ms)', ar: `${pT}${presentStem}ُ` },
        { pronoun: 'أَنْتِ', pronounZh: '你·阴 (2fs)', ar: `${pT}${presentStem}ِينَ` },
        { pronoun: 'أَنْتُمَا', pronounZh: '你们俩 (2d)', ar: `${pT}${presentStem}َانِ` },
        { pronoun: 'أَنْتُمْ', pronounZh: '你们·阳 (2mp)', ar: `${pT}${presentStem}ُونَ` },
        { pronoun: 'أَنْتُنَّ', pronounZh: '你们·阴 (2fp)', ar: `${pT}${presentStem}ْنَ` },
        { pronoun: 'هُوَ', pronounZh: '他 (3ms)', ar: `${pY}${presentStem}ُ` },
        { pronoun: 'هِيَ', pronounZh: '她 (3fs)', ar: `${pT}${presentStem}ُ` },
        { pronoun: 'هُمَا (م)', pronounZh: '他们俩 (3md)', ar: `${pY}${presentStem}َانِ` },
        { pronoun: 'هُمَا (ف)', pronounZh: '她们俩 (3fd)', ar: `${pT}${presentStem}َانِ` },
        { pronoun: 'هُمْ', pronounZh: '他们 (3mp)', ar: `${pY}${presentStem}ُونَ` },
        { pronoun: 'هُنَّ', pronounZh: '她们 (3fp)', ar: `${pY}${presentStem}ْنَ` }
    ];

    const pastList = [
        { pronoun: 'أَنَا', pronounZh: '我 (1s)', ar: `${pastStem}ْتُ` },
        { pronoun: 'نَحْنُ', pronounZh: '我们 (1p)', ar: `${pastStem}ْنَا` },
        { pronoun: 'أَنْتَ', pronounZh: '你·阳 (2ms)', ar: `${pastStem}ْتَ` },
        { pronoun: 'أَنْتِ', pronounZh: '你·阴 (2fs)', ar: `${pastStem}ْتِ` },
        { pronoun: 'أَنْتُمَا', pronounZh: '你们俩 (2d)', ar: `${pastStem}ْتُمَا` },
        { pronoun: 'أَنْتُمْ', pronounZh: '你们·阳 (2mp)', ar: `${pastStem}ْتُمْ` },
        { pronoun: 'أَنْتُنَّ', pronounZh: '你们·阴 (2fp)', ar: `${pastStem}ْتُنَّ` },
        { pronoun: 'هُوَ', pronounZh: '他 (3ms)', ar: `${pastStem}َ` },
        { pronoun: 'هِيَ', pronounZh: '她 (3fs)', ar: `${pastStem}َتْ` },
        { pronoun: 'هُمَا (م)', pronounZh: '他们俩 (3md)', ar: `${pastStem}َا` },
        { pronoun: 'هُمَا (ف)', pronounZh: '她们俩 (3fd)', ar: `${pastStem}َتَا` },
        { pronoun: 'هُمْ', pronounZh: '他们 (3mp)', ar: `${pastStem}ُوا` },
        { pronoun: 'هُنَّ', pronounZh: '她们 (3fp)', ar: `${pastStem}ْنَ` }
    ];

    const imperativeList = [
        { pronoun: 'أَنْتَ', pronounZh: '你·阳 (2ms)', ar: `${imperativeStem}ْ` },
        { pronoun: 'أَنْتِ', pronounZh: '你·阴 (2fs)', ar: `${imperativeStem}ِي` },
        { pronoun: 'أَنْتُمَا', pronounZh: '你们俩 (2d)', ar: `${imperativeStem}َا` },
        { pronoun: 'أَنْتُمْ', pronounZh: '你们·阳 (2mp)', ar: `${imperativeStem}ُوا` },
        { pronoun: 'أَنْتُنَّ', pronounZh: '你们·阴 (2fp)', ar: `${imperativeStem}ْنَ` }
    ];

    return {
        formName,
        past_3ms,
        present_3ms,
        imperative_2ms,
        conjugations: {
            present: presentList,
            past: pastList,
            imperative: imperativeList
        }
    };
}

let currentConjugationData = null;
let currentConjugationTense = 'present';

function storedVerbConjugation(word) {
    const labels = { 'أنا': '我', 'نحن': '我们', 'أنت': '你·阳', 'أنتِ': '你·阴', 'أنتما': '你们俩', 'أنتما مؤ': '你们俩·阴', 'أنتم': '你们·阳', 'أنتن': '你们·阴', 'هو': '他', 'هي': '她', 'هما': '他们俩', 'هما مؤ': '她们俩', 'هم': '他们', 'هن': '她们' };
    try {
        if (word.verb_conjugations) {
            const raw = typeof word.verb_conjugations === 'string' ? JSON.parse(word.verb_conjugations) : word.verb_conjugations;
            const convert = obj => Object.entries(obj || {})
                .filter(([pronoun, ar]) => typeof ar === 'string' && ar.trim() && pronoun !== 'أنتما مؤ')
                .map(([pronoun, ar]) => ({ pronoun, pronounZh: labels[pronoun] || pronoun, ar }));
            if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid paradigm');
            return {
                formName: (word.pos || '').replace(/^动词\s*/, ''),
                past_3ms: word.verb_past || '',
                present_3ms: word.verb_present || '',
                imperative_2ms: word.verb_imperative || '',
                conjugations: { past: convert(raw['الماضي المعلوم']), present: convert(raw['المضارع المعلوم']), imperative: convert(raw['الأمر']) }
            };
        }
    } catch (_) { /* Missing/malformed textbook paradigms must not be guessed. */ }
    if ((word.tags || '').includes('教材组:')) return {
        formName: (word.pos || '').replace(/^动词\s*/, ''),
        past_3ms: word.verb_past || '', present_3ms: word.verb_present || '',
        imperative_2ms: word.verb_imperative || '',
        conjugations: { past: [], present: [], imperative: [] }
    };
    return null;
}

function renderVerbTensesSection(word, isModal = false) {
    const section = isModal ? elements.modalVerbTensesSection : elements.verbTensesSection;
    const formTag = isModal ? elements.modalVerbFormTag : elements.verbFormTag;
    const pastText = isModal ? elements.modalVerbPastText : elements.verbPastText;
    const presentText = isModal ? elements.modalVerbPresentText : elements.verbPresentText;
    const impText = isModal ? elements.modalVerbImperativeText : elements.verbImperativeText;
    const pastCard = isModal ? elements.modalVerbPastCard : elements.verbPastCard;
    const presentCard = isModal ? elements.modalVerbPresentCard : elements.verbPresentCard;
    const impCard = isModal ? elements.modalVerbImperativeCard : elements.verbImperativeCard;

    if (!section) return;

    if (!isVerbWord(word)) {
        section.classList.add('hidden');
        return;
    }

    section.classList.remove('hidden');
    const conj = storedVerbConjugation(word) || ((word.verb_past && word.verb_present && word.verb_imperative)
        ? { formName: (word.pos || '').replace(/^动词\s*/, ''), past_3ms: word.verb_past, present_3ms: word.verb_present, imperative_2ms: word.verb_imperative }
        : conjugateArabicVerb(word.text_vocalized, word.pos, word.root, word.wazn));

    [[pastCard, conj.past_3ms], [presentCard, conj.present_3ms], [impCard, conj.imperative_2ms]].forEach(([card, value]) => {
        if (card) card.classList.toggle('hidden', !value);
    });

    if (formTag) formTag.textContent = conj.formName;
    if (pastText) pastText.textContent = conj.past_3ms;
    if (presentText) presentText.textContent = conj.present_3ms;
    if (impText) impText.textContent = conj.imperative_2ms;

    if (pastCard) {
        pastCard.onclick = (e) => {
            e.stopPropagation();
            speakArabic(conj.past_3ms);
            showToast(`过去时 (الماضي): ${conj.past_3ms}`);
        };
    }
    if (presentCard) {
        presentCard.onclick = (e) => {
            e.stopPropagation();
            speakArabic(conj.present_3ms);
            showToast(`现在时 (المضارع): ${conj.present_3ms}`);
        };
    }
    if (impCard) {
        impCard.onclick = (e) => {
            e.stopPropagation();
            speakArabic(conj.imperative_2ms);
            showToast(`命令式 (الأمر): ${conj.imperative_2ms}`);
        };
    }
}

function openVerbConjugationModal(word) {
    if (!elements.verbConjugationModal || !word) return;
    let audited = null;
    try {
        if (word.verb_conjugations) {
            const raw = typeof word.verb_conjugations === 'string' ? JSON.parse(word.verb_conjugations) : word.verb_conjugations;
            const labels = { 'أنا': '我', 'نحن': '我们', 'أنت': '你·阳', 'أنتِ': '你·阴', 'أنتما': '你们俩', 'أنتما مؤ': '你们俩·阴', 'أنتم': '你们·阳', 'أنتن': '你们·阴', 'هو': '他', 'هي': '她', 'هما': '他们俩', 'هما مؤ': '她们俩', 'هم': '他们', 'هن': '她们' };
            const convert = (obj) => Object.entries(obj || {}).map(([pronoun, ar]) => ({ pronoun, pronounZh: labels[pronoun] || pronoun, ar }));
            audited = {
                formName: (word.pos || '').replace(/^动词\s*/, ''),
                past_3ms: word.verb_past,
                present_3ms: word.verb_present,
                imperative_2ms: word.verb_imperative,
                conjugations: {
                    present: convert(raw['المضارع المعلوم']),
                    past: convert(raw['الماضي المعلوم']),
                    imperative: convert(raw['الأمر'])
                }
            };
        }
    } catch (_) { /* use the legacy generator below */ }
    currentConjugationData = storedVerbConjugation(word) || audited || conjugateArabicVerb(word.text_vocalized, word.pos, word.root, word.wazn);
    currentConjugationData.word = word;

    if (elements.modalConjugationVerbName) {
        elements.modalConjugationVerbName.textContent = word.text_vocalized;
    }
    if (elements.modalConjugationFormTag) {
        elements.modalConjugationFormTag.textContent = currentConjugationData.formName;
    }

    currentConjugationTense = ['present', 'past', 'imperative'].find(key => currentConjugationData.conjugations[key]?.length) || 'present';
    switchConjugationTense(currentConjugationTense);

    elements.verbConjugationModal.classList.remove('hidden');
    elements.verbConjugationModal.classList.add('flex');
}

function closeVerbConjugationModal() {
    if (!elements.verbConjugationModal) return;
    elements.verbConjugationModal.classList.add('hidden');
    elements.verbConjugationModal.classList.remove('flex');
}

function switchConjugationTense(tense) {
    currentConjugationTense = tense;
    if (!currentConjugationData || !elements.conjugationCardsContainer) return;

    const tabs = [
        { key: 'present', el: elements.tabConjugationPresent },
        { key: 'past', el: elements.tabConjugationPast },
        { key: 'imperative', el: elements.tabConjugationImperative }
    ];

    tabs.forEach(t => {
        if (!t.el) return;
        const available = !!currentConjugationData.conjugations[t.key]?.length;
        t.el.disabled = !available;
        if (t.key === tense) {
            t.el.className = 'py-2 px-2 rounded-xl text-xs font-bold transition flex items-center justify-center gap-1 cursor-pointer bg-emerald-600 text-white shadow-sm';
        } else {
            t.el.className = 'py-2 px-2 rounded-xl text-xs font-bold text-stone-400 hover:text-white transition flex items-center justify-center gap-1 cursor-pointer';
        }
        t.el.classList.toggle('hidden', !available);
    });

    const list = currentConjugationData.conjugations[tense] || [];
    elements.conjugationCardsContainer.innerHTML = '';

    if (!list.length) {
        const notice = document.createElement('p');
        notice.className = 'text-sm text-stone-400 col-span-full text-center py-4';
        notice.textContent = '暂无可用的变位表';
        elements.conjugationCardsContainer.appendChild(notice);
    }

    list.forEach(item => {
        const card = document.createElement('div');
        card.className = 'p-3 rounded-2xl bg-stone-800/80 border border-stone-700/60 hover:border-emerald-500/80 hover:bg-stone-700/50 transition cursor-pointer flex items-center justify-between shadow-xs group';
        
        card.innerHTML = `
            <div class="flex flex-col text-left">
                <span class="text-2xs text-stone-400 font-mono">${escapeHtml(item.pronoun)}</span>
                <span class="text-3xs text-stone-500">${escapeHtml(item.pronounZh)}</span>
            </div>
            <div class="flex items-center gap-2">
                <span class="text-lg font-arabic font-bold text-stone-100 group-hover:text-emerald-300 transition text-right" dir="rtl">${escapeHtml(item.ar)}</span>
                <button class="p-1 rounded-lg bg-stone-700/60 group-hover:bg-emerald-600 text-stone-300 group-hover:text-white transition">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path></svg>
                </button>
            </div>
        `;

        card.addEventListener('click', (e) => {
            e.stopPropagation();
            speakArabic(item.ar);
            showToast(`${item.pronoun} (${item.pronounZh}): ${item.ar}`);
        });

        elements.conjugationCardsContainer.appendChild(card);
    });
}

function toggleTashkeel() {
    state.isTashkeelEnabled = !state.isTashkeelEnabled;
    const currentWord = state.currentWord;
    if (currentWord) {
        elements.headwordArabic.textContent = state.isTashkeelEnabled ? currentWord.text_vocalized : currentWord.text_unvocalized;
        elements.arToZhHeadword.textContent = state.isTashkeelEnabled ? currentWord.text_vocalized : currentWord.text_unvocalized;
    }
    if (elements.tashkeelStatusBadge) {
        elements.tashkeelStatusBadge.textContent = state.isTashkeelEnabled ? '开' : '关';
        elements.tashkeelStatusBadge.className = state.isTashkeelEnabled
            ? 'px-1 py-0.2 text-2xs rounded bg-emerald-100 text-emerald-700 font-medium'
            : 'px-1 py-0.2 text-2xs rounded bg-stone-200 text-stone-600 font-medium';
    }
    showToast(state.isTashkeelEnabled ? '已开启阿拉伯语标音' : '已隐藏标音');
}

// Mark current word as Mastered (已熟记/直接通过)
async function markCurrentWordAsMastered() {
    if (!state.currentWord) return;
    const wordId = state.currentWord.id;
    const wState = state.wordTracker[wordId];

    try {
        const response = await authFetch(`/api/word/${wordId}/master`, { method: 'POST' });
        const res = await response.json();
        showToast(`✨ ${res.message}`);
        if (wState) {
            wState.completed = true;
            state.sessionStats.completedCount++;
        }
        // Remove all remaining tasks for this word from the deck
        state.deck = state.deck.filter(t => t.wordId !== wordId);
    } catch (err) {
        console.error('Error marking word as mastered:', err);
    }

    pullNextChallenge();
}

// Show Session Complete Summary & Persist Historical Batch Log in D1
function showSessionCompleteModal() {
    const total = state.sessionStats.totalWords;
    const completed = state.sessionStats.completedCount || total;
    const attempts = state.sessionStats.totalAttempts;
    const mistakes = state.sessionStats.mistakesCount;
    const masteryRate = attempts > 0 ? Math.round(((attempts - mistakes) / attempts) * 100) : 100;
    const durationSec = state.sessionStats.startTime
        ? Math.max(1, Math.round((Date.now() - state.sessionStats.startTime) / 1000))
        : 0;

    elements.sessionTotalWords.textContent = total;
    elements.sessionMasteryRate.textContent = `${masteryRate}%`;
    elements.sessionMistakeCount.textContent = mistakes;

    elements.sessionModal.classList.remove('hidden');
    elements.sessionModal.classList.add('flex');

    authFetch('/api/session/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            mode: state.sessionMode || 'learn',
            level: state.selectedLevel || 'all',
            total_words: total,
            completed_words: completed,
            mistakes_count: mistakes,
            accuracy_pct: masteryRate,
            duration_sec: durationSec,
        }),
    }).catch((err) => console.warn('Failed to log completed study session:', err));
}

function hideSessionModal() {
    elements.sessionModal.classList.add('hidden');
    elements.sessionModal.classList.remove('flex');
}

// ---------------- Library Drawer & Word Detail Modal ----------------

let currentModalWord = null;
let wordDetailHistory = [];
let peekRequestId = 0;
let peekTrigger = null;

function updateWordDetailBackButton() {
    if (!elements.btnWordDetailBack) return;
    elements.btnWordDetailBack.classList.toggle('hidden', wordDetailHistory.length === 0);
}

function openWordDetailModal(w, options = {}) {
    if (!w || !elements.wordDetailModal) return;
    const modalOpen = !elements.wordDetailModal.classList.contains('hidden');
    const reopeningSame = Boolean(currentModalWord && currentModalWord.id === w.id);

    if (options.pushBack && modalOpen && currentModalWord && !reopeningSame) {
        wordDetailHistory.push(currentModalWord);
    } else if (!options.fromHistory && !reopeningSame) {
        wordDetailHistory = [];
    }

    hideWordPeek();
    currentModalWord = w;
    updateWordDetailBackButton();

    // 1. Vocalized and meaning
    elements.modalWordVocalized.textContent = w.text_vocalized || w.text_unvocalized;
    elements.modalWordMeaning.textContent = w.meaning_zh || '';

    // 2. Difficulty / curriculum badge & Syllabus badges
    const levelTag = getWordLevelTag(w);
    const cefrSuffix = levelTag.cls === 'meta-chip--green' ? ' · A1-A2'
        : levelTag.cls === 'meta-chip--rose' ? ' · C1-C2'
        : levelTag.cls === 'meta-chip--amber' ? ' · B1-B2'
        : '';
    elements.modalWordDiffBadge.className = `meta-chip ${levelTag.cls}`;
    elements.modalWordDiffBadge.textContent = `${levelTag.label}${cefrSuffix}`;

    const badgeContainer = elements.modalWordDiffBadge.parentElement;
    if (badgeContainer) {
        badgeContainer.querySelectorAll('.modal-syllabus-badge').forEach(el => el.remove());
        const temp = document.createElement('div');
        temp.innerHTML = getSyllabusBadgesHtml(w);
        Array.from(temp.children).forEach(child => {
            child.classList.add('modal-syllabus-badge');
            badgeContainer.appendChild(child);
        });
    }

    // 3. Status badge & Toggle Mastered Button
    if (w.progress) {
        if (w.progress.is_mastered) {
            elements.modalWordStatusBadge.className = 'meta-chip meta-chip--blue';
            elements.modalWordStatusBadge.textContent = '已熟记';
            elements.btnModalToggleMastered.innerHTML = '<span>🔄 恢复日常学习</span>';
        } else if (w.progress.interval >= 21) {
            elements.modalWordStatusBadge.className = 'meta-chip meta-chip--green';
            elements.modalWordStatusBadge.textContent = '已掌握';
            elements.btnModalToggleMastered.innerHTML = '<span>✨ 标为已熟记</span>';
        } else {
            elements.modalWordStatusBadge.className = 'meta-chip meta-chip--amber';
            const repCount = w.progress.repetition ?? w.progress.streak ?? 0;
            elements.modalWordStatusBadge.textContent = `复习中 (已复习 ${repCount} 次)`;
            elements.btnModalToggleMastered.innerHTML = '<span>✨ 标为已熟记</span>';
        }
    } else {
        elements.modalWordStatusBadge.className = 'meta-chip meta-chip--stone';
        elements.modalWordStatusBadge.textContent = '未学习';
        elements.btnModalToggleMastered.innerHTML = '<span>✨ 标为已熟记</span>';
    }

    const isVerb = w.pos && w.pos.includes('动词');

    // 4. Linguistic properties
    elements.modalWordPos.textContent = w.pos || '—';
    
    if (!isVerb && w.plural && w.plural.trim() && w.plural.trim() !== 'ـ' && w.plural.trim() !== '-') {
        elements.modalWordPluralCard.classList.remove('hidden');
        elements.modalWordPlural.textContent = w.plural;
    } else {
        elements.modalWordPluralCard.classList.add('hidden');
    }

    renderNounLexiconSection(w, true);

    // 5. Example sentence (simple phrase first when available)
    const primaryExample = getPrimaryExample(w);
    const examplePending = w.example_status === 'pending_review';
    if (elements.modalExampleLabel) {
        elements.modalExampleLabel.textContent = (!examplePending && primaryExample.isSimple) ? '📖 简单例句' : '📖 语境例句与翻译';
    }
    elements.modalExampleAr.textContent = examplePending
        ? '例句待语言学复核，暂不展示。'
        : (primaryExample.ar || '暂无例句');
    elements.modalExampleZh.textContent = examplePending ? '' : (primaryExample.zh || '');

    const showOriginalExample = !examplePending && primaryExample.isSimple && Boolean(primaryExample.originalAr);
    if (elements.modalOriginalExample) {
        elements.modalOriginalExample.classList.toggle('hidden', !showOriginalExample);
        elements.modalOriginalExample.open = false;
        if (showOriginalExample) {
            elements.modalOriginalExampleAr.textContent = primaryExample.originalAr;
            elements.modalOriginalExampleZh.textContent = primaryExample.originalZh || '';
        }
    }

    // 6. Synonyms, Antonyms & Verb Conjugation
    renderSynonymsAndAntonyms(w, true);
    if (isVerb) {
        renderVerbTensesSection(w, true);
    } else if (elements.modalVerbTensesSection) {
        elements.modalVerbTensesSection.classList.add('hidden');
    }

    // 7. Show modal
    elements.wordDetailModal.classList.remove('hidden');
    elements.wordDetailModal.classList.add('flex');
}

function closeWordDetailModal() {
    if (!elements.wordDetailModal) return;
    hideWordPeek();
    wordDetailHistory = [];
    updateWordDetailBackButton();
    elements.wordDetailModal.classList.add('hidden');
    elements.wordDetailModal.classList.remove('flex');
    currentModalWord = null;
}

function goBackWordDetail() {
    const previous = wordDetailHistory.pop();
    if (!previous) {
        updateWordDetailBackButton();
        return;
    }
    openWordDetailModal(previous, { fromHistory: true });
}

let librarySearchTimer = null;
let libraryAbortController = null;
const LIBRARY_PAGE_SIZE = 80;
let libraryRenderedCount = 0;

async function openLibraryDrawer() {
    elements.libraryDrawer.classList.remove('translate-x-full');
    await loadLibraryWords();
}

function closeLibraryDrawer() {
    elements.libraryDrawer.classList.add('translate-x-full');
}

function scheduleLoadLibraryWords() {
    if (librarySearchTimer) clearTimeout(librarySearchTimer);
    librarySearchTimer = setTimeout(() => {
        loadLibraryWords();
    }, 250);
}

async function loadLibraryWords() {
    if (librarySearchTimer) {
        clearTimeout(librarySearchTimer);
        librarySearchTimer = null;
    }
    if (libraryAbortController) {
        libraryAbortController.abort();
    }
    libraryAbortController = new AbortController();

    const q = elements.librarySearchInput ? elements.librarySearchInput.value.trim() : '';
    const status = elements.libraryStatusFilter ? elements.libraryStatusFilter.value : 'all';
    const diff = elements.libraryDifficultyFilter ? elements.libraryDifficultyFilter.value : 'all';

    let url = `/api/words?`;
    if (q) url += `q=${encodeURIComponent(q)}&`;
    if (status && status !== 'all') url += `status=${encodeURIComponent(status)}&`;
    if (diff && diff !== 'all') url += (diff === 'book1' || diff === 'book2' ? `group=${encodeURIComponent(diff)}&` : `difficulty=${encodeURIComponent(diff)}&`);

    try {
        const response = await authFetch(url, { signal: libraryAbortController.signal });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(data.message || data.error || `获取词库失败 (${response.status})`);
        }
        state.allWordsCache = data.words || [];
        renderLibraryList(state.allWordsCache, true);
    } catch (err) {
        if (err && err.name === 'AbortError') return;
        console.error('Error loading library:', err);
        if (elements.libraryWordList) {
            elements.libraryWordList.innerHTML = `
                <div class="text-center py-12 text-stone-400 px-4">
                    <p class="text-sm leading-relaxed">${escapeHtml(err.message || '获取词库失败，请稍后重试')}</p>
                </div>
            `;
        }
    }
}

function createLibraryWordItem(w) {
    const item = document.createElement('div');
    item.className = 'p-4 rounded-2xl bg-white border border-stone-200/80 hover:border-amber-400 hover:shadow-md transition flex items-center justify-between shadow-xs cursor-pointer active:scale-99';

    let statusBadge = '<span class="meta-chip meta-chip--stone">未学习</span>';
    let actionBtn = '';

    if (w.progress) {
        if (w.progress.is_mastered) {
            statusBadge = '<span class="meta-chip meta-chip--blue">已熟记</span>';
            actionBtn = `<button class="unmaster-btn px-2 py-1 text-xs text-stone-500 hover:text-stone-800 bg-stone-100 hover:bg-stone-200 rounded-lg transition" data-id="${w.id}">恢复学习</button>`;
        } else if (w.progress.interval >= 21) {
            statusBadge = '<span class="meta-chip meta-chip--green">已掌握</span>';
        } else {
            statusBadge = '<span class="meta-chip meta-chip--amber">复习中</span>';
        }
    }

    const levelTag = getWordLevelTag(w);
    const diffBadge = `<span class="meta-chip ${levelTag.cls}">${levelTag.label}</span>`;
    const syllabusBadges = getSyllabusBadgesHtml(w);
    const primaryExample = getPrimaryExample(w);

    item.innerHTML = `
        <div class="flex-1 pr-4">
            <div class="flex items-center gap-1.5 mb-1 flex-wrap">
                ${diffBadge}
                ${syllabusBadges}
                <span class="meta-root">جذر: ${escapeHtml(w.root || '—')}</span>
                <span class="meta-chip meta-chip--stone">${escapeHtml(w.pos || '')}</span>
                ${statusBadge}
            </div>
            <div class="text-sm font-medium text-stone-800">${escapeHtml(w.meaning_zh)}</div>
            <div class="text-xs text-stone-400 font-arabic text-right mt-1">${w.example_status === 'pending_review' ? '例句待复核' : escapeHtml(primaryExample.ar || '')}</div>
        </div>
        <div class="text-right flex flex-col items-end gap-1.5">
            <span class="text-2xl font-serif text-stone-900 font-arabic mb-0.5">${escapeHtml(w.text_vocalized)}</span>
            <div class="flex items-center gap-1.5">
                ${actionBtn}
                <button class="lib-play-btn p-1.5 rounded-full hover:bg-stone-100 text-stone-500 hover:text-stone-800 transition" title="发音">
                    <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15H4a1 1 0 01-1-1v-4a1 1 0 011-1h1.586l4.707-4.707C10.923 3.663 12 4.109 12 5v14c0 .891-1.077 1.337-1.707.707L5.586 15z"></path></svg>
                </button>
            </div>
        </div>
    `;

    item.addEventListener('click', () => {
        openWordDetailModal(w);
    });

    const playBtn = item.querySelector('.lib-play-btn');
    playBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        playWordAudio(w, playBtn);
    });

    const unmasterBtn = item.querySelector('.unmaster-btn');
    if (unmasterBtn) {
        unmasterBtn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const wordId = unmasterBtn.getAttribute('data-id');
            await authFetch(`/api/word/${wordId}/unmaster`, { method: 'POST' });
            showToast('已恢复为常规复习状态');
            await loadLibraryWords();
            await loadDashboardData();
        });
    }

    return item;
}

function renderLibraryList(words, reset = true) {
    if (reset) {
        elements.libraryWordList.innerHTML = '';
        libraryRenderedCount = 0;
    }
    if (words.length === 0) {
        elements.libraryWordList.innerHTML = `
            <div class="text-center py-12 text-stone-400">
                <p>未找到匹配的词汇</p>
            </div>
        `;
        return;
    }

    const existingMore = elements.libraryWordList.querySelector('.lib-load-more-btn');
    if (existingMore) existingMore.remove();

    const slice = words.slice(libraryRenderedCount, libraryRenderedCount + LIBRARY_PAGE_SIZE);
    const frag = document.createDocumentFragment();
    slice.forEach((w) => {
        frag.appendChild(createLibraryWordItem(w));
    });
    libraryRenderedCount += slice.length;

    if (libraryRenderedCount < words.length) {
        const moreBtn = document.createElement('button');
        moreBtn.type = 'button';
        moreBtn.className = 'lib-load-more-btn w-full py-3 rounded-2xl bg-white hover:bg-amber-50 border border-stone-200 text-xs font-semibold text-stone-600 hover:text-amber-800 transition cursor-pointer shadow-2xs';
        moreBtn.textContent = `加载更多词汇（已显示 ${libraryRenderedCount} / ${words.length}）`;
        moreBtn.addEventListener('click', () => renderLibraryList(words, false));
        frag.appendChild(moreBtn);
    }

    elements.libraryWordList.appendChild(frag);
}

// Reset Progress
async function resetAllProgress() {
    if (!confirm('确定要重置所有单词的复习进度与签到数据吗？该操作不可撤销。')) return;
    try {
        const response = await authFetch('/api/reset', { method: 'POST' });
        const res = await response.json();
        showToast(res.message);
        elements.settingsModal.classList.add('hidden');
        await loadDashboardData();
    } catch (err) {
        showToast('重置失败');
    }
}

// ---------------- Event Listeners ----------------

function bindEvents() {
    // Theme Switcher
    elements.btnSwitchTheme.addEventListener('click', cycleTheme);

    // Checkin Widget
    elements.checkinWidget.addEventListener('click', handleCheckin);

    // Dashboard Learn & Review Cards
    elements.btnCardLearn.addEventListener('click', () => startSession('learn'));
    elements.btnCardReview.addEventListener('click', () => startSession('review'));

    // Back to Dashboard
    elements.btnBackToDashboard.addEventListener('click', showDashboard);

    // Tab Navigation
    if (elements.tabLevel) {
        elements.tabLevel.addEventListener('click', (e) => {
            e.stopPropagation();
            openLevelModal();
        });
    }
    if (elements.tabLibrary) {
        elements.tabLibrary.addEventListener('click', (e) => {
            e.stopPropagation();
            openLibraryDrawer();
        });
    }
    if (elements.btnCloseLevelModal) {
        elements.btnCloseLevelModal.addEventListener('click', closeLevelModal);
    }
    if (elements.btnBrowseLibraryDirect) {
        elements.btnBrowseLibraryDirect.addEventListener('click', () => {
            closeLevelModal();
            openLibraryDrawer();
        });
    }
    if (elements.libraryDifficultyFilter) {
        elements.libraryDifficultyFilter.addEventListener('change', loadLibraryWords);
    }
    const openSettingsModal = () => {
        if (!elements.settingsModal) return;
        elements.settingsModal.classList.remove('hidden');
        elements.settingsModal.classList.add('flex');
    };
    if (elements.tabSettings) {
        elements.tabSettings.addEventListener('click', openSettingsModal);
    }
    if (elements.btnOpenSettingsAvatar) {
        elements.btnOpenSettingsAvatar.addEventListener('click', openSettingsModal);
    }

    // Audio Buttons
    elements.audioWordBtn.addEventListener('click', () => {
        const w = state.currentWord;
        if (w) playWordAudio(w, elements.audioWordBtn);
    });

    elements.audioSentenceBtn.addEventListener('click', () => {
        const w = state.currentWord;
        if (w) {
            const primary = getPrimaryExample(w);
            if (primary.ar) speakArabic(primary.ar, elements.audioSentenceBtn);
        }
    });

    if (elements.btnToggleSimpleZh && elements.exampleSimpleZhText) {
        elements.btnToggleSimpleZh.addEventListener('click', (e) => {
            e.stopPropagation();
            const isHidden = elements.exampleSimpleZhText.classList.toggle('hidden');
            elements.btnToggleSimpleZh.textContent = isHidden ? '看中文' : '收起中文';
        });
    }

    elements.audioArToZhBtn.addEventListener('click', () => {
        const w = state.currentWord;
        if (w) playWordAudio(w, elements.audioArToZhBtn);
    });

    // Tashkeel Toggle
    elements.tashkeelToggleBtn.addEventListener('click', toggleTashkeel);
    elements.headwordArabic.addEventListener('click', toggleTashkeel);

    // Detail sentence audio button
    if (elements.btnDetailAudioSentence) {
        elements.btnDetailAudioSentence.addEventListener('click', () => {
            const w = state.currentWord;
            if (!w) return;
            const primary = getPrimaryExample(w);
            if (primary.ar) speakArabic(primary.ar, elements.btnDetailAudioSentence);
        });
    }
    if (elements.btnDetailAudioOriginal) {
        elements.btnDetailAudioOriginal.addEventListener('click', () => {
            const w = state.currentWord;
            if (w && w.example_ar) speakArabic(w.example_ar, elements.btnDetailAudioOriginal);
        });
    }

    // Mark as Mastered
    elements.btnMarkMastered.addEventListener('click', markCurrentWordAsMastered);

    // Mode 1: Flashcard Actions
    elements.btnDontKnow.addEventListener('click', () => onAnswerWrong());
    elements.btnKnow.addEventListener('click', () => onAnswerCorrect());

    // Spelling Actions
    if (elements.btnSpellingClear) {
        elements.btnSpellingClear.addEventListener('click', () => {
            elements.spellingInput.value = '';
        });
    }
    elements.btnSpellingBackspace.addEventListener('click', () => {
        elements.spellingInput.value = elements.spellingInput.value.slice(0, -1);
    });
    elements.btnSubmitSpelling.addEventListener('click', handleSpellingSubmit);
    elements.spellingInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') handleSpellingSubmit();
    });

    // Next Challenge button (Step 2)
    elements.btnNextChallenge.addEventListener('click', pullNextChallenge);

    // Session Modal Actions
    elements.btnNextSession.addEventListener('click', () => {
        hideSessionModal();
        startSession(state.sessionMode);
    });
    elements.btnReturnHomeFromModal.addEventListener('click', () => {
        hideSessionModal();
        showDashboard();
    });

    // Library Drawer Actions
    elements.btnCloseLibrary.addEventListener('click', closeLibraryDrawer);
    elements.librarySearchInput.addEventListener('input', () => scheduleLoadLibraryWords());
    elements.libraryStatusFilter.addEventListener('change', loadLibraryWords);

    // Daily Goal Modal Actions
    if (elements.btnDailyGoalTrigger) {
        elements.btnDailyGoalTrigger.addEventListener('click', (e) => {
            e.stopPropagation();
            openDailyGoalModal();
        });
    }
    if (elements.btnCloseDailyGoalModal) {
        elements.btnCloseDailyGoalModal.addEventListener('click', closeDailyGoalModal);
    }
    document.querySelectorAll('.goal-option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const g = btn.getAttribute('data-goal');
            if (g) setDailyGoal(g);
        });
    });
    if (elements.btnSaveCustomGoal && elements.customGoalInput) {
        elements.btnSaveCustomGoal.addEventListener('click', () => {
            if (elements.customGoalInput.value) setDailyGoal(elements.customGoalInput.value);
        });
        elements.customGoalInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && elements.customGoalInput.value) {
                setDailyGoal(elements.customGoalInput.value);
            }
        });
    }

    // Review Goal Modal Actions (自定义复习抽词事件绑定)
    if (elements.btnOpenReviewGoalModal) {
        elements.btnOpenReviewGoalModal.addEventListener('click', (e) => {
            e.stopPropagation();
            openReviewGoalModal();
        });
    }
    if (elements.btnCloseReviewGoalModal) {
        elements.btnCloseReviewGoalModal.addEventListener('click', closeReviewGoalModal);
    }
    document.querySelectorAll('.review-goal-option-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const g = btn.getAttribute('data-goal');
            if (g) setReviewGoal(g);
        });
    });
    if (elements.btnSaveCustomReviewGoal && elements.customReviewGoalInput) {
        elements.btnSaveCustomReviewGoal.addEventListener('click', () => {
            if (elements.customReviewGoalInput.value) setReviewGoal(elements.customReviewGoalInput.value);
        });
        elements.customReviewGoalInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && elements.customReviewGoalInput.value) {
                setReviewGoal(elements.customReviewGoalInput.value);
            }
        });
    }

    // Word Detail Modal Events (单词详情弹窗交互)
    if (elements.btnCloseWordDetailModal) {
        elements.btnCloseWordDetailModal.addEventListener('click', closeWordDetailModal);
    }
    if (elements.btnWordDetailBack) {
        elements.btnWordDetailBack.addEventListener('click', (e) => {
            e.stopPropagation();
            goBackWordDetail();
        });
    }
    if (elements.btnModalCloseAction) {
        elements.btnModalCloseAction.addEventListener('click', closeWordDetailModal);
    }
    if (elements.wordDetailModal) {
        elements.wordDetailModal.addEventListener('click', (e) => {
            if (e.target === elements.wordDetailModal) closeWordDetailModal();
        });
    }
    if (elements.btnModalPlayAudio) {
        elements.btnModalPlayAudio.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentModalWord) playWordAudio(currentModalWord, elements.btnModalPlayAudio);
        });
    }
    if (elements.btnModalPlaySentence) {
        elements.btnModalPlaySentence.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentModalWord) {
                const primary = getPrimaryExample(currentModalWord);
                if (primary.ar) speakArabic(primary.ar, elements.btnModalPlaySentence);
            }
        });
    }
    if (elements.btnModalPlayOriginal) {
        elements.btnModalPlayOriginal.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentModalWord && currentModalWord.example_ar) {
                speakArabic(currentModalWord.example_ar, elements.btnModalPlayOriginal);
            }
        });
    }
    if (elements.btnModalToggleMastered) {
        elements.btnModalToggleMastered.addEventListener('click', async (e) => {
            e.stopPropagation();
            if (!currentModalWord) return;
            const w = currentModalWord;
            const isMastered = w.progress && w.progress.is_mastered;
            if (isMastered) {
                await authFetch(`/api/word/${w.id}/unmaster`, { method: 'POST' });
                showToast('已恢复为常规复习状态');
                if (w.progress) w.progress.is_mastered = false;
            } else {
                await authFetch(`/api/word/${w.id}/master`, { method: 'POST' });
                showToast('✨ 已标记为熟记词汇！');
                if (!w.progress) w.progress = {};
                w.progress.is_mastered = true;
            }
            openWordDetailModal(w);
            await loadLibraryWords();
            await loadDashboardData();
        });
    }

    // Verb Conjugation Modal Events
    if (elements.btnOpenConjugationModal) {
        elements.btnOpenConjugationModal.addEventListener('click', (e) => {
            e.stopPropagation();
            if (state.currentWord) openVerbConjugationModal(state.currentWord);
        });
    }
    if (elements.btnModalOpenConjugationModal) {
        elements.btnModalOpenConjugationModal.addEventListener('click', (e) => {
            e.stopPropagation();
            if (currentModalWord) openVerbConjugationModal(currentModalWord);
        });
    }
    if (elements.btnCloseConjugationModal) {
        elements.btnCloseConjugationModal.addEventListener('click', closeVerbConjugationModal);
    }
    if (elements.btnCloseConjugationBottom) {
        elements.btnCloseConjugationBottom.addEventListener('click', closeVerbConjugationModal);
    }
    if (elements.verbConjugationModal) {
        elements.verbConjugationModal.addEventListener('click', (e) => {
            if (e.target === elements.verbConjugationModal) closeVerbConjugationModal();
        });
    }
    if (elements.tabConjugationPresent) {
        elements.tabConjugationPresent.addEventListener('click', () => switchConjugationTense('present'));
    }
    if (elements.tabConjugationPast) {
        elements.tabConjugationPast.addEventListener('click', () => switchConjugationTense('past'));
    }
    if (elements.tabConjugationImperative) {
        elements.tabConjugationImperative.addEventListener('click', () => switchConjugationTense('imperative'));
    }

    // Settings Modal & Self-Service Profile Controls
    elements.btnCloseSettings.addEventListener('click', () => {
        elements.settingsModal.classList.add('hidden');
        elements.settingsModal.classList.remove('flex');
    });
    if (elements.settingsModal) {
        elements.settingsModal.addEventListener('click', (e) => {
            if (e.target === elements.settingsModal) {
                elements.settingsModal.classList.add('hidden');
                elements.settingsModal.classList.remove('flex');
            }
        });
    }
    if (elements.settingsDailyGoalSelect) {
        elements.settingsDailyGoalSelect.addEventListener('change', (e) => {
            setDailyGoal(e.target.value);
        });
    }
    elements.sessionSizeSelect.addEventListener('change', (e) => {
        setDailyGoal(e.target.value);
    });
    elements.btnResetProgress.addEventListener('click', resetAllProgress);

    if (elements.btnToggleEditNickname && elements.editNicknamePanel) {
        elements.btnToggleEditNickname.addEventListener('click', () => {
            const hidden = elements.editNicknamePanel.classList.toggle('hidden');
            if (!hidden) {
                if (elements.changePasswordPanel) elements.changePasswordPanel.classList.add('hidden');
                if (elements.feedbackPanel) elements.feedbackPanel.classList.add('hidden');
                const u = auth.getUser();
                if (elements.inputNewNickname) {
                    elements.inputNewNickname.value = (u && u.username) || '';
                    elements.inputNewNickname.focus();
                }
            }
        });
    }
    if (elements.btnSaveNickname) {
        elements.btnSaveNickname.addEventListener('click', handleSaveNickname);
    }
    if (elements.inputNewNickname) {
        elements.inputNewNickname.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleSaveNickname();
            }
        });
    }

    if (elements.btnToggleChangePassword && elements.changePasswordPanel) {
        elements.btnToggleChangePassword.addEventListener('click', () => {
            const hidden = elements.changePasswordPanel.classList.toggle('hidden');
            if (!hidden) {
                if (elements.editNicknamePanel) elements.editNicknamePanel.classList.add('hidden');
                if (elements.feedbackPanel) elements.feedbackPanel.classList.add('hidden');
                if (elements.inputCurrentPassword) elements.inputCurrentPassword.focus();
            }
        });
    }
    if (elements.btnSaveChangedPassword) {
        elements.btnSaveChangedPassword.addEventListener('click', handleSaveChangedPassword);
    }

    // ---- User feedback ----
    if (elements.btnToggleFeedback && elements.feedbackPanel) {
        elements.btnToggleFeedback.addEventListener('click', () => {
            const hidden = elements.feedbackPanel.classList.toggle('hidden');
            if (!hidden) {
                if (elements.editNicknamePanel) elements.editNicknamePanel.classList.add('hidden');
                if (elements.changePasswordPanel) elements.changePasswordPanel.classList.add('hidden');
                if (elements.inputFeedback) elements.inputFeedback.focus();
            }
        });
    }
    if (elements.inputFeedback) {
        elements.inputFeedback.addEventListener('input', () => {
            if (elements.feedbackCounter) {
                elements.feedbackCounter.textContent = `${elements.inputFeedback.value.length} / 500`;
            }
        });
    }
    if (elements.btnSubmitFeedback) {
        elements.btnSubmitFeedback.addEventListener('click', handleSubmitFeedback);
    }
    if (elements.tabAdminUsers) {
        elements.tabAdminUsers.addEventListener('click', () => switchAdminTab('users'));
    }
    if (elements.tabAdminFeedback) {
        elements.tabAdminFeedback.addEventListener('click', () => switchAdminTab('feedback'));
    }
    if (elements.inputChangedPassword) {
        elements.inputChangedPassword.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                handleSaveChangedPassword();
            }
        });
    }

    // Admin Overview Modal Controls
    if (elements.btnOpenAdminOverview) {
        elements.btnOpenAdminOverview.addEventListener('click', openAdminOverviewModal);
    }
    if (elements.btnCloseAdminOverview) {
        elements.btnCloseAdminOverview.addEventListener('click', closeAdminOverviewModal);
    }
    if (elements.btnRefreshAdminOverview) {
        elements.btnRefreshAdminOverview.addEventListener('click', loadAdminOverviewData);
    }
    if (elements.adminOverviewModal) {
        elements.adminOverviewModal.addEventListener('click', (e) => {
            if (e.target === elements.adminOverviewModal) closeAdminOverviewModal();
        });
    }

    // Word Peek popover
    if (elements.wordPeekClose) {
        elements.wordPeekClose.addEventListener('click', (e) => {
            e.stopPropagation();
            hideWordPeek();
        });
    }
    document.addEventListener('click', (e) => {
        if (!elements.wordPeekPopover || elements.wordPeekPopover.classList.contains('hidden')) return;
        if (elements.wordPeekPopover.contains(e.target)) return;
        if (e.target instanceof Element && e.target.closest('.word-peek-trigger')) return;
        hideWordPeek();
    });
    document.addEventListener('scroll', (e) => {
        if (!elements.wordPeekPopover || elements.wordPeekPopover.classList.contains('hidden')) return;
        if (elements.wordPeekPopover.contains(e.target)) return;
        hideWordPeek();
    }, true);
    window.addEventListener('resize', () => {
        if (!elements.wordPeekPopover || elements.wordPeekPopover.classList.contains('hidden')) return;
        if (peekTrigger) positionWordPeek(peekTrigger);
        else hideWordPeek();
    });

    // Keyboard Shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            if (elements.wordPeekPopover && !elements.wordPeekPopover.classList.contains('hidden')) {
                hideWordPeek();
                return;
            }
            closeAdminOverviewModal();
            closeVerbConjugationModal();
            closeWordDetailModal();
            closeLibraryDrawer();
            closeDailyGoalModal();
            closeReviewGoalModal();
            elements.settingsModal.classList.add('hidden');
            elements.settingsModal.classList.remove('flex');
            return;
        }

        const activeTag = document.activeElement ? document.activeElement.tagName : '';
        if (activeTag === 'INPUT' || activeTag === 'TEXTAREA' || activeTag === 'SELECT') return;

        if (state.currentView === 'flashcard') {
            if (e.key === 'm' || e.key === 'M' || e.key === '0') {
                e.preventDefault();
                markCurrentWordAsMastered();
                return;
            }

            // Step 2: Enter to advance
            if (state.step === 2 && (e.key === 'Enter' || e.code === 'Space')) {
                e.preventDefault();
                pullNextChallenge();
                return;
            }

            // Step 1: Mode specific keys
            if (state.step === 1) {
                if (state.currentChallengeMode === 'flashcard') {
                    if (e.code === 'Space' || e.key === 'j' || e.key === 'J') {
                        e.preventDefault();
                        onAnswerWrong();
                    } else if (e.key === 'Enter' || e.key === 'k' || e.key === 'K') {
                        e.preventDefault();
                        onAnswerCorrect();
                    }
                } else if (state.currentChallengeMode === 'ar_to_zh' || state.currentChallengeMode === 'zh_to_ar') {
                    if (['1', '2', '3', '4'].includes(e.key)) {
                        e.preventDefault();
                        const optIndex = parseInt(e.key, 10) - 1;
                        const container = state.currentChallengeMode === 'ar_to_zh' ? elements.arToZhOptionsList : elements.zhToArOptionsList;
                        const btns = container.querySelectorAll('button');
                        if (btns[optIndex]) btns[optIndex].click();
                    }
                }
            }

            if (e.key === 'a' || e.key === 'A') {
                const w = state.currentWord;
                if (w) playWordAudio(w, elements.audioWordBtn);
            } else if (e.key === 's' || e.key === 'S') {
                const w = state.currentWord;
                if (w) {
                    const primary = getPrimaryExample(w);
                    if (primary.ar) speakArabic(primary.ar, elements.audioSentenceBtn);
                }
            } else if (e.key === 't' || e.key === 'T') {
                toggleTashkeel();
            }
        }
    });
}

// Pure, direct Auth Event Attachment
function bindAuthEvents() {
    const logoutBtn = elements.btnLogout || document.getElementById('btnLogout');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', handleLogout);
    }

    // Registration consent checkbox: submit stays locked until checked.
    const agree = document.getElementById('registerAgree');
    if (agree) {
        agree.addEventListener('change', syncLegalConsentState);
    }
    resetLegalConsentState();

    // Avatar picker
    const avatarBtn = document.getElementById('btnChangeAvatar');
    const avatarInput = document.getElementById('avatarFileInput');
    if (avatarBtn && avatarInput) {
        avatarBtn.addEventListener('click', () => avatarInput.click());
        avatarInput.addEventListener('change', handleAvatarFileChange);
    }

    // Close the legal modal with Escape or a backdrop click.
    const legalModal = document.getElementById('legalModal');
    if (legalModal) {
        legalModal.addEventListener('click', (e) => {
            if (e.target === legalModal) closeLegalModal();
        });
    }
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') closeLegalModal();
    });
}

// App Entry Point
document.addEventListener('DOMContentLoaded', async () => {
    try { initSpeech(); } catch (e) { console.warn('initSpeech error:', e); }
    try { initTheme(); } catch (e) { console.warn('initTheme error:', e); }
    try { bindAuthEvents(); } catch (e) { console.warn('bindAuthEvents error:', e); }
    try { bindEvents(); } catch (e) { console.warn('bindEvents error:', e); }
    
    const isAuthed = await checkAuthOnStartup();
    if (isAuthed) {
        loadDashboardData();
    }
});
