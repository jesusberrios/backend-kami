const express = require('express');
const NodeCache = require('node-cache');
const { searchManga, getMangaDetails, getMangaChapters, getChapterImages, getLatest, getLatestWithMeta } = require('./scraper');
const { normalizeText } = require('./providers/textUtils');

const app = express();
const cache = new NodeCache({
    stdTTL: 300,
    checkperiod: 120,
    useClones: false,
});
const inFlightByKey = new Map();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const buildQueryCacheKey = (prefix, query) => {
    const q = query || {};
    const keys = Object.keys(q).sort();
    const suffix = keys.map((k) => `${k}=${q[k]}`).join('&');
    return `${prefix}:${suffix}`;
};

const applyListQuery = (items, query = {}) => {
    let list = Array.isArray(items) ? [...items] : [];

    if (query.source) {
        const source = String(query.source).toLowerCase();
        list = list.filter((x) => String(x.source || '').toLowerCase() === source);
    }

    if (query.status) {
        const status = String(query.status).toLowerCase();
        list = list.filter((x) => String(x.status || '').toLowerCase() === status);
    }

    if (query.contentRating) {
        const rating = String(query.contentRating).toLowerCase();
        list = list.filter((x) => String(x.contentRating || '').toLowerCase() === rating);
    }

    if (query.genre) {
        const g = normalizeText(query.genre);
        list = list.filter((x) => Array.isArray(x.genres) && x.genres.some((it) => normalizeText(it).includes(g)));
    }

    if (query.sort === 'title_asc') list.sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
    if (query.sort === 'title_desc') list.sort((a, b) => String(b.title || '').localeCompare(String(a.title || '')));
    if (query.sort === 'score_desc') list.sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
    if (query.sort === 'chapters_desc') list.sort((a, b) => Number(b.totalChapters || 0) - Number(a.totalChapters || 0));

    const limit = Math.max(1, Math.min(50, Number(query.limit || 20)));
    const page = Math.max(1, Number(query.page || 1));
    const total = list.length;
    const offset = (page - 1) * limit;

    return {
        results: list.slice(offset, offset + limit),
        pagination: {
            page,
            limit,
            total,
            totalPages: Math.max(1, Math.ceil(total / limit)),
        },
    };
};

// Middleware de cache
const withCache = (keyFn, options = {}) => async (req, res, next) => {
    const ttlSeconds = Number(options.ttlSeconds || 0);
    const key = keyFn(req);
    const cached = cache.get(key);
    if (cached) {
        console.log(`[Cache] HIT: ${key}`);
        return res.json(cached);
    }

    const inFlight = inFlightByKey.get(key);
    if (inFlight) {
        console.log(`[Cache] INFLIGHT: ${key}`);
        try {
            const shared = await inFlight;
            return res.json(shared);
        } catch (_) {
            // If shared execution failed, continue and retry once in this request.
        }
    }

    let done = false;
    let resolveShared;
    let rejectShared;
    const sharedPromise = new Promise((resolve, reject) => {
        resolveShared = resolve;
        rejectShared = reject;
    });
    inFlightByKey.set(key, sharedPromise);

    const finishWithError = (message) => {
        if (done) return;
        done = true;
        rejectShared(new Error(message));
        if (inFlightByKey.get(key) === sharedPromise) {
            inFlightByKey.delete(key);
        }
    };

    res.sendCached = (data) => {
        if (done) return res.json(data);
        done = true;

        if (ttlSeconds > 0) {
            cache.set(key, data, ttlSeconds);
        } else {
            cache.set(key, data);
        }

        resolveShared(data);
        if (inFlightByKey.get(key) === sharedPromise) {
            inFlightByKey.delete(key);
        }
        res.json(data);
    };

    res.once('close', () => {
        if (!res.writableEnded) {
            finishWithError(`Request closed before cache write for key: ${key}`);
        }
    });

    res.once('finish', () => {
        if (!done && res.statusCode >= 400) {
            finishWithError(`Request failed for key: ${key} (status ${res.statusCode})`);
        }
    });

    next();
};

// ── Health check ──────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'ZonaTMO API', version: '2.0.0' });
});

// ── GET /search?title=xxx ─────────────────────────────────────────
app.get('/search', withCache((req) => buildQueryCacheKey('search', req.query), { ttlSeconds: 600 }), async (req, res) => {
    const { title } = req.query;
    if (!title) return res.status(400).json({ error: 'Parámetro "title" requerido' });

    console.log(`[Search] Buscando: "${title}"`);
    try {
        const results = await searchManga(title);
        const filtered = applyListQuery(results, req.query);
        res.sendCached(filtered);
    } catch (err) {
        console.error('[Search] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /manga/:slug ──────────────────────────────────────────────
app.get('/manga/:slug', withCache((req) => `manga:${req.params.slug}`, { ttlSeconds: 1800 }), async (req, res) => {
    const { slug } = req.params;
    console.log(`[Manga] Detalles de: "${slug}"`);
    try {
        const manga = await getMangaDetails(slug);
        res.sendCached({ manga });
    } catch (err) {
        console.error('[Manga] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /manga/:slug/chapters ─────────────────────────────────────
app.get('/manga/:slug/chapters', withCache((req) => `chapters:${req.params.slug}`, { ttlSeconds: 1800 }), async (req, res) => {
    const { slug } = req.params;
    console.log(`[Chapters] Capítulos de: "${slug}"`);
    try {
        const chapters = await getMangaChapters(slug);
        res.sendCached({ chapters });
    } catch (err) {
        console.error('[Chapters] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

// ── GET /chapter/:mangaSlug/:chapterSlug/images ───────────────────
// compositeSlug = "{manga-slug}/{chapter-slug}"  e.g. jujutsu-kaisen/epilogos
app.get('/chapter/:mangaSlug/:chapterSlug/images',
    withCache((req) => `images:${req.params.mangaSlug}/${req.params.chapterSlug}`, { ttlSeconds: 21600 }),
    async (req, res) => {
        const { mangaSlug, chapterSlug } = req.params;
        const compositeSlug = `${mangaSlug}/${chapterSlug}`;
        console.log(`[Images] Imágenes del capítulo: "${compositeSlug}"`);
        try {
            const images = await getChapterImages(compositeSlug);
            if (!images.length) return res.status(404).json({ error: 'No se encontraron imágenes' });
            res.sendCached({ images });
        } catch (err) {
            console.error('[Images] Error:', err.message);
            res.status(500).json({ error: err.message });
        }
    });

// ── GET /latest ───────────────────────────────────────────────────
app.get('/latest', withCache((req) => buildQueryCacheKey('latest', req.query), { ttlSeconds: 180 }), async (req, res) => {
    console.log('[Latest] Obteniendo manga recientes');
    try {
        const includeMeta = String(req.query.includeMeta || '').toLowerCase() === '1' || String(req.query.includeMeta || '').toLowerCase() === 'true';
        const payload = includeMeta ? await getLatestWithMeta() : { results: await getLatest(), diagnostics: undefined };
        const results = payload.results || [];
        const filtered = applyListQuery(results, req.query);
        if (includeMeta) {
            filtered.diagnostics = payload.diagnostics;
        }
        res.sendCached(filtered);
    } catch (err) {
        console.error('[Latest] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/latest/health', withCache((req) => buildQueryCacheKey('latest-health', req.query), { ttlSeconds: 120 }), async (req, res) => {
    console.log('[Latest][Health] Diagnostico de fuentes');
    try {
        const payload = await getLatestWithMeta();
        res.sendCached(payload.diagnostics);
    } catch (err) {
        console.error('[Latest][Health] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`\n🚀 ZonaTMO API corriendo en http://localhost:${PORT}`);
    console.log(`   GET /search?title=<titulo>`);
    console.log(`   GET /manga/:slug`);
    console.log(`   GET /manga/:slug/chapters`);
    console.log(`   GET /chapter/:mangaSlug/:chapterSlug/images`);
    console.log(`   GET /latest\n`);
    console.log(`   GET /latest?includeMeta=1`);
    console.log(`   GET /latest/health\n`);
});