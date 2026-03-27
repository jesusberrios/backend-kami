const cheerio = require('cheerio');
const { htmlClient, cloudGet } = require('./httpClients');
const { SOURCE_MANHWAONLINE, MANHWAONLINE_BASE } = require('./constants');
const { parseChapterNumber, titleFromSlug } = require('./textUtils');
const { sourceSlug, parseSourceSlug } = require('./slugUtils');
const { absoluteUrl } = require('./urlUtils');

const ADULT_HINTS_REGEX = /\b(18\+|\+18|adult|adults|hentai|ecchi|smut|nsfw|porn|sex|erot|yaoi|yuri|doujin|doujinshi|manhwa\s*adulto?)\b/i;

const normalizeStatus = (value) => {
    const raw = String(value || '').toLowerCase().trim();
    if (!raw) return 'unknown';
    if (raw.includes('complet') || raw.includes('finaliz')) return 'completed';
    if (raw.includes('curso') || raw.includes('ongoing')) return 'ongoing';
    if (raw.includes('pausa') || raw.includes('hiatus')) return 'hiatus';
    if (raw.includes('cancel')) return 'cancelled';
    return raw;
};

const buildBadges = ({ status, contentRating }) => {
    const badges = [];
    if (status === 'completed') badges.push('Finalizado');
    if (contentRating === 'erotica') badges.push('18+');
    return badges;
};

const inferContentRating = (...values) => {
    const text = values
        .flatMap((value) => {
            if (!value) return [];
            if (Array.isArray(value)) return value;
            if (typeof value === 'object') {
                return [value.name, value.label, value.slug, value.text, value.title, value.value];
            }
            return [value];
        })
        .map((x) => String(x || '').toLowerCase())
        .join(' ');

    return ADULT_HINTS_REGEX.test(text) ? 'erotica' : 'safe';
};

const normalizeDescription = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    if ((text.includes('{') && text.includes('}')) || /\.swiper|max-width|padding:\s*\d/i.test(text)) {
        return '';
    }
    return text;
};

const isGenericChapterLabel = (value) => {
    const normalized = String(value || '')
        .trim()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase();
    return /^leer\s+(primero|ultimo)$/.test(normalized);
};

const chapterTitleFromSlug = (chapterSlug) => {
    const pretty = titleFromSlug(chapterSlug).replace(/^capitulo[-\s]*/i, 'Capitulo ');
    return pretty || `Capitulo ${chapterSlug}`;
};

const CHAPTER_SITEMAP_CACHE_TTL_MS = Math.max(10 * 60 * 1000, Number(process.env.SCRAPER_CHAPTER_SITEMAP_CACHE_TTL_MS || 60 * 60 * 1000));
const chapterSitemapIndexCache = { ts: 0, urls: [] };
const chapterSitemapByMangaCache = new Map();

// ── Manga catalogue sitemap cache (wp-manga-sitemap.xml) ──────────────────────
const MANGA_SITEMAP_CACHE_TTL_MS = Math.max(30 * 60 * 1000, Number(process.env.SCRAPER_MANGA_SITEMAP_CACHE_TTL_MS || 2 * 60 * 60 * 1000));
const mangaSitemapCache = { ts: 0, items: [] };

/** Load and cache the full manga catalogue from wp-manga-sitemap.xml */
const loadMangaSitemap = async () => {
    const now = Date.now();
    if (mangaSitemapCache.items.length > 0 && now - mangaSitemapCache.ts < MANGA_SITEMAP_CACHE_TTL_MS) {
        return mangaSitemapCache.items;
    }

    const { data } = await htmlClient.get(`${MANHWAONLINE_BASE}/wp-manga-sitemap.xml`, {
        headers: { Referer: MANHWAONLINE_BASE },
    });

    const xml = String(data || '');
    const urlBlocks = xml.match(/<url>[\s\S]*?<\/url>/gi) || [];
    const items = [];

    for (const block of urlBlocks) {
        const locM = block.match(/<loc>(https?:\/\/manhwa-online\.com\/manga\/([^/?#<"]+))\/?[\s\S]*?<\/loc>/i);
        if (!locM) continue;
        const mangaUrl = locM[1];
        const slug = locM[2];
        const coverM = block.match(/<image:loc>([^<]+)<\/image:loc>/i);
        const cover = coverM ? coverM[1].trim() : '';
        items.push({ slug, url: mangaUrl, cover });
    }

    mangaSitemapCache.ts = now;
    mangaSitemapCache.items = items;
    return items;
};

/**
 * Fuzzy-match query words against a slug/title.
 * Returns a score 0-1; 1 = all words matched.
 */
const fuzzyMatchScore = (query, slug) => {
    const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return 0;
    const target = String(slug || '').toLowerCase().replace(/-/g, ' ');
    let matched = 0;
    for (const w of words) {
        if (target.includes(w)) matched += 1;
    }
    return matched / words.length;
};

const loadChapterSitemapIndex = async () => {
    const now = Date.now();
    if (chapterSitemapIndexCache.urls.length > 0 && now - chapterSitemapIndexCache.ts < CHAPTER_SITEMAP_CACHE_TTL_MS) {
        return chapterSitemapIndexCache.urls;
    }

    const { data } = await htmlClient.get(`${MANHWAONLINE_BASE}/sitemap_index.xml`, {
        headers: { Referer: MANHWAONLINE_BASE },
    });

    const $ = cheerio.load(data, { xmlMode: true });
    const urls = [];
    $('sitemap > loc').each((_, el) => {
        const loc = $(el).text().trim();
        if (/wp-manga-chapters-sitemap/i.test(loc)) {
            urls.push(loc);
        }
    });

    chapterSitemapIndexCache.ts = now;
    chapterSitemapIndexCache.urls = urls;
    return urls;
};

const loadChaptersFromSitemap = async (mangaSlug) => {
    const cacheKey = `${MANHWAONLINE_BASE}|${mangaSlug}`;
    const now = Date.now();
    const cached = chapterSitemapByMangaCache.get(cacheKey);
    if (cached && now - cached.ts < CHAPTER_SITEMAP_CACHE_TTL_MS) {
        return cached.chapters;
    }

    const sitemapUrls = await loadChapterSitemapIndex();
    const escapedSlug = String(mangaSlug || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`/manga/${escapedSlug}/([^/?#<]+)`, 'gi');

    const chapterUrlSet = new Set();
    for (const sitemapUrl of sitemapUrls) {
        try {
            const { data } = await htmlClient.get(sitemapUrl, {
                headers: { Referer: `${MANHWAONLINE_BASE}/manga/${mangaSlug}/` },
            });
            const text = String(data || '');
            regex.lastIndex = 0;
            if (!regex.test(text)) continue;
            regex.lastIndex = 0;

            let match;
            while ((match = regex.exec(text))) {
                const full = String(match[0] || '').trim();
                if (!full) continue;
                chapterUrlSet.add(full);
            }
        } catch (_) {
            // Continue with next sitemap.
        }
    }

    const chapterUrls = Array.from(chapterUrlSet);

    const chapters = chapterUrls.map((url) => {
        const m = String(url).match(new RegExp(`/manga/${escapedSlug}/([^/?#<]+)`, 'i'));
        const chapterSlug = m ? m[1] : '';
        const label = titleFromSlug(chapterSlug).replace(/^capitulo[-\s]*/i, 'Capitulo ');
        return {
            chapterSlug,
            title: label || `Capitulo ${chapterSlug}`,
            number: parseChapterNumber(label || chapterSlug),
            releaseDate: '',
            lang: 'es-419',
            groupName: '',
            url: `${MANHWAONLINE_BASE}/manga/${mangaSlug}/${chapterSlug}/`,
        };
    }).filter((x) => x.chapterSlug);

    chapterSitemapByMangaCache.set(cacheKey, {
        ts: now,
        chapters,
    });

    return chapters;
};

const extractMowlImages = ($, html) => {
    const scriptMatch = String(html || '').match(/var\s+_d\s*=\s*(\[[\s\S]*?\]);/i);
    if (!scriptMatch) return [];

    const keyMatch = String(html || '').match(/return\s*\(a\^(\d+)\)\^a/i);
    const xorKey = keyMatch ? Number(keyMatch[1]) : 30;

    let encoded = [];
    try {
        encoded = JSON.parse(scriptMatch[1]);
    } catch (_) {
        return [];
    }
    if (!Array.isArray(encoded) || encoded.length === 0) return [];

    const decodeMowlToken = (token, key) => {
        try {
            const decoded = Buffer.from(String(token || ''), 'base64').toString('binary');
            let out = '';
            for (let i = 0; i < decoded.length; i += 1) {
                out += String.fromCharCode(decoded.charCodeAt(i) ^ key);
            }
            return out;
        } catch (_) {
            return '';
        }
    };

    const decoded = encoded.map((token) => decodeMowlToken(token, xorKey));
    const urls = [];

    $('.wp-manga-chapter-img').each((_, img) => {
        const src = String($(img).attr('src') || $(img).attr('data-src') || '');
        const m = src.match(/#mowl-(\d+)/i);
        if (!m) return;
        const idx = Number(m[1]);
        const real = decoded[idx] || '';
        if (real && /^https?:\/\//i.test(real)) {
            urls.push(real);
        }
    });

    return [...new Set(urls)];
};

const extractHtmlMangaCards = ($) => {
    const map = new Map();

    $('a[href*="/manga/"]').each((_, a) => {
        const hrefRaw = $(a).attr('href') || '';
        const href = absoluteUrl(MANHWAONLINE_BASE, hrefRaw);
        const slugMatch = href.match(/\/manga\/([^/?#]+)/);
        if (!slugMatch) return;

        const slug = slugMatch[1];
        const key = `${SOURCE_MANHWAONLINE}:${slug}`;
        const card = $(a).closest('article, .card, .item, li, .col, .manga, .row > div');
        const linkText = $(a).text().replace(/\s+/g, ' ').trim();
        const titleAttr = $(a).attr('title') || '';

        const titleCandidate =
            titleAttr ||
            linkText ||
            card.find('h1, h2, h3, h4, .title, .manga-title, .name').first().text().replace(/\s+/g, ' ').trim() ||
            titleFromSlug(slug);

        const img =
            $(a).find('img').first().attr('data-src') ||
            $(a).find('img').first().attr('src') ||
            card.find('img').first().attr('data-src') ||
            card.find('img').first().attr('src') ||
            '';

        const description = normalizeDescription(card.find('p, .description, .summary').first().text());
        const statusText = card.find('.status, .estado').first().text().trim();
        const genres = card
            .find('a[href*="genre"], a[href*="genero"], .genre, .genero')
            .toArray()
            .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
            .filter(Boolean);

        const status = normalizeStatus(statusText);
        const contentRating = inferContentRating(titleCandidate, description, genres, statusText);

        const prev = map.get(key) || {
            title: '',
            slug: sourceSlug(SOURCE_MANHWAONLINE, slug),
            source: SOURCE_MANHWAONLINE,
            cover: '',
            description: '',
            totalChapters: 0,
            score: '',
            status,
            country: 'unknown',
            language: 'es-419',
            contentRating,
            genres,
            badges: buildBadges({ status, contentRating }),
            url: `${MANHWAONLINE_BASE}/manga/${slug}`,
        };

        if (!prev.title || prev.title === titleFromSlug(slug)) prev.title = titleCandidate;
        if (!prev.cover && img) prev.cover = absoluteUrl(MANHWAONLINE_BASE, img);
        if (!prev.description && description) prev.description = description;

        map.set(key, prev);
    });

    return Array.from(map.values());
};

const extractLatestFromHome = ($) => {
    const cards = extractHtmlMangaCards($);
    return cards.slice(0, 20);
};

/**
 * Build a card object from a sitemap entry so it can be merged with HTML results.
 */
const sitemapEntryToCard = (entry) => {
    const title = titleFromSlug(entry.slug);
    return {
        title,
        slug: sourceSlug(SOURCE_MANHWAONLINE, entry.slug),
        source: SOURCE_MANHWAONLINE,
        cover: entry.cover || '',
        description: '',
        totalChapters: 0,
        score: '',
        status: 'unknown',
        country: 'unknown',
        language: 'es-419',
        contentRating: inferContentRating(title),
        genres: [],
        badges: [],
        url: entry.url || `${MANHWAONLINE_BASE}/manga/${entry.slug}`,
    };
};

/**
 * Search mangas on manhwa-online.
 * Primary strategy: scrape /biblioteca?search=<query> HTML.
 * Fallback strategy: fuzzy-match all query words against the manga catalogue
 *   cached from wp-manga-sitemap.xml.  This recovers titles that the site's
 *   search engine misses (e.g. "the ghost of nocturne").
 *
 * Both strategies run in PARALLEL and results are merged:
 *   - Sitemap hits with score >= threshold are always included.
 *   - HTML results are added after, deduped by slug.
 *   - Total capped at 20, sitemap hits take priority when the query is specific.
 */
const search = async (query) => {
    const queryWords = String(query || '').toLowerCase().split(/\s+/).filter(w => w.length > 1);
    const isSpecificQuery = queryWords.length >= 2;

    // Run both in parallel
    const [htmlCards, sitemapItems] = await Promise.allSettled([
        // HTML search
        (async () => {
            const url = `${MANHWAONLINE_BASE}/biblioteca?search=${encodeURIComponent(query)}`;
            const { data } = await htmlClient.get(url, {
                headers: { Referer: `${MANHWAONLINE_BASE}/biblioteca` },
            });
            const $ = cheerio.load(data);
            return extractHtmlMangaCards($).filter((item) => item.slug && item.title);
        })(),
        // Sitemap fuzzy search
        (async () => {
            if (!queryWords.length) return [];
            const catalogue = await loadMangaSitemap();
            const MIN_SCORE = isSpecificQuery ? 0.5 : 1.0;

            return catalogue
                .map((entry) => ({ entry, score: fuzzyMatchScore(query, entry.slug) }))
                .filter(({ score }) => score >= MIN_SCORE)
                .sort((a, b) => b.score - a.score)
                .slice(0, 15)
                .map(({ entry }) => entry);
        })(),
    ]);

    const seen = new Set();
    const results = [];

    const pushCard = (card) => {
        if (!card || !card.slug) return;
        if (seen.has(card.slug)) return;
        seen.add(card.slug);
        results.push(card);
    };

    // Priority 1: sitemap hits (these are specific, relevant matches)
    const sitemapHits = sitemapItems.status === 'fulfilled' ? sitemapItems.value : [];
    for (const entry of sitemapHits) {
        pushCard(sitemapEntryToCard(entry));
    }

    // Priority 2: HTML search cards (may be relevant, may be homepage noise)
    const htmlResults = htmlCards.status === 'fulfilled' ? htmlCards.value : [];
    for (const card of htmlResults) {
        pushCard(card);
    }

    return results.slice(0, 20);
};

const getMangaDetails = async (mangaToken) => {
    const { slug } = parseSourceSlug(mangaToken);
    const mangaUrl = `${MANHWAONLINE_BASE}/manga/${slug}`;

    // ── Attempt to fetch & parse the manga HTML page ──────────────────────────
    // Wrap in try/catch:  manhwa-online sometimes returns 403 (Cloudflare) from
    // certain server IPs (e.g. Railway).  When that happens we fall back to the
    // sitemap catalogue entry so the detail screen loads instead of showing 500.
    let title = '';
    let cover = '';
    let description = '';
    let status = 'unknown';
    let genres = [];
    let htmlChapters = [];
    let htmlFetchFailed = false;

    try {
        const { data } = await htmlClient.get(mangaUrl, {
            headers: { Referer: `${MANHWAONLINE_BASE}/biblioteca` },
        });
        const $ = cheerio.load(data);

        title =
            $('h1').first().text().replace(/\s+/g, ' ').trim() ||
            $('meta[property="og:title"]').attr('content') ||
            '';

        cover =
            $('meta[property="og:image"]').attr('content') ||
            $('.manga-cover img, .cover img, img').first().attr('data-src') ||
            $('.manga-cover img, .cover img, img').first().attr('src') ||
            '';

        description =
            normalizeDescription($('meta[name="description"]').attr('content')) ||
            normalizeDescription($('.summary__content, .description-summary, .description, .summary, .sinopsis, .content p').first().text()) ||
            '';

        status = normalizeStatus($('.status, .estado').first().text());
        genres = $('a[href*="genre"], a[href*="genero"], .genre, .genero')
            .toArray()
            .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
            .filter(Boolean);
        genres = [...new Set(genres)];

        const seen = new Set();
        $('a[href]').each((_, a) => {
            const hrefRaw = $(a).attr('href') || '';
            const href = absoluteUrl(MANHWAONLINE_BASE, hrefRaw);
            const m = href.match(new RegExp(`/manga/${String(slug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/([^/?#]+)`, 'i'));
            if (!m) return;
            const chapterSlug = m[1];
            if (!/^capitulo[-\w.]+$/i.test(chapterSlug)) return;
            if (seen.has(chapterSlug)) return;
            seen.add(chapterSlug);
            const label = $(a).text().replace(/\s+/g, ' ').trim();
            htmlChapters.push({
                chapterSlug,
                title: label || `Capitulo ${chapterSlug}`,
                number: parseChapterNumber(label || chapterSlug),
                releaseDate: '',
                lang: 'es-419',
                groupName: '',
                url: `${MANHWAONLINE_BASE}/manga/${slug}/${chapterSlug}/`,
            });
        });
    } catch (fetchErr) {
        console.warn(`[Manga][manhwaonline] HTML fetch failed for "${slug}":`, fetchErr.message);
        htmlFetchFailed = true;
    }

    // ── Fallback: fill title/cover from sitemap cache when HTML failed ─────────
    if (htmlFetchFailed || !title || !cover) {
        try {
            const catalogue = await loadMangaSitemap();
            const entry = catalogue.find((e) => e.slug === slug);
            if (entry) {
                if (!title) title = titleFromSlug(entry.slug);
                if (!cover) cover = entry.cover || '';
            }
        } catch (_) { /* non-critical */ }
    }
    if (!title) title = titleFromSlug(slug);

    const contentRating = inferContentRating(title, description, genres);
    let chapters = htmlChapters;

    const shouldLoadSitemapChapters = (() => {
        if (htmlFetchFailed) return true;
        if (!htmlChapters.length) return true;
        if (htmlChapters.length <= 2) return true;
        const hasGenericOrWeakTitle = htmlChapters.some((chapter) => {
            const cleanTitle = String(chapter.title || '').trim();
            if (!cleanTitle) return true;
            if (isGenericChapterLabel(cleanTitle)) return true;
            const number = Number(chapter.number || 0);
            return !Number.isFinite(number) || number <= 0;
        });
        return hasGenericOrWeakTitle;
    })();

    if (shouldLoadSitemapChapters) {
        try {
            const sitemapChapters = await loadChaptersFromSitemap(slug);
            const merged = new Map();
            for (const chapter of sitemapChapters) {
                merged.set(chapter.chapterSlug, {
                    ...chapter,
                    mangaSlug: mangaToken,
                    slug: `${mangaToken}/${chapter.chapterSlug}`,
                });
            }
            for (const chapter of chapters) {
                const existing = merged.get(chapter.chapterSlug) || {};
                const chapterNumber = Number(chapter.number || 0);
                const hasMeaningfulNumber = Number.isFinite(chapterNumber) && chapterNumber > 0;
                const cleanTitle = String(chapter.title || '').trim();
                const hasGenericTitle = isGenericChapterLabel(cleanTitle);
                merged.set(chapter.chapterSlug, {
                    ...existing,
                    ...chapter,
                    number: hasMeaningfulNumber ? chapter.number : existing.number,
                    title: cleanTitle && !hasGenericTitle ? chapter.title : existing.title,
                    chapterSlug: chapter.chapterSlug,
                    mangaSlug: mangaToken,
                    slug: `${mangaToken}/${chapter.chapterSlug}`,
                });
            }
            if (merged.size > 0) {
                chapters = Array.from(merged.values());
            }
        } catch (err) {
            console.warn('[Manga][manhwaonline] Chapter sitemap fallback failed:', err.message);
        }
    }

    chapters = chapters
        .map((chapter) => {
            const currentTitle = String(chapter.title || '').trim();
            const cleanTitle = (!currentTitle || isGenericChapterLabel(currentTitle))
                ? chapterTitleFromSlug(chapter.chapterSlug)
                : currentTitle;
            const currentNumber = Number(chapter.number || 0);
            const chapterNumber = Number.isFinite(currentNumber) && currentNumber > 0
                ? chapter.number
                : parseChapterNumber(cleanTitle || chapter.chapterSlug);
            return {
                ...chapter,
                title: cleanTitle,
                number: chapterNumber,
                mangaSlug: mangaToken,
                slug: `${mangaToken}/${chapter.chapterSlug}`,
            };
        })
        .sort((a, b) => Number(b.number || 0) - Number(a.number || 0));

    return {
        title,
        altTitles: '',
        cover: absoluteUrl(MANHWAONLINE_BASE, cover),
        description,
        slug: mangaToken,
        source: SOURCE_MANHWAONLINE,
        status,
        country: 'unknown',
        language: 'es-419',
        contentRating,
        genres,
        badges: [...new Set(buildBadges({ status, contentRating }))],
        authors: [],
        artists: [],
        totalChapters: chapters.length,
        score: '0.0',
        url: mangaUrl,
        chapters,
    };
};

const getChapterImages = async (mangaSlug, chapterSlug) => {
    const readerUrl = `${MANHWAONLINE_BASE}/manga/${mangaSlug}/${chapterSlug}/`;
    const { data } = await htmlClient.get(readerUrl, {
        headers: { Referer: `${MANHWAONLINE_BASE}/biblioteca` },
    });
    const $ = cheerio.load(data);

    const mowlImages = extractMowlImages($, data);
    if (mowlImages.length > 0) {
        return mowlImages.map((url, idx) => ({ url, page: idx + 1 }));
    }

    const candidates = [];
    $('img').each((_, img) => {
        const src =
            $(img).attr('data-src') ||
            $(img).attr('data-lazy-src') ||
            $(img).attr('src') ||
            '';
        if (!src) return;

        const absolute = absoluteUrl(MANHWAONLINE_BASE, src);
        const isPageImage =
            /\/content\//i.test(absolute) ||
            /\/chapter\//i.test(absolute) ||
            /\/uploads\/manga\//i.test(absolute) ||
            /\.(?:jpg|jpeg|png|webp)$/i.test(absolute);

        if (isPageImage && !/logo|discord|favicon/i.test(absolute)) {
            candidates.push(absolute);
        }
    });

    const unique = [...new Set(candidates)];
    return unique.map((url, idx) => ({ url, page: idx + 1 }));
};

const getLatest = async () => {
    const attempts = [
        { url: MANHWAONLINE_BASE, headers: { Referer: MANHWAONLINE_BASE } },
        { url: `${MANHWAONLINE_BASE}/home`, headers: { Referer: MANHWAONLINE_BASE } },
        { url: `${MANHWAONLINE_BASE}/biblioteca`, headers: { Referer: `${MANHWAONLINE_BASE}/home` } },
        { url: `${MANHWAONLINE_BASE}/biblioteca?search=`, headers: { Referer: `${MANHWAONLINE_BASE}/biblioteca` } },
    ];

    let lastError = null;
    for (const attempt of attempts) {
        try {
            const { data } = await htmlClient.get(attempt.url, { headers: attempt.headers });
            const $ = cheerio.load(data);
            const cards = extractLatestFromHome($);
            if (cards.length > 0) return cards;
        } catch (err) {
            lastError = err;
            try {
                const body = await cloudGet(attempt.url, attempt.headers);
                const $ = cheerio.load(body || '');
                const cards = extractLatestFromHome($);
                if (cards.length > 0) return cards;
            } catch (cloudErr) {
                lastError = cloudErr;
            }
        }
    }

    if (lastError) throw lastError;
    return [];
};

module.exports = {
    search,
    getMangaDetails,
    getChapterImages,
    getLatest,
};
