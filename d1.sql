-- ============================================
-- XPLITLEAKS DATABASE SCHEMA v5.1
-- For Cloudflare D1 (SQLite-compatible)
-- Copy and paste this entire block into your D1 console
-- ============================================

-- ============================================
-- 1. SITE CONFIGURATION
-- ============================================
CREATE TABLE IF NOT EXISTS site_config (
    id INTEGER PRIMARY KEY DEFAULT 1,
    siteName TEXT DEFAULT 'Xplitleaks',
    siteLogo TEXT,
    siteLogoSvg TEXT DEFAULT '',
    faviconUrl TEXT DEFAULT '',
    siteDescription TEXT DEFAULT '',
    defaultOgImage TEXT DEFAULT '',
    vastTagUrl TEXT,
    outstreamAdTags TEXT DEFAULT '[]',
    placementUrls TEXT DEFAULT '[]',
    primaryColor TEXT DEFAULT '#ff0050',
    r2PublicUrl TEXT,
    registrationEnabled INTEGER DEFAULT 1,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Insert default config if not exists
INSERT OR IGNORE INTO site_config (id, siteName, siteLogo, siteLogoSvg, faviconUrl, siteDescription, defaultOgImage, vastTagUrl, outstreamAdTags, placementUrls, primaryColor, r2PublicUrl, registrationEnabled, updatedAt)
VALUES (1, 'Xplitleaks', NULL, '', '', '', '', NULL, '[]', '[]', '#ff0050', NULL, 1, datetime('now'));

-- ============================================
-- 2. CATEGORIES
-- ============================================
CREATE TABLE IF NOT EXISTS categories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    videoCount INTEGER DEFAULT 0,
    sortOrder INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 3. TAGS
-- ============================================
CREATE TABLE IF NOT EXISTS tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    slug TEXT NOT NULL UNIQUE,
    usageCount INTEGER DEFAULT 0,
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ============================================
-- 4. CREATORS
-- ============================================
CREATE TABLE IF NOT EXISTS creators (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL UNIQUE,
    password TEXT NOT NULL,
    token TEXT UNIQUE,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'suspended')),
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    lastLogin DATETIME
);

-- ============================================
-- 5. VIDEOS
-- ============================================
CREATE TABLE IF NOT EXISTS videos (
    id TEXT PRIMARY KEY,
    numericId TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    videoUrl TEXT NOT NULL,
    thumbnail TEXT DEFAULT '',
    duration TEXT DEFAULT '0:00',
    uploadDate TEXT,
    category TEXT DEFAULT 'uncategorized',
    tags TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    creatorId INTEGER,
    creatorName TEXT DEFAULT '',
    type TEXT DEFAULT 'r2' CHECK (type IN ('r2', 'iframe')),
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'removed', 'reported')),
    views INTEGER DEFAULT 0,
    realViews INTEGER DEFAULT 0,
    fakeViews INTEGER DEFAULT 0,
    reported INTEGER DEFAULT 0,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creatorId) REFERENCES creators(id) ON DELETE SET NULL
);

-- ============================================
-- 6. SHORTS
-- ============================================
CREATE TABLE IF NOT EXISTS shorts (
    id TEXT PRIMARY KEY,
    numericId TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    videoUrl TEXT NOT NULL,
    thumbnail TEXT DEFAULT '',
    duration TEXT DEFAULT '0:00',
    uploadDate TEXT,
    category TEXT DEFAULT 'uncategorized',
    tags TEXT DEFAULT '[]',
    description TEXT DEFAULT '',
    creatorId INTEGER,
    creatorName TEXT DEFAULT '',
    views INTEGER DEFAULT 0,
    realViews INTEGER DEFAULT 0,
    fakeViews INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    shares INTEGER DEFAULT 0,
    engagementScore REAL DEFAULT 0.0,
    status TEXT DEFAULT 'active' CHECK (status IN ('active', 'removed', 'reported')),
    reported INTEGER DEFAULT 0,
    addedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    updatedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (creatorId) REFERENCES creators(id) ON DELETE SET NULL
);

-- ============================================
-- 7. VIDEO VIEWS (Analytics)
-- ============================================
CREATE TABLE IF NOT EXISTS video_views (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    videoId TEXT NOT NULL,
    sessionId TEXT,
    watchDuration REAL DEFAULT 0,
    ipAddress TEXT DEFAULT 'unknown',
    viewedAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (videoId) REFERENCES videos(numericId) ON DELETE CASCADE
);

-- ============================================
-- 8. SHORT INTERACTIONS (Views, Likes, Shares)
-- ============================================
CREATE TABLE IF NOT EXISTS short_interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shortId TEXT NOT NULL,
    sessionId TEXT,
    action TEXT NOT NULL CHECK (action IN ('view', 'like', 'share', 'complete')),
    metadata TEXT DEFAULT '{}',
    ipAddress TEXT DEFAULT 'unknown',
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (shortId) REFERENCES shorts(numericId) ON DELETE CASCADE
);

-- ============================================
-- 9. REPORTS
-- ============================================
CREATE TABLE IF NOT EXISTS reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contentId TEXT NOT NULL,
    contentType TEXT NOT NULL CHECK (contentType IN ('video', 'short')),
    reason TEXT NOT NULL,
    details TEXT DEFAULT '',
    reporterEmail TEXT,
    reporterName TEXT,
    reporterPhone TEXT,
    reporterSession TEXT,
    status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'resolved', 'dismissed')),
    createdAt DATETIME DEFAULT CURRENT_TIMESTAMP,
    resolvedAt DATETIME
);

-- ============================================
-- 10. VIDEO TAGS (Junction Table)
-- ============================================
CREATE TABLE IF NOT EXISTS video_tags (
    videoId TEXT NOT NULL,
    tagId INTEGER NOT NULL,
    PRIMARY KEY (videoId, tagId),
    FOREIGN KEY (videoId) REFERENCES videos(id) ON DELETE CASCADE,
    FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
);

-- ============================================
-- INDEXES (Performance)
-- ============================================
CREATE INDEX IF NOT EXISTS idx_videos_status ON videos(status);
CREATE INDEX IF NOT EXISTS idx_videos_category ON videos(category);
CREATE INDEX IF NOT EXISTS idx_videos_creator ON videos(creatorId);
CREATE INDEX IF NOT EXISTS idx_videos_numericId ON videos(numericId);
CREATE INDEX IF NOT EXISTS idx_videos_addedAt ON videos(addedAt);

CREATE INDEX IF NOT EXISTS idx_shorts_status ON shorts(status);
CREATE INDEX IF NOT EXISTS idx_shorts_category ON shorts(category);
CREATE INDEX IF NOT EXISTS idx_shorts_creator ON shorts(creatorId);
CREATE INDEX IF NOT EXISTS idx_shorts_numericId ON shorts(numericId);
CREATE INDEX IF NOT EXISTS idx_shorts_engagement ON shorts(engagementScore DESC, views DESC);
CREATE INDEX IF NOT EXISTS idx_shorts_addedAt ON shorts(addedAt);

CREATE INDEX IF NOT EXISTS idx_creators_status ON creators(status);
CREATE INDEX IF NOT EXISTS idx_creators_token ON creators(token);

CREATE INDEX IF NOT EXISTS idx_video_views_videoId ON video_views(videoId);
CREATE INDEX IF NOT EXISTS idx_video_views_session ON video_views(sessionId);

CREATE INDEX IF NOT EXISTS idx_short_interactions_shortId ON short_interactions(shortId);
CREATE INDEX IF NOT EXISTS idx_short_interactions_session ON short_interactions(sessionId);
CREATE INDEX IF NOT EXISTS idx_short_interactions_action ON short_interactions(action);

CREATE INDEX IF NOT EXISTS idx_reports_status ON reports(status);
CREATE INDEX IF NOT EXISTS idx_reports_content ON reports(contentId, contentType);

-- ============================================
-- SCHEMA COMPLETE
-- ============================================
