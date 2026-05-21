// ============================================
// XPLITLEAKS API - CLOUDFLARE WORKER v4.0
// Complete Backend with D1 + R2 + Advanced Shorts Recommendations
// ============================================

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // ============================================
        // CORS HEADERS
        // ============================================
        const corsHeaders = {
            "Access-Control-Allow-Origin": "*",
            "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, PATCH, OPTIONS",
            "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Session-Id, X-Creator-Token, X-Admin-Token, Accept",
            "Access-Control-Max-Age": "86400",
        };

        if (method === "OPTIONS") {
            return new Response(null, { status: 204, headers: corsHeaders });
        }

        const jsonResponse = (data, status = 200) => 
            new Response(JSON.stringify(data), { 
                status, 
                headers: { ...corsHeaders, "Content-Type": "application/json" } 
            });

        const errorResponse = (message, status = 400) => 
            jsonResponse({ error: message, status, timestamp: new Date().toISOString() }, status);

        // ============================================
        // URL NORMALIZATION HELPERS
        // ============================================
        function normalizeUrl(urlStr) {
            if (!urlStr || typeof urlStr !== 'string') return urlStr;
            urlStr = urlStr.trim();
            if (urlStr.startsWith('http://') || urlStr.startsWith('https://')) return urlStr;
            if (urlStr.startsWith('//')) return 'https:' + urlStr;
            return 'https://' + urlStr.replace(/^\/+/, '');
        }

        function normalizeVideo(video) {
            if (!video) return video;
            return {
                ...video,
                videoUrl: normalizeUrl(video.videoUrl),
                thumbnail: normalizeUrl(video.thumbnail)
            };
        }

        // ============================================
        // AUTH HELPERS
        // ============================================
        const checkAdminAuth = () => {
            const auth = request.headers.get("Authorization")?.replace("Bearer ", "") || 
                        request.headers.get("X-Admin-Token");
            return auth === env.ADMIN_TOKEN;
        };

        const checkCreatorAuth = async () => {
            const token = request.headers.get("X-Creator-Token") || 
                         request.headers.get("Authorization")?.replace("Bearer ", "");
            if (!token) return null;

            const creator = await env.DB.prepare(
                "SELECT * FROM creators WHERE token = ? AND status = 'approved'"
            ).bind(token).first();

            return creator;
        };

        const getSessionId = () => 
            request.headers.get("X-Session-Id") || crypto.randomUUID();

        const getClientIP = () => 
            request.headers.get("CF-Connecting-IP") || 
            request.headers.get("X-Forwarded-For")?.split(",")[0] || 
            "unknown";

        // ============================================
        // MAIN ROUTER
        // ============================================
        try {

            // ============================================
            // PUBLIC ENDPOINTS
            // ============================================

            // Health Check
            if (path === "/api/health" && method === "GET") {
                return jsonResponse({ 
                    status: "ok", 
                    timestamp: new Date().toISOString(),
                    version: "4.0.0"
                });
            }

            // Get Site Configuration
            if (path === "/api/config" && method === "GET") {
                const config = await env.DB.prepare(
                    "SELECT siteName, siteLogo, vastTagUrl, placementUrls, outstreamAdTags, primaryColor, r2PublicUrl FROM site_config WHERE id = 1"
                ).first();

                return jsonResponse(config || {
                    siteName: "Xplitleaks",
                    siteLogo: null,
                    vastTagUrl: null,
                    placementUrls: "[]",
                    outstreamAdTags: "[]",
                    primaryColor: "#ff0050",
                    r2PublicUrl: null
                });
            }

            // ============================================
            // VIDEO ENDPOINTS
            // ============================================

            // List Videos with Pagination
            if (path === "/api/videos" && method === "GET") {
                const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
                const limit = Math.min(50, parseInt(url.searchParams.get("limit")) || 15); // Default 15 for index page
                const offset = (page - 1) * limit;
                const search = url.searchParams.get("search") || '';
                const category = url.searchParams.get("category") || 'all';

                let whereClause = "WHERE v.status = 'active'";
                const params = [];

                if (search) {
                    whereClause += " AND (v.title LIKE ? OR v.description LIKE ?)";
                    params.push(`%${search}%`, `%${search}%`);
                }

                if (category && category !== 'all') {
                    whereClause += " AND v.category = ?";
                    params.push(category);
                }

                const countResult = await env.DB.prepare(
                    `SELECT COUNT(*) as total FROM videos v ${whereClause}`
                ).bind(...params).first();

                const { results } = await env.DB.prepare(`
                    SELECT 
                        v.id,
                        v.numericId,
                        v.title,
                        v.videoUrl,
                        v.thumbnail,
                        v.duration,
                        v.uploadDate,
                        v.category,
                        v.tags,
                        v.description,
                        v.creatorId,
                        v.type,
                        v.status,
                        v.addedAt,
                        v.updatedAt,
                        c.username as creatorName,
                        CASE 
                            WHEN v.realViews >= 1000 THEN v.views
                            ELSE v.fakeViews + v.realViews
                        END as displayViews,
                        v.views,
                        v.realViews,
                        v.fakeViews
                    FROM videos v 
                    LEFT JOIN creators c ON v.creatorId = c.id 
                    ${whereClause} 
                    ORDER BY v.addedAt DESC 
                    LIMIT ? OFFSET ?
                `).bind(...params, limit, offset).all();

                return jsonResponse({
                    videos: (results || []).map(normalizeVideo),
                    pagination: {
                        page,
                        limit,
                        total: countResult?.total || 0,
                        totalPages: Math.ceil((countResult?.total || 0) / limit)
                    }
                });
            }

            // Get Related Videos (paginated)
            if (path === "/api/videos/related" && method === "GET") {
                const videoId = url.searchParams.get("videoId") || '';
                const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
                const limit = Math.min(24, parseInt(url.searchParams.get("limit")) || 12);
                const offset = (page - 1) * limit;
                const category = url.searchParams.get("category") || '';

                let videoCategory = category;
                if (videoId) {
                    const vidInfo = await env.DB.prepare(
                        "SELECT category FROM videos WHERE numericId = ? OR id = ?"
                    ).bind(videoId, videoId).first();
                    if (vidInfo) videoCategory = vidInfo.category;
                }

                let whereClause = "WHERE v.status = 'active'";
                const params = [];

                if (videoId) {
                    whereClause += " AND v.numericId != ? AND v.id != ?";
                    params.push(videoId, videoId);
                }

                let orderClause = "ORDER BY v.addedAt DESC";
                if (videoCategory) {
                    orderClause = `ORDER BY CASE WHEN v.category = ? THEN 0 ELSE 1 END, v.addedAt DESC`;
                    params.push(videoCategory);
                }

                const countResult = await env.DB.prepare(
                    `SELECT COUNT(*) as total FROM videos v ${whereClause}`
                ).bind(...params).first();

                const { results } = await env.DB.prepare(`
                    SELECT 
                        v.id,
                        v.numericId,
                        v.title,
                        v.videoUrl,
                        v.thumbnail,
                        v.duration,
                        v.uploadDate,
                        v.category,
                        v.addedAt,
                        c.username as creatorName,
                        CASE 
                            WHEN v.realViews >= 1000 THEN v.views
                            ELSE v.fakeViews + v.realViews
                        END as displayViews,
                        v.views
                    FROM videos v 
                    LEFT JOIN creators c ON v.creatorId = c.id 
                    ${whereClause} 
                    ${orderClause}
                    LIMIT ? OFFSET ?
                `).bind(...params, limit, offset).all();

                return jsonResponse({
                    videos: (results || []).map(normalizeVideo),
                    pagination: {
                        page,
                        limit,
                        total: countResult?.total || 0,
                        totalPages: Math.ceil((countResult?.total || 0) / limit)
                    }
                });
            }

            // Get Single Video
            if (path.match(/^\/api\/video\/[a-zA-Z0-9_-]+$/) && method === "GET") {
                const id = path.split("/")[3];

                let video = await env.DB.prepare(`
                    SELECT 
                        v.*,
                        c.username as creatorName,
                        CASE 
                            WHEN v.realViews >= 1000 THEN v.views
                            ELSE v.fakeViews + v.realViews
                        END as displayViews
                    FROM videos v 
                    LEFT JOIN creators c ON v.creatorId = c.id 
                    WHERE (v.numericId = ? OR v.id = ?) AND v.status = 'active'
                `).bind(id, id).first();

                if (!video) {
                    return errorResponse("Video not found", 404);
                }

                ctx.waitUntil(
                    env.DB.prepare(`
                        UPDATE videos 
                        SET views = views + 1, realViews = realViews + 1 
                        WHERE numericId = ?
                    `).bind(id).run()
                );

                return jsonResponse(normalizeVideo(video));
            }

            // Track Video View
            if (path === "/api/video/view" && method === "POST") {
                const { videoId, watchDuration } = await request.json().catch(() => ({}));
                const sessionId = getSessionId();

                if (!videoId) {
                    return errorResponse("Video ID required", 400);
                }

                await env.DB.prepare(`
                    INSERT INTO video_views (videoId, sessionId, watchDuration, ipAddress, viewedAt)
                    VALUES (?, ?, ?, ?, datetime('now'))
                `).bind(videoId, sessionId, watchDuration || 0, getClientIP()).run();

                return jsonResponse({ success: true });
            }

            // ============================================
            // SHORTS ENDPOINTS
            // ============================================

            // Get Shorts (basic listing - used by index page trending shorts)
            if (path === "/api/shorts" && method === "GET") {
                const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
                const limit = Math.min(50, parseInt(url.searchParams.get("limit")) || 12);
                const offset = (page - 1) * limit;
                const excludeIds = url.searchParams.get("exclude")?.split(",").filter(Boolean) || [];

                let whereClause = "WHERE s.status = 'active'";
                const params = [];

                if (excludeIds.length > 0) {
                    const placeholders = excludeIds.map(() => '?').join(',');
                    whereClause += ` AND s.numericId NOT IN (${placeholders})`;
                    params.push(...excludeIds);
                }

                const countResult = await env.DB.prepare(
                    `SELECT COUNT(*) as total FROM shorts s ${whereClause}`
                ).bind(...params).first();

                const { results } = await env.DB.prepare(`
                    SELECT 
                        s.*,
                        c.username as creatorName,
                        CASE 
                            WHEN s.realViews >= 1000 THEN s.views
                            ELSE s.fakeViews + s.realViews
                        END as displayViews
                    FROM shorts s
                    LEFT JOIN creators c ON s.creatorId = c.id
                    ${whereClause}
                    ORDER BY s.engagementScore DESC, s.views DESC
                    LIMIT ? OFFSET ?
                `).bind(...params, limit, offset).all();

                return jsonResponse({
                    shorts: (results || []).map(normalizeVideo),
                    pagination: {
                        page,
                        limit,
                        total: countResult?.total || 0,
                        totalPages: Math.ceil((countResult?.total || 0) / limit)
                    }
                });
            }

            // ============================================
            // ADVANCED SHORTS RECOMMENDATION ALGORITHM v4.0
            // ============================================
            if (path === "/api/shorts/recommend" && method === "GET") {
                const sessionId = url.searchParams.get("sessionId") || getSessionId();
                const limit = Math.min(50, parseInt(url.searchParams.get("limit")) || 10); // Default 10
                const excludeIds = url.searchParams.get("exclude")?.split(",").filter(Boolean) || [];
                const currentId = url.searchParams.get("currentId") || null;

                // Get total catalog stats for diversification tuning
                const catalogStats = await env.DB.prepare(`
                    SELECT 
                        COUNT(*) as totalShorts,
                        COUNT(DISTINCT creatorId) as totalCreators
                    FROM shorts 
                    WHERE status = 'active'
                `).first();

                const totalShorts = catalogStats?.totalShorts || 0;
                const totalCreators = catalogStats?.totalCreators || 0;

                // Auto-adjust diversification based on catalog size
                // If < 5 creators, relax creator limits significantly
                const isSmallCatalog = totalCreators < 5;
                const isSingleCreator = totalCreators === 1;

                // Get user's watch history for this session
                const history = await env.DB.prepare(`
                    SELECT 
                        sh.shortId,
                        sh.tags,
                        sh.category,
                        sh.watchDuration,
                        sh.watchedAt,
                        s.creatorId,
                        s.engagementScore,
                        s.views,
                        s.likes
                    FROM session_history sh
                    LEFT JOIN shorts s ON sh.shortId = s.numericId
                    WHERE sh.sessionId = ? 
                    ORDER BY sh.watchedAt DESC 
                    LIMIT 100
                `).bind(sessionId).all();

                const watchedIds = [];
                const watchedCreators = {};
                const userTags = {};
                const userCategories = {};
                const recentWatchedIds = []; // Last 20 for recency penalty

                if (history.results) {
                    history.results.forEach((item, index) => {
                        const weight = Math.max(0.05, 1 - (index * 0.01)); // Decaying weight

                        if (item.shortId) {
                            watchedIds.push(item.shortId);
                            if (index < 20) recentWatchedIds.push(item.shortId);
                        }

                        if (item.creatorId) {
                            watchedCreators[item.creatorId] = (watchedCreators[item.creatorId] || 0) + weight;
                        }

                        if (item.tags) {
                            try {
                                const tags = JSON.parse(item.tags);
                                tags.forEach(tag => {
                                    userTags[tag] = (userTags[tag] || 0) + weight;
                                });
                            } catch (e) {}
                        }

                        if (item.category) {
                            userCategories[item.category] = (userCategories[item.category] || 0) + weight;
                        }
                    });
                }

                // Build candidate pool
                const allExcluded = [...new Set([...excludeIds, ...watchedIds])];

                let query = `
                    SELECT 
                        s.*,
                        c.username as creatorName,
                        (s.likes * 2 + s.shares * 3) / MAX(s.views, 1) as engagementRate,
                        CASE 
                            WHEN s.realViews >= 1000 THEN s.views
                            ELSE s.fakeViews + s.realViews
                        END as displayViews,
                        julianday('now') - julianday(s.addedAt) as ageDays
                    FROM shorts s
                    LEFT JOIN creators c ON s.creatorId = c.id
                    WHERE s.status = 'active'
                `;

                const params = [];

                // Exclude already watched and currently excluded
                if (allExcluded.length > 0) {
                    const placeholders = allExcluded.map(() => '?').join(',');
                    query += ` AND s.numericId NOT IN (${placeholders})`;
                    params.push(...allExcluded);
                }

                // Get larger candidate pool for scoring
                query += ` ORDER BY s.addedAt DESC LIMIT 200`;

                const { results: candidates } = await env.DB.prepare(query).bind(...params).all();

                if (!candidates || candidates.length === 0) {
                    // Fallback: if all watched, reset and allow re-watching (but not immediately)
                    if (watchedIds.length > 0) {
                        const fallbackQuery = `
                            SELECT 
                                s.*,
                                c.username as creatorName,
                                (s.likes * 2 + s.shares * 3) / MAX(s.views, 1) as engagementRate,
                                CASE 
                                    WHEN s.realViews >= 1000 THEN s.views
                                    ELSE s.fakeViews + s.realViews
                                END as displayViews,
                                julianday('now') - julianday(s.addedAt) as ageDays
                            FROM shorts s
                            LEFT JOIN creators c ON s.creatorId = c.id
                            WHERE s.status = 'active'
                            ${excludeIds.length > 0 ? `AND s.numericId NOT IN (${excludeIds.map(() => '?').join(',')})` : ''}
                            ORDER BY s.addedAt DESC
                            LIMIT 200
                        `;
                        const fallback = await env.DB.prepare(fallbackQuery)
                            .bind(...(excludeIds.length > 0 ? excludeIds : []))
                            .all();

                        if (!fallback.results || fallback.results.length === 0) {
                            return jsonResponse([]);
                        }

                        // Score and return fallback results
                        return jsonResponse(scoreAndRank(fallback.results, [], {}, {}, [], isSmallCatalog, isSingleCreator, limit));
                    }
                    return jsonResponse([]);
                }

                // Score and rank candidates
                const scored = scoreAndRank(
                    candidates, 
                    watchedIds, 
                    userTags, 
                    userCategories, 
                    recentWatchedIds,
                    isSmallCatalog,
                    isSingleCreator,
                    limit
                );

                return jsonResponse(scored.map(normalizeVideo));
            }

            // ============================================
            // SCORING FUNCTION - Advanced Recommendation Algorithm
            // ============================================
            function scoreAndRank(candidates, watchedIds, userTags, userCategories, recentWatchedIds, isSmallCatalog, isSingleCreator, limit) {
                const now = Date.now();
                const maxAge = Math.max(...candidates.map(c => c.ageDays || 0));
                const minAge = Math.min(...candidates.map(c => c.ageDays || 0));
                const ageRange = Math.max(1, maxAge - minAge);

                // Track creator counts for diversification
                const creatorCounts = {};
                const selected = [];
                const remaining = [...candidates];

                // Calculate scores for all candidates
                const scored = remaining.map(short => {
                    let score = 0;
                    const id = short.numericId || short.id;

                    // 1. ROUND-ROBIN FAIRNESS: Least-watched videos get boost
                    // Check if this video has been watched
                    const watchIndex = watchedIds.indexOf(id);
                    const isWatched = watchIndex !== -1;

                    if (!isWatched) {
                        // Unwatched videos get significant boost
                        score += 50;
                    } else {
                        // Watched videos: the longer ago, the better
                        const recencyWeight = Math.max(0, 1 - (watchIndex / Math.max(watchedIds.length, 1)));
                        score += recencyWeight * 20;
                    }

                    // 2. FRESHNESS BOOST: Newer videos get slight preference
                    const ageDays = short.ageDays || 0;
                    const freshnessScore = 1 - ((ageDays - minAge) / ageRange);
                    score += freshnessScore * 15;

                    // 3. RECENCY PENALTY: Just-watched videos pushed to back
                    const recentIndex = recentWatchedIds.indexOf(id);
                    if (recentIndex !== -1) {
                        const recencyPenalty = Math.max(0, 1 - (recentIndex / 20)) * -40;
                        score += recencyPenalty;
                    }

                    // 4. ENGAGEMENT SCORE: Popular videos get moderate boost
                    const engagementRate = Math.min(short.engagementRate || 0, 1);
                    score += engagementRate * 10;

                    // 5. PERSONALIZATION: Tag/category matching
                    let tagScore = 0;
                    let categoryScore = 0;

                    try {
                        const tags = short.tags ? JSON.parse(short.tags) : [];
                        if (tags.length > 0 && Object.keys(userTags).length > 0) {
                            const matchCount = tags.filter(t => userTags[t]).length;
                            tagScore = (matchCount / tags.length) * 20;
                        }
                    } catch (e) {}

                    if (short.category && userCategories[short.category]) {
                        categoryScore = Math.min(userCategories[short.category], 1) * 15;
                    }

                    // Only apply personalization if user has history
                    if (Object.keys(userTags).length > 0 || Object.keys(userCategories).length > 0) {
                        score += tagScore + categoryScore;
                    } else {
                        // For new users, rely more on engagement + freshness
                        score += engagementRate * 15 + freshnessScore * 10;
                    }

                    // 6. RANDOM JITTER: Prevents deterministic loops (±10%)
                    const jitter = (Math.random() - 0.5) * 0.2 * Math.abs(score);
                    score += jitter;

                    return { ...short, score };
                });

                // Sort by score descending
                scored.sort((a, b) => b.score - a.score);

                // 7. DIVERSIFICATION with auto-adjusted limits
                // For small catalogs, relax creator limits
                const maxPerCreator = isSingleCreator ? 100 : (isSmallCatalog ? 10 : 3);

                for (const short of scored) {
                    const creatorId = short.creatorId || 'unknown';
                    const currentCount = creatorCounts[creatorId] || 0;

                    // Allow more from same creator if catalog is small
                    if (currentCount < maxPerCreator) {
                        creatorCounts[creatorId] = currentCount + 1;
                        selected.push(short);

                        if (selected.length >= limit) break;
                    }
                }

                // If we don't have enough after diversification, fill with remaining
                if (selected.length < limit && scored.length > selected.length) {
                    const selectedIds = new Set(selected.map(s => s.numericId || s.id));
                    for (const short of scored) {
                        if (!selectedIds.has(short.numericId || short.id)) {
                            selected.push(short);
                            if (selected.length >= limit) break;
                        }
                    }
                }

                return selected;
            }

            // Get Single Short
            if (path.match(/^\/api\/short\/[a-zA-Z0-9_-]+$/) && method === "GET") {
                const id = path.split("/")[3];

                let short = await env.DB.prepare(`
                    SELECT 
                        s.*,
                        c.username as creatorName,
                        CASE 
                            WHEN s.realViews >= 1000 THEN s.views
                            ELSE s.fakeViews + s.realViews
                        END as displayViews
                    FROM shorts s 
                    LEFT JOIN creators c ON s.creatorId = c.id 
                    WHERE (s.numericId = ? OR s.id = ?) AND s.status = 'active'
                `).bind(id, id).first();

                if (!short) {
                    return errorResponse("Short not found", 404);
                }

                ctx.waitUntil(
                    env.DB.prepare(`
                        UPDATE shorts 
                        SET views = views + 1, realViews = realViews + 1 
                        WHERE numericId = ?
                    `).bind(id).run()
                );

                return jsonResponse(normalizeVideo(short));
            }

            // Track Short View
            if (path === "/api/short/view" && method === "POST") {
                const { shortId, watchDuration, watchTime } = await request.json().catch(() => ({}));
                const sessionId = getSessionId();

                if (!shortId) {
                    return errorResponse("Short ID required", 400);
                }

                // Threshold: 50% watched OR 15 seconds OR 90% complete
                const shouldTrack = watchDuration >= 0.5 || watchTime >= 15 || watchDuration >= 0.9;

                if (!shouldTrack) {
                    return jsonResponse({ success: true, tracked: false, reason: "threshold_not_met" });
                }

                const action = watchDuration >= 0.9 ? 'complete' : 'view';

                await env.DB.prepare(`
                    INSERT INTO short_interactions (shortId, sessionId, action, metadata, ipAddress, timestamp)
                    VALUES (?, ?, ?, ?, ?, datetime('now'))
                `).bind(shortId, sessionId, action, JSON.stringify({ watchDuration, watchTime }), getClientIP()).run();

                // Update session history for recommendations
                try {
                    const short = await env.DB.prepare(
                        "SELECT tags, category FROM shorts WHERE numericId = ?"
                    ).bind(shortId).first();

                    if (short) {
                        await env.DB.prepare(`
                            INSERT INTO session_history (sessionId, shortId, tags, category, watchDuration, watchedAt)
                            VALUES (?, ?, ?, ?, ?, datetime('now'))
                            ON CONFLICT(sessionId, shortId) DO UPDATE SET 
                                watchDuration = MAX(excluded.watchDuration, ?),
                                watchedAt = datetime('now')
                        `).bind(
                            sessionId, shortId, short.tags, short.category, 
                            watchDuration, watchDuration
                        ).run();
                    }
                } catch (e) {
                    console.error("Session history error:", e);
                }

                return jsonResponse({ success: true, tracked: true });
            }

            // Batch Track Views
            if (path === "/api/short/view/batch" && method === "POST") {
                const { views } = await request.json().catch(() => ({}));
                const sessionId = getSessionId();

                if (!views || !Array.isArray(views)) {
                    return errorResponse("views array required", 400);
                }

                for (const view of views) {
                    try {
                        const { shortId, watchDuration } = view;
                        if (!shortId) continue;

                        const shouldTrack = watchDuration >= 0.5;

                        if (shouldTrack) {
                            await env.DB.prepare(`
                                INSERT INTO short_interactions (shortId, sessionId, action, metadata, ipAddress, timestamp)
                                VALUES (?, ?, 'view', ?, ?, datetime('now'))
                            `).bind(shortId, sessionId, JSON.stringify({ watchDuration }), getClientIP()).run();

                            const short = await env.DB.prepare(
                                "SELECT tags, category FROM shorts WHERE numericId = ?"
                            ).bind(shortId).first();

                            if (short) {
                                await env.DB.prepare(`
                                    INSERT INTO session_history (sessionId, shortId, tags, category, watchDuration, watchedAt)
                                    VALUES (?, ?, ?, ?, ?, datetime('now'))
                                    ON CONFLICT(sessionId, shortId) DO UPDATE SET 
                                        watchDuration = MAX(excluded.watchDuration, ?),
                                        watchedAt = datetime('now')
                                `).bind(
                                    sessionId, shortId, short.tags, short.category, 
                                    watchDuration, watchDuration
                                ).run();
                            }
                        }
                    } catch (e) {
                        console.error("Batch view error:", e);
                    }
                }

                return jsonResponse({ success: true });
            }

            // Like/Unlike Short
            if (path === "/api/short/like" && method === "POST") {
                const { shortId } = await request.json().catch(() => ({}));
                const sessionId = getSessionId();

                if (!shortId) {
                    return errorResponse("Short ID required", 400);
                }

                const existing = await env.DB.prepare(
                    "SELECT * FROM short_interactions WHERE shortId = ? AND sessionId = ? AND action = 'like'"
                ).bind(shortId, sessionId).first();

                if (existing) {
                    // Unlike
                    await env.DB.prepare("DELETE FROM short_interactions WHERE id = ?").bind(existing.id).run();
                    await env.DB.prepare("UPDATE shorts SET likes = MAX(likes - 1, 0) WHERE numericId = ?").bind(shortId).run();
                    return jsonResponse({ success: true, action: "unliked" });
                } else {
                    // Like
                    await env.DB.prepare(`
                        INSERT INTO short_interactions (shortId, sessionId, action, ipAddress, timestamp)
                        VALUES (?, ?, 'like', ?, datetime('now'))
                    `).bind(shortId, sessionId, getClientIP()).run();
                    await env.DB.prepare("UPDATE shorts SET likes = likes + 1 WHERE numericId = ?").bind(shortId).run();
                    return jsonResponse({ success: true, action: "liked" });
                }
            }

            // ============================================
            // SHARE ENDPOINT - REMOVED BACKEND COUNTING
            // Frontend share works without backend storage
            // ============================================
            // Note: Share counting removed. Frontend handles share UI natively.
            // No /api/short/share endpoint needed.

            // ============================================
            // REPORT ENDPOINT
            // ============================================
            if (path === "/api/report" && method === "POST") {
                const { 
                    contentId, 
                    contentType, 
                    reason, 
                    details,
                    reporterEmail,
                    reporterName,
                    reporterPhone 
                } = await request.json().catch(() => ({}));

                if (!contentId || !contentType || !reason) {
                    return errorResponse("Missing required fields", 400);
                }

                if (reporterEmail && !reporterEmail.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
                    return errorResponse("Invalid email format", 400);
                }

                await env.DB.prepare(`
                    INSERT INTO reports (
                        contentId, contentType, reason, details, 
                        reporterEmail, reporterName, reporterPhone,
                        reporterSession, status, createdAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', datetime('now'))
                `).bind(
                    contentId, 
                    contentType, 
                    reason, 
                    details || '',
                    reporterEmail || null,
                    reporterName || null,
                    reporterPhone || null,
                    getSessionId()
                ).run();

                return jsonResponse({ success: true, message: "Report submitted successfully" });
            }

            // ============================================
            // CREATOR AUTHENTICATION
            // ============================================

            // Creator Signup
            if (path === "/api/creator/signup" && method === "POST") {
                const data = await request.json().catch(() => ({}));

                if (!data.username || !data.email || !data.password) {
                    return errorResponse("Username, email, and password required", 400);
                }

                const existing = await env.DB.prepare(
                    "SELECT * FROM creators WHERE email = ? OR username = ?"
                ).bind(data.email, data.username).first();

                if (existing) {
                    return errorResponse("Email or username already exists", 409);
                }

                const token = crypto.randomUUID();
                const now = new Date().toISOString();

                await env.DB.prepare(`
                    INSERT INTO creators (id, username, email, password, token, status, createdAt, updatedAt)
                    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
                `).bind(
                    crypto.randomUUID(),
                    data.username,
                    data.email,
                    data.password,
                    token,
                    now,
                    now
                ).run();

                return jsonResponse({ 
                    success: true, 
                    message: "Signup successful. Waiting for admin approval.",
                    token 
                });
            }

            // Creator Login
            if (path === "/api/creator/login" && method === "POST") {
                const data = await request.json().catch(() => ({}));

                const creator = await env.DB.prepare(
                    "SELECT * FROM creators WHERE (email = ? OR username = ?) AND password = ? AND status = 'approved'"
                ).bind(data.email || data.username, data.username || data.email, data.password).first();

                if (!creator) {
                    return errorResponse("Invalid credentials or account not approved", 401);
                }

                await env.DB.prepare(
                    "UPDATE creators SET lastLogin = datetime('now') WHERE id = ?"
                ).bind(creator.id).run();

                return jsonResponse({
                    success: true,
                    token: creator.token,
                    username: creator.username,
                    email: creator.email
                });
            }

            // Get Creator Profile
            if (path === "/api/creator/profile" && method === "GET") {
                const creator = await checkCreatorAuth();
                if (!creator) {
                    return errorResponse("Unauthorized", 401);
                }

                const videoCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM videos WHERE creatorId = ?"
                ).bind(creator.id).first();

                const shortCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM shorts WHERE creatorId = ?"
                ).bind(creator.id).first();

                const totalViews = await env.DB.prepare(`
                    SELECT COALESCE(SUM(views), 0) as views 
                    FROM videos WHERE creatorId = ?
                `).bind(creator.id).first();

                return jsonResponse({
                    ...creator,
                    password: undefined,
                    stats: {
                        videos: videoCount?.count || 0,
                        shorts: shortCount?.count || 0,
                        totalViews: totalViews?.views || 0
                    }
                });
            }

            // ============================================
            // CREATOR UPLOADS
            // ============================================

            // Upload Video
            if (path === "/api/creator/upload/video" && method === "POST") {
                const creator = await checkCreatorAuth();
                if (!creator) {
                    return errorResponse("Unauthorized", 401);
                }

                const data = await request.json().catch(() => ({}));

                if (!data.title || !data.videoUrl) {
                    return errorResponse("Title and videoUrl required", 400);
                }

                const maxIdResult = await env.DB.prepare(
                    "SELECT MAX(CAST(numericId AS INTEGER)) as maxId FROM videos"
                ).first();
                const maxId = maxIdResult?.maxId || 0;
                const numericId = String(maxId + 1).padStart(6, "0");
                const urlFriendlyId = data.title.toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .substring(0, 50) || `video-${numericId}`;

                const now = new Date().toISOString();
                const fakeViews = Math.floor(Math.random() * 99000) + 1000;

                await env.DB.prepare(`
                    INSERT INTO videos (
                        id, numericId, title, videoUrl, thumbnail, duration, 
                        category, tags, description, creatorId, uploadDate, 
                        type, views, realViews, fakeViews, status, addedAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)
                `).bind(
                    urlFriendlyId, 
                    numericId, 
                    data.title, 
                    data.videoUrl,
                    data.thumbnail || "", 
                    data.duration || "0:00",
                    data.category || "uncategorized", 
                    JSON.stringify(data.tags || []),
                    data.description || "", 
                    creator.id,
                    data.uploadDate || now.split("T")[0], 
                    'r2', 
                    fakeViews, 
                    0,
                    fakeViews, 
                    now, 
                    now
                ).run();

                if (data.tags && Array.isArray(data.tags)) {
                    for (const tag of data.tags) {
                        await env.DB.prepare(`
                            INSERT INTO tags (name, usageCount) 
                            VALUES (?, 1) 
                            ON CONFLICT(name) DO UPDATE SET usageCount = usageCount + 1
                        `).bind(tag.toLowerCase()).run();
                    }
                }

                return jsonResponse({ success: true, numericId, id: urlFriendlyId });
            }

            // Upload Short
            if (path === "/api/creator/upload/short" && method === "POST") {
                const creator = await checkCreatorAuth();
                if (!creator) {
                    return errorResponse("Unauthorized", 401);
                }

                const data = await request.json().catch(() => ({}));

                if (!data.title || !data.videoUrl) {
                    return errorResponse("Title and videoUrl required", 400);
                }

                const maxIdResult = await env.DB.prepare(
                    "SELECT MAX(CAST(numericId AS INTEGER)) as maxId FROM shorts"
                ).first();
                const maxId = maxIdResult?.maxId || 0;
                const numericId = String(maxId + 1).padStart(6, "0");
                const now = new Date().toISOString();
                const fakeViews = Math.floor(Math.random() * 99000) + 1000;

                await env.DB.prepare(`
                    INSERT INTO shorts (
                        id, numericId, title, videoUrl, thumbnail, duration,
                        category, tags, creatorId, uploadDate, views, realViews, fakeViews,
                        likes, shares, engagementScore, status, addedAt, updatedAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0.0, 'active', ?, ?)
                `).bind(
                    `short-${numericId}`, 
                    numericId, 
                    data.title, 
                    data.videoUrl,
                    data.thumbnail || "", 
                    data.duration || "0:00",
                    data.category || "uncategorized", 
                    JSON.stringify(data.tags || []),
                    creator.id, 
                    data.uploadDate || now.split("T")[0], 
                    fakeViews,
                    0,
                    fakeViews, 
                    now, 
                    now
                ).run();

                if (data.tags && Array.isArray(data.tags)) {
                    for (const tag of data.tags) {
                        await env.DB.prepare(`
                            INSERT INTO tags (name, usageCount) 
                            VALUES (?, 1) 
                            ON CONFLICT(name) DO UPDATE SET usageCount = usageCount + 1
                        `).bind(tag.toLowerCase()).run();
                    }
                }

                return jsonResponse({ success: true, numericId });
            }

            // Get Creator Content
            if (path === "/api/creator/content" && method === "GET") {
                const creator = await checkCreatorAuth();
                if (!creator) {
                    return errorResponse("Unauthorized", 401);
                }

                const type = url.searchParams.get("type") || "all";

                let videos = [], shorts = [];

                if (type === 'all' || type === 'videos') {
                    const { results } = await env.DB.prepare(`
                        SELECT 
                            *,
                            CASE 
                                WHEN realViews >= 1000 THEN views
                                ELSE fakeViews + realViews
                            END as displayViews
                        FROM videos 
                        WHERE creatorId = ? 
                        ORDER BY addedAt DESC
                    `).bind(creator.id).all();
                    videos = results || [];
                }

                if (type === 'all' || type === 'shorts') {
                    const { results } = await env.DB.prepare(`
                        SELECT 
                            *,
                            CASE 
                                WHEN realViews >= 1000 THEN views
                                ELSE fakeViews + realViews
                            END as displayViews
                        FROM shorts 
                        WHERE creatorId = ? 
                        ORDER BY addedAt DESC
                    `).bind(creator.id).all();
                    shorts = results || [];
                }

                return jsonResponse({ 
                    videos: videos.map(normalizeVideo), 
                    shorts: shorts.map(normalizeVideo) 
                });
            }

            // R2 File Upload
            if (path === "/api/upload/file" && method === "POST") {
                const creator = await checkCreatorAuth();
                const isAdmin = checkAdminAuth();

                if (!creator && !isAdmin) {
                    return errorResponse("Unauthorized", 401);
                }

                try {
                    const formData = await request.formData();
                    const file = formData.get("file");
                    const storagePath = formData.get("path") || 'uploads';
                    const filename = formData.get("filename");

                    if (!file) {
                        return errorResponse("No file provided", 400);
                    }

                    if (!env.BUCKET) {
                        return errorResponse("R2 Bucket not configured", 500);
                    }

                    const finalFilename = filename || `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                    const key = `${storagePath}/${finalFilename}`;

                    const object = await env.BUCKET.put(key, file.stream(), {
                        httpMetadata: {
                            contentType: file.type || "application/octet-stream"
                        }
                    });

                    let r2Host = (env.R2_PUBLIC_URL || "").trim();
                    r2Host = r2Host.replace(/^https?:\/\//, "");
                    r2Host = r2Host.replace(/\/+$/, "");

                    if (!r2Host) {
                        return errorResponse("R2_PUBLIC_URL not configured", 500);
                    }

                    const publicUrl = `https://${r2Host}/${key}`;

                    return jsonResponse({ 
                        success: true, 
                        url: publicUrl,
                        key: key,
                        size: object.size,
                        etag: object.etag
                    });

                } catch (error) {
                    console.error("R2 upload error:", error);
                    return errorResponse("Upload failed: " + error.message, 500);
                }
            }

            // ============================================
            // ADMIN ENDPOINTS
            // ============================================

            if (!checkAdminAuth()) {
                return errorResponse("Unauthorized", 401);
            }

            // Get Admin Stats
            if (path === "/api/admin/stats" && method === "GET") {
                const videoCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM videos WHERE status = 'active'"
                ).first();

                const shortCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM shorts WHERE status = 'active'"
                ).first();

                const creatorCount = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM creators WHERE status = 'approved'"
                ).first();

                const pendingCreators = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM creators WHERE status = 'pending'"
                ).first();

                const totalVideoViews = await env.DB.prepare(
                    "SELECT COALESCE(SUM(realViews), 0) as total FROM videos"
                ).first();

                const totalShortViews = await env.DB.prepare(
                    "SELECT COALESCE(SUM(realViews), 0) as total FROM shorts"
                ).first();

                const totalRealViews = (totalVideoViews?.total || 0) + (totalShortViews?.total || 0);

                const pendingReports = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM reports WHERE status = 'pending'"
                ).first();

                const totalReports = await env.DB.prepare(
                    "SELECT COUNT(*) as count FROM reports"
                ).first();

                const dailyStats = await env.DB.prepare(`
                    SELECT 
                        date(addedAt) as date, 
                        COUNT(*) as count,
                        COALESCE(SUM(realViews), 0) as views
                    FROM videos
                    WHERE addedAt >= datetime('now', '-30 days')
                    GROUP BY date(addedAt)
                    ORDER BY date DESC
                    LIMIT 30
                `).all();

                const dailyShortStats = await env.DB.prepare(`
                    SELECT 
                        date(addedAt) as date, 
                        COUNT(*) as count,
                        COALESCE(SUM(realViews), 0) as views
                    FROM shorts
                    WHERE addedAt >= datetime('now', '-30 days')
                    GROUP BY date(addedAt)
                    ORDER BY date DESC
                    LIMIT 30
                `).all();

                return jsonResponse({
                    overview: {
                        totalVideos: videoCount?.count || 0,
                        totalShorts: shortCount?.count || 0,
                        totalCreators: creatorCount?.count || 0,
                        pendingCreators: pendingCreators?.count || 0,
                        totalViews: totalRealViews,
                        totalReports: totalReports?.count || 0,
                        pendingReports: pendingReports?.count || 0
                    },
                    dailyStats: dailyStats?.results || [],
                    dailyShortStats: dailyShortStats?.results || []
                });
            }

            // Update Site Config
            if (path === "/api/admin/config" && method === "PUT") {
                const data = await request.json().catch(() => ({}));

                if (!data || typeof data !== 'object') {
                    return errorResponse("Invalid data format", 400);
                }

                const placementUrls = Array.isArray(data.placementUrls) 
                    ? JSON.stringify(data.placementUrls) 
                    : (data.placementUrls || "[]");

                const outstreamAdTags = Array.isArray(data.outstreamAdTags) 
                    ? JSON.stringify(data.outstreamAdTags) 
                    : (data.outstreamAdTags || "[]");

                try {
                    await env.DB.prepare(`
                        UPDATE site_config SET
                            siteName = ?,
                            siteLogo = ?,
                            vastTagUrl = ?,
                            placementUrls = ?,
                            outstreamAdTags = ?,
                            primaryColor = ?,
                            r2PublicUrl = ?,
                            updatedAt = datetime('now')
                        WHERE id = 1
                    `).bind(
                        data.siteName || "Xplitleaks",
                        data.siteLogo || null,
                        data.vastTagUrl || null,
                        placementUrls,
                        outstreamAdTags,
                        data.primaryColor || "#ff0050",
                        data.r2PublicUrl || null
                    ).run();

                    return jsonResponse({ success: true, message: "Config updated" });
                } catch (error) {
                    console.error("Config update error:", error);
                    return errorResponse("Failed to update config: " + error.message, 500);
                }
            }

            // Get All Creators
            if (path === "/api/admin/creators" && method === "GET") {
                const { results } = await env.DB.prepare(`
                    SELECT 
                        id, 
                        username, 
                        email, 
                        status, 
                        createdAt, 
                        lastLogin,
                        (SELECT COUNT(*) FROM videos WHERE creatorId = creators.id) as videoCount,
                        (SELECT COUNT(*) FROM shorts WHERE creatorId = creators.id) as shortCount
                    FROM creators
                    ORDER BY createdAt DESC
                `).all();

                return jsonResponse(results || []);
            }

            // Update Creator Status
            if (path === "/api/admin/creator/status" && method === "PUT") {
                const { creatorId, status } = await request.json().catch(() => ({}));

                if (!creatorId || !['approved', 'rejected', 'suspended'].includes(status)) {
                    return errorResponse("Invalid parameters", 400);
                }

                await env.DB.prepare(`
                    UPDATE creators SET status = ?, updatedAt = datetime('now') WHERE id = ?
                `).bind(status, creatorId).run();

                return jsonResponse({ success: true, message: `Creator ${status}` });
            }

            // Get All Reports
            if (path === "/api/admin/reports" && method === "GET") {
                const status = url.searchParams.get("status") || 'all';

                let whereClause = "";
                const params = [];

                if (status !== 'all') {
                    whereClause = "WHERE status = ?";
                    params.push(status);
                }

                const { results } = await env.DB.prepare(`
                    SELECT 
                        r.*,
                        CASE 
                            WHEN r.contentType = 'short' THEN 
                                (SELECT title FROM shorts WHERE numericId = r.contentId OR id = r.contentId LIMIT 1)
                            ELSE 
                                (SELECT title FROM videos WHERE numericId = r.contentId OR id = r.contentId LIMIT 1)
                        END as contentTitle
                    FROM reports r
                    ${whereClause}
                    ORDER BY r.createdAt DESC
                    LIMIT 200
                `).bind(...params).all();

                return jsonResponse(results || []);
            }

            // Update Report Status
            if (path === "/api/admin/report/status" && method === "PUT") {
                const { reportId, status } = await request.json().catch(() => ({}));

                if (!reportId || !['pending', 'resolved', 'dismissed'].includes(status)) {
                    return errorResponse("Invalid parameters", 400);
                }

                await env.DB.prepare(`
                    UPDATE reports SET status = ?, resolvedAt = datetime('now') WHERE id = ?
                `).bind(status, reportId).run();

                return jsonResponse({ success: true, message: `Report ${status}` });
            }

            // Delete Video
            if (path === "/api/admin/video/delete" && method === "DELETE") {
                const { id } = await request.json().catch(() => ({}));
                if (!id) {
                    return errorResponse("Video ID required", 400);
                }

                await env.DB.prepare(`
                    UPDATE videos 
                    SET status = 'removed', updatedAt = datetime('now') 
                    WHERE numericId = ? OR id = ?
                `).bind(id, id).run();

                return jsonResponse({ success: true, message: "Video removed" });
            }

            // Delete Short
            if (path === "/api/admin/short/delete" && method === "DELETE") {
                const { id } = await request.json().catch(() => ({}));
                if (!id) {
                    return errorResponse("Short ID required", 400);
                }

                await env.DB.prepare(`
                    UPDATE shorts 
                    SET status = 'removed', updatedAt = datetime('now') 
                    WHERE numericId = ? OR id = ?
                `).bind(id, id).run();

                return jsonResponse({ success: true, message: "Short removed" });
            }

            // ============================================
            // 404 FALLBACK
            // ============================================
            return errorResponse("Endpoint not found", 404);

        } catch (error) {
            console.error("Worker error:", error);
            return errorResponse("Internal server error: " + error.message, 500);
        }
    }
};
