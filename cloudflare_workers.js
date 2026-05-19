// ============================================
// XPLITLEAKS API - CLOUDFLARE WORKER v3.0
// Complete Backend with D1 + R2 + Creator System
// ============================================

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // ============================================
        // CORS HEADERS - Enhanced for file uploads
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
            // PUBLIC ENDPOINTS - NO AUTH REQUIRED
            // ============================================
            
            // Health Check
            if (path === "/api/health" && method === "GET") {
                return jsonResponse({ 
                    status: "ok", 
                    timestamp: new Date().toISOString(),
                    version: "3.0.0"
                });
            }

            // Get Site Configuration
            if (path === "/api/config" && method === "GET") {
                const config = await env.DB.prepare(
                    "SELECT siteName, siteLogo, vastTagUrl, placementUrls, outstreamAdTags, primaryColor FROM site_config WHERE id = 1"
                ).first();
                
                return jsonResponse(config || {
                    siteName: "Xplitleaks",
                    siteLogo: null,
                    vastTagUrl: null,
                    placementUrls: "[]",
                    outstreamAdTags: "[]",
                    primaryColor: "#ff0050"
                });
            }

            // ============================================
            // VIDEO ENDPOINTS - FIXED
            // ============================================

            // List Videos with Pagination - FIXED
            if (path === "/api/videos" && method === "GET") {
                const page = Math.max(1, parseInt(url.searchParams.get("page")) || 1);
                const limit = Math.min(50, parseInt(url.searchParams.get("limit")) || 12);
                const offset = (page - 1) * limit;
                const search = url.searchParams.get("search") || '';
                const category = url.searchParams.get("category") || 'all';
                
                // Build WHERE clause
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

                // Get total count
                const countResult = await env.DB.prepare(
                    `SELECT COUNT(*) as total FROM videos v ${whereClause}`
                ).bind(...params).first();
                
                // Get videos with display views (fake + real)
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
                    videos: results || [],
                    pagination: {
                        page,
                        limit,
                        total: countResult?.total || 0,
                        totalPages: Math.ceil((countResult?.total || 0) / limit)
                    }
                });
            }

            // Get Single Video - FIXED
            if (path.match(/^\/api\/video\/[a-zA-Z0-9_-]+$/) && method === "GET") {
                const id = path.split("/")[3];
                
                const video = await env.DB.prepare(`
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
                
                // Track view asynchronously (don't wait)
                ctx.waitUntil(
                    env.DB.prepare(`
                        UPDATE videos 
                        SET views = views + 1, realViews = realViews + 1 
                        WHERE numericId = ?
                    `).bind(id).run()
                );
                
                return jsonResponse(video);
            }

            // Track Video View (Detailed)
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
            // SHORTS ENDPOINTS - FIXED
            // ============================================

            // Get Shorts - FIXED
            if (path === "/api/shorts" && method === "GET") {
                const limit = Math.min(20, parseInt(url.searchParams.get("limit")) || 6);
                const excludeIds = url.searchParams.get("exclude")?.split(",").filter(Boolean) || [];
                
                let query = `
                    SELECT 
                        s.*,
                        c.username as creatorName,
                        CASE 
                            WHEN s.realViews >= 1000 THEN s.views
                            ELSE s.fakeViews + s.realViews
                        END as displayViews
                    FROM shorts s
                    LEFT JOIN creators c ON s.creatorId = c.id
                    WHERE s.status = 'active'
                `;
                
                const params = [];
                
                if (excludeIds.length > 0) {
                    const placeholders = excludeIds.map(() => '?').join(',');
                    query += ` AND s.numericId NOT IN (${placeholders})`;
                    params.push(...excludeIds);
                }
                
                query += ` ORDER BY s.engagementScore DESC, s.views DESC LIMIT ?`;
                params.push(limit);
                
                const { results } = await env.DB.prepare(query).bind(...params).all();

                return jsonResponse({
                    shorts: results || [],
                    pagination: { limit }
                });
            }

            // Get Recommended Shorts (Algorithm) - FIXED
            if (path === "/api/shorts/recommend" && method === "GET") {
                const sessionId = url.searchParams.get("sessionId") || getSessionId();
                const limit = parseInt(url.searchParams.get("limit")) || 20;
                const excludeIds = url.searchParams.get("exclude")?.split(",").filter(Boolean) || [];
                
                // Get user history for personalization
                const history = await env.DB.prepare(`
                    SELECT tags, category, shortId 
                    FROM session_history 
                    WHERE sessionId = ? 
                    ORDER BY watchedAt DESC 
                    LIMIT 20
                `).bind(sessionId).all();
                
                const userTags = {};
                const userCategories = {};
                const watchedIds = [];
                
                if (history.results) {
                    history.results.forEach((item, index) => {
                        const weight = Math.max(0.1, 1 - (index * 0.05));
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
                        watchedIds.push(item.shortId);
                    });
                }

                // Build candidate query
                const allExcluded = [...excludeIds, ...watchedIds];
                let query = `
                    SELECT 
                        s.*,
                        c.username as creatorName,
                        (s.likes * 2 + s.shares * 3) / MAX(s.views, 1) as engagementRate,
                        CASE 
                            WHEN s.realViews >= 1000 THEN s.views
                            ELSE s.fakeViews + s.realViews
                        END as displayViews
                    FROM shorts s
                    LEFT JOIN creators c ON s.creatorId = c.id
                    WHERE s.status = 'active'
                `;
                
                const params = [];
                
                if (allExcluded.length > 0) {
                    const placeholders = allExcluded.map(() => '?').join(',');
                    query += ` AND s.numericId NOT IN (${placeholders})`;
                    params.push(...allExcluded);
                }
                
                query += ` ORDER BY s.addedAt DESC LIMIT 50`;
                
                const { results } = await env.DB.prepare(query).bind(...params).all();
                
                if (!results || results.length === 0) {
                    return jsonResponse([]);
                }

                // Score videos
                const scored = results.map(short => {
                    let tagScore = 0;
                    let categoryScore = 0;
                    
                    try {
                        const tags = short.tags ? JSON.parse(short.tags) : [];
                        if (tags.length > 0 && Object.keys(userTags).length > 0) {
                            const matchCount = tags.filter(t => userTags[t]).length;
                            tagScore = matchCount / tags.length;
                        }
                    } catch (e) {}
                    
                    if (short.category && userCategories[short.category]) {
                        categoryScore = Math.min(userCategories[short.category], 1);
                    }
                    
                    const engagementScore = Math.min(short.engagementRate || 0, 1);
                    
                    // Final score
                    const finalScore = Object.keys(userTags).length > 0 ? 
                        (tagScore * 0.5) + (categoryScore * 0.2) + (engagementScore * 0.3) :
                        (engagementScore * 0.5) + (Math.random() * 0.5);
                    
                    return { ...short, score: finalScore };
                });

                // Sort and diversify (max 3 per creator)
                scored.sort((a, b) => b.score - a.score);
                
                const diversified = [];
                const creatorCount = {};
                
                for (const short of scored) {
                    const creatorId = short.creatorId || 'unknown';
                    creatorCount[creatorId] = (creatorCount[creatorId] || 0) + 1;
                    
                    if (creatorCount[creatorId] <= 3) {
                        diversified.push(short);
                    }
                    
                    if (diversified.length >= limit) break;
                }

                return jsonResponse(diversified);
            }

            // Get Single Short - FIXED
            if (path.match(/^\/api\/short\/[a-zA-Z0-9_-]+$/) && method === "GET") {
                const id = path.split("/")[3];
                
                const short = await env.DB.prepare(`
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
                
                return jsonResponse(short);
            }

            // Track Short View - FIXED
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

            // Share Short
            if (path === "/api/short/share" && method === "POST") {
                const { shortId } = await request.json().catch(() => ({}));
                
                if (!shortId) {
                    return errorResponse("Short ID required", 400);
                }

                await env.DB.prepare(`
                    INSERT INTO short_interactions (shortId, sessionId, action, ipAddress, timestamp)
                    VALUES (?, ?, 'share', ?, datetime('now'))
                `).bind(shortId, getSessionId(), getClientIP()).run();
                
                await env.DB.prepare("UPDATE shorts SET shares = shares + 1 WHERE numericId = ?").bind(shortId).run();
                
                return jsonResponse({ success: true, action: "shared" });
            }

            // ============================================
            // CREATOR AUTHENTICATION
            // ============================================

            // Creator Signup - FIXED
            if (path === "/api/creator/signup" && method === "POST") {
                const data = await request.json().catch(() => ({}));
                
                if (!data.username || !data.email || !data.password) {
                    return errorResponse("Username, email, and password required", 400);
                }

                // Check if exists
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
                    data.password, // In production, hash this
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

            // Creator Login - FIXED
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

            // Get Creator Profile - FIXED
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
            // CREATOR UPLOADS - FIXED WITH R2
            // ============================================

            // Upload Video - FIXED with fake views
            if (path === "/api/creator/upload/video" && method === "POST") {
                const creator = await checkCreatorAuth();
                if (!creator) {
                    return errorResponse("Unauthorized", 401);
                }
                
                const data = await request.json().catch(() => ({}));
                
                if (!data.title || !data.videoUrl) {
                    return errorResponse("Title and videoUrl required", 400);
                }

                // Generate IDs
                const maxIdResult = await env.DB.prepare(
                    "SELECT MAX(CAST(numericId AS INTEGER)) as maxId FROM videos"
                ).first();
                const maxId = maxIdResult?.maxId || 0;
                const numericId = String(maxId + 1).padStart(6, "0");
                const urlFriendlyId = data.title.toLowerCase()
                    .replace(/[^a-z0-9]+/g, "-")
                    .substring(0, 50) || `video-${numericId}`;
                
                const now = new Date().toISOString();
                
                // Generate fake views (1000 to 100000)
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

                // Update tag counts
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

            // Upload Short - FIXED with fake views
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
                
                // Generate fake views (1000 to 100000)
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

            // Get Creator Content - FIXED
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
                
                return jsonResponse({ videos, shorts });
            }

            // R2 File Upload - FIXED [^3^][^6^]
            if (path === "/api/upload/file" && method === "POST") {
                // Check auth (creator or admin)
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

                    // Generate unique filename if not provided
                    const finalFilename = filename || `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.]/g, '_')}`;
                    const key = `${storagePath}/${finalFilename}`;

                    // Upload to R2 [^6^]
                    const object = await env.BUCKET.put(key, file.stream(), {
                        httpMetadata: {
                            contentType: file.type || "application/octet-stream"
                        }
                    });

                    // Generate public URL
                    const publicUrl = env.R2_PUBLIC_URL 
                        ? `${env.R2_PUBLIC_URL}/${key}`
                        : `https://${url.hostname}/r2/${key}`;

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
            // ADMIN ENDPOINTS (Require Admin Token) - FIXED
            // ============================================

            if (!checkAdminAuth()) {
                return errorResponse("Unauthorized", 401);
            }

            // Get Admin Stats - FIXED
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

                // Get daily stats with views
                const dailyStats = await env.DB.prepare(`
                    SELECT 
                        date(addedAt) as date, 
                        COUNT(*) as count,
                        SUM(fakeViews) as fakeViews,
                        SUM(realViews) as realViews
                    FROM videos
                    WHERE addedAt >= datetime('now', '-30 days')
                    GROUP BY date(addedAt)
                    ORDER BY date DESC
                    LIMIT 30
                `).all();

                // Calculate total views
                const totalViews = await env.DB.prepare(`
                    SELECT 
                        SUM(CASE WHEN realViews >= 1000 THEN views ELSE fakeViews + realViews END) as totalViews
                    FROM videos
                `).first();

                return jsonResponse({
                    overview: {
                        totalVideos: videoCount?.count || 0,
                        totalShorts: shortCount?.count || 0,
                        totalCreators: creatorCount?.count || 0,
                        pendingCreators: pendingCreators?.count || 0,
                        totalViews: totalViews?.totalViews || 0
                    },
                    dailyStats: dailyStats?.results || []
                });
            }

            // Update Site Config - FIXED
            if (path === "/api/admin/config" && method === "PUT") {
                const data = await request.json().catch(() => ({}));
                
                // Validate data
                if (!data || typeof data !== 'object') {
                    return errorResponse("Invalid data format", 400);
                }

                // Ensure placementUrls and outstreamAdTags are JSON strings
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
                            updatedAt = datetime('now')
                        WHERE id = 1
                    `).bind(
                        data.siteName || "Xplitleaks",
                        data.siteLogo || null,
                        data.vastTagUrl || null,
                        placementUrls,
                        outstreamAdTags,
                        data.primaryColor || "#ff0050"
                    ).run();

                    return jsonResponse({ success: true, message: "Config updated" });
                } catch (error) {
                    console.error("Config update error:", error);
                    return errorResponse("Failed to update config: " + error.message, 500);
                }
            }

            // Get All Creators - FIXED
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

            // Update Creator Status - FIXED
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

            // Delete Video - FIXED
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

            // Delete Short - FIXED
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

            // Enhanced Report System - FIXED
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

                // Validate email if provided
                if (reporterEmail && !reporterEmail.match(/^[^\s@]+@[^\s@]+\.[^\s@]+$/)) {
                    return errorResponse("Invalid email format", 400);
                }
                
                await env.DB.prepare(`
                    INSERT INTO reports (
                        contentId, contentType, reason, details, 
                        reporterEmail, reporterName, reporterPhone,
                        reporterSession, createdAt
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
            // 404 FALLBACK
            // ============================================
            return errorResponse("Endpoint not found", 404);

        } catch (error) {
            console.error("Worker error:", error);
            return errorResponse("Internal server error: " + error.message, 500);
        }
    }
};
