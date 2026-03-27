const cheerio = require('cheerio');
const { htmlClient, cloudGet } = require('./httpClients');
const { parseChapterNumber, titleFromSlug } = require('./textUtils');
const { sourceSlug } = require('./slugUtils');
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

const CHAPTER_SITEMAP_CACHE_TTL_MS = Math.max(10 * 60 * 1000, Number(process.env.SCRAPER_CHAPTER_SITEMAP_CACHE_TTL_MS || 60 * 60 * 1000));
const chapterSitemapIndexCache = { ts: 0, urls: [] };
const chapterSitemapByMangaCache = new Map();

const loadChapterSitemapIndex = async (baseUrl) => {
    const now = Date.now();
    if (chapterSitemapIndexCache.urls.length > 0 && now - chapterSitemapIndexCache.ts < CHAPTER_SITEMAP_CACHE_TTL_MS) {
        return chapterSitemapIndexCache.urls;
    }

    const { data } = await htmlClient.get(`${baseUrl}/sitemap_index.xml`, {
        headers: { Referer: baseUrl },
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

const loadChaptersFromSitemap = async (baseUrl, mangaSlug) => {
    const cacheKey = `${baseUrl}|${mangaSlug}`;
    const now = Date.now();
    const cached = chapterSitemapByMangaCache.get(cacheKey);
    if (cached && now - cached.ts < CHAPTER_SITEMAP_CACHE_TTL_MS) {
        return cached.chapters;
    }

    const sitemapUrls = await loadChapterSitemapIndex(baseUrl);
    const escapedSlug = String(mangaSlug || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(`/manga/${escapedSlug}/([^/?#<]+)`, 'gi');

    let chapterUrls = [];
    for (const sitemapUrl of sitemapUrls) {
        try {
            const { data } = await htmlClient.get(sitemapUrl, {
                headers: { Referer: `${baseUrl}/manga/${mangaSlug}/` },
            });
            const text = String(data || '');
            regex.lastIndex = 0;
            if (!regex.test(text)) continue;
            regex.lastIndex = 0;

            const seen = new Set();
            let match;
            while ((match = regex.exec(text))) {
                const full = String(match[0] || '').trim();
                if (!full || seen.has(full)) continue;
                seen.add(full);
                chapterUrls.push(full);
            }

            if (chapterUrls.length > 0) break;
        } catch (_) {
            // Ignore one sitemap failure and continue with the next.
        }
    }

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
            url: `${baseUrl}/manga/${mangaSlug}/${chapterSlug}/`,
        };
    }).filter((x) => x.chapterSlug);

    chapterSitemapByMangaCache.set(cacheKey, {
        ts: now,
        chapters,
    });

    return chapters;
};

const normalizeDescription = (value) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim();
    if (!text) return '';
    // Ignore CSS/JS-like blobs accidentally captured from inline blocks.
    if ((text.includes('{') && text.includes('}')) || /\.swiper|max-width|padding:\s*\d/i.test(text)) {
        return '';
    }
    return text;
};

const extractChapterSlugFromHref = (href, mangaSlug) => {
    const byLeer = href.match(/\/leer\/([^/?#]+)/i);
    if (byLeer) {
        return {
            chapterSlug: byLeer[1],
            chapterUrl: byLeer[0].startsWith('http') ? byLeer[0] : '',
        };
    }

    const escapedSlug = String(mangaSlug || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const byMangaChapter = escapedSlug
        ? href.match(new RegExp(`/manga/${escapedSlug}/([^/?#]+)`, 'i'))
        : null;
    if (byMangaChapter) {
        return {
            chapterSlug: byMangaChapter[1],
            chapterUrl: '',
        };
    }

    return { chapterSlug: '', chapterUrl: '' };
};

const decodeMowlToken = (token, xorKey = 30) => {
    try {
        const decoded = Buffer.from(String(token || ''), 'base64').toString('binary');
        let out = '';
        for (let i = 0; i < decoded.length; i += 1) {
            out += String.fromCharCode(decoded.charCodeAt(i) ^ xorKey);
        }
        return out;
    } catch (_) {
        return '';
    }
};

const extractMowlImages = ($, baseUrl, html) => {
    const scriptMatch = String(html || '').match(/var\s+_d\s*=\s*(\[[\s\S]*?\]);/i);
    if (!scriptMatch) return [];

    let encoded = [];
    try {
        encoded = JSON.parse(scriptMatch[1]);
    } catch (_) {
        return [];
    }
    if (!Array.isArray(encoded) || encoded.length === 0) return [];

    const decoded = encoded.map((token) => decodeMowlToken(token, 30));
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

    return [...new Set(urls)].map((url) => absoluteUrl(baseUrl, url));
};

const mangaSlugFromReaderSlug = (readerSlug) => {
    const raw = String(readerSlug || '').trim();
    if (!raw) return '';

    // Typical format: "manga-slug-123.00" -> "manga-slug"
    const byChapterNumber = raw.replace(/-\d+(?:\.\d+)?$/i, '');
    if (byChapterNumber && byChapterNumber !== raw) return byChapterNumber;

    return raw;
};

const extractLatestFromChaptersSection = ($, baseUrl, source) => {
    const map = new Map();

    const root = $('.last-chapters-content').first();
    if (!root.length) return [];

    root.find('a[href*="/leer/"]').each((_, a) => {
        const hrefRaw = $(a).attr('href') || '';
        const href = absoluteUrl(baseUrl, hrefRaw);
        const chapterMatch = href.match(/\/leer\/([^/?#]+)/i);
        if (!chapterMatch) return;

        const chapterSlug = chapterMatch[1];
        const mangaSlug = mangaSlugFromReaderSlug(chapterSlug);
        if (!mangaSlug) return;

        const key = `${source}:${mangaSlug}`;
        const card = $(a).closest('article, .card, .item, li, .col, .manga, .row > div');
        const titleCandidate =
            $(a).attr('title') ||
            card.find('h1, h2, h3, h4, .title, .manga-title, .name').first().text().replace(/\s+/g, ' ').trim() ||
            $(a).text().replace(/\s+/g, ' ').trim() ||
            titleFromSlug(mangaSlug);

        const img =
            card.find('img').first().attr('data-src') ||
            card.find('img').first().attr('src') ||
            $(a).find('img').first().attr('data-src') ||
            $(a).find('img').first().attr('src') ||
            '';

        const description = card.find('p, .description, .summary').first().text().replace(/\s+/g, ' ').trim();
        const statusText = card.find('.status, .estado').first().text().trim();
        const genres = card
            .find('a[href*="genre"], a[href*="genero"], .genre, .genero')
            .toArray()
            .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
            .filter(Boolean);

        const status = normalizeStatus(statusText);
        const contentRating = inferContentRating(titleCandidate, description, genres, statusText);

        const prev = map.get(key) || {
            title: titleCandidate,
            slug: sourceSlug(source, mangaSlug),
            source,
            cover: img ? absoluteUrl(baseUrl, img) : '',
            description: description || '',
            totalChapters: 0,
            score: '',
            status,
            country: 'unknown',
            language: 'es-419',
            contentRating,
            genres,
            badges: buildBadges({ status, contentRating }),
            url: `${baseUrl}/manga/${mangaSlug}`,
        };

        if (!prev.title || prev.title === titleFromSlug(mangaSlug)) prev.title = titleCandidate;
        if (!prev.cover && img) prev.cover = absoluteUrl(baseUrl, img);
        if (!prev.description && description) prev.description = description;

        map.set(key, prev);
    });

    return Array.from(map.values());
};

const extractHtmlMangaCards = ($, baseUrl, source) => {
    const map = new Map();

    $('a[href*="/manga/"]').each((_, a) => {
        const hrefRaw = $(a).attr('href') || '';
        const href = absoluteUrl(baseUrl, hrefRaw);
        const slugMatch = href.match(/\/manga\/([^/?#]+)/);
        if (!slugMatch) return;

        const slug = slugMatch[1];
        const key = `${source}:${slug}`;
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

        const description = card.find('p, .description, .summary').first().text().replace(/\s+/g, ' ').trim();
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
            slug: sourceSlug(source, slug),
            source,
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
            url: `${baseUrl}/manga/${slug}`,
        };

        if (!prev.title || prev.title === titleFromSlug(slug)) prev.title = titleCandidate;
        if (!prev.cover && img) prev.cover = absoluteUrl(baseUrl, img);
        if (!prev.description && description) prev.description = description;

        map.set(key, prev);
    });

    return Array.from(map.values());
};

const searchLibrary = async ({ baseUrl, source, query }) => {
    const url = `${baseUrl}/biblioteca?search=${encodeURIComponent(query)}`;
    const { data } = await htmlClient.get(url, {
        headers: { Referer: `${baseUrl}/biblioteca` },
    });
    const $ = cheerio.load(data);
    return extractHtmlMangaCards($, baseUrl, source)
        .filter(item => item.slug && item.title)
        .slice(0, 20);
};

const getMangaDetails = async ({ baseUrl, source, slug, originalToken }) => {
    const mangaUrl = `${baseUrl}/manga/${slug}`;
    const { data } = await htmlClient.get(mangaUrl, {
        headers: { Referer: `${baseUrl}/biblioteca` },
    });
    const $ = cheerio.load(data);

    const title =
        $('h1').first().text().replace(/\s+/g, ' ').trim() ||
        $('meta[property="og:title"]').attr('content') ||
        titleFromSlug(slug);

    const cover =
        $('meta[property="og:image"]').attr('content') ||
        $('.manga-cover img, .cover img, img').first().attr('data-src') ||
        $('.manga-cover img, .cover img, img').first().attr('src') ||
        '';

    const description =
        normalizeDescription($('meta[name="description"]').attr('content')) ||
        normalizeDescription($('.summary__content, .description-summary, .description, .summary, .sinopsis, .content p').first().text()) ||
        '';
    const status = normalizeStatus($('.status, .estado').first().text());
    const genres = $('a[href*="genre"], a[href*="genero"], .genre, .genero')
        .toArray()
        .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const contentRating = inferContentRating(title, description, genres);

    const chapters = [];
    const seen = new Set();

    $('a[href]').each((_, a) => {
        const hrefRaw = $(a).attr('href') || '';
        const href = absoluteUrl(baseUrl, hrefRaw);
        const { chapterSlug } = extractChapterSlugFromHref(href, slug);
        if (!chapterSlug) return;

        if (seen.has(chapterSlug)) return;
        seen.add(chapterSlug);

        const label = $(a).text().replace(/\s+/g, ' ').trim();
        const chapterUrl = /\/leer\//i.test(href)
            ? href
            : `${baseUrl}/manga/${slug}/${chapterSlug}/`;
        chapters.push({
            title: label || `Capitulo ${chapterSlug}`,
            number: parseChapterNumber(label),
            releaseDate: '',
            lang: 'es-419',
            groupName: '',
            chapterSlug,
            mangaSlug: originalToken,
            slug: `${originalToken}/${chapterSlug}`,
            url: chapterUrl,
        });
    });

    // manhwa-online often renders only first/last chapter links in static HTML.
    // Use provider sitemap chapters as fallback to reconstruct "Ultimos Capitulos" accurately.
    if (/manhwa-online\.com$/i.test(String(baseUrl || ''))) {
        try {
            const fromSitemap = await loadChaptersFromSitemap(baseUrl, slug);
            if (fromSitemap.length > chapters.length) {
                const merged = new Map();
                for (const chapter of fromSitemap) {
                    merged.set(chapter.chapterSlug, {
                        ...chapter,
                        mangaSlug: originalToken,
                        slug: `${originalToken}/${chapter.chapterSlug}`,
                    });
                }
                for (const chapter of chapters) {
                    const existing = merged.get(chapter.chapterSlug) || {};
                    const chapterNumber = Number(chapter.number || 0);
                    const hasMeaningfulNumber = Number.isFinite(chapterNumber) && chapterNumber > 0;
                    const cleanTitle = String(chapter.title || '').trim();
                    const hasGenericTitle = /^leer\s+(primero|ultimo)$/i.test(cleanTitle);
                    merged.set(chapter.chapterSlug, {
                        ...existing,
                        ...chapter,
                        number: hasMeaningfulNumber ? chapter.number : existing.number,
                        title: cleanTitle && !hasGenericTitle ? chapter.title : existing.title,
                        chapterSlug: chapter.chapterSlug,
                        mangaSlug: originalToken,
                        slug: `${originalToken}/${chapter.chapterSlug}`,
                    });
                }
                chapters.length = 0;
                chapters.push(...Array.from(merged.values()));
            }
        } catch (err) {
            console.warn('[Manga][html] Chapter sitemap fallback failed:', err.message);
        }
    }

    chapters.sort((a, b) => Number(b.number || 0) - Number(a.number || 0));

    return {
        title,
        altTitles: '',
        cover: absoluteUrl(baseUrl, cover),
        description,
        slug: originalToken,
        source,
        status,
        country: 'unknown',
        language: 'es-419',
        contentRating,
        genres,
        badges: buildBadges({ status, contentRating }),
        authors: [],
        artists: [],
        totalChapters: chapters.length,
        score: '0.0',
        url: mangaUrl,
        chapters,
    };
};

const getChapterImages = async ({ baseUrl, chapterSlug, mangaSlug = '' }) => {
    const isMangaChapterStyle = /^capitulo[-\w.]+$/i.test(String(chapterSlug || ''));
    const readerUrl = isMangaChapterStyle && mangaSlug
        ? `${baseUrl}/manga/${mangaSlug}/${chapterSlug}/`
        : `${baseUrl}/leer/${chapterSlug}`;
    const { data } = await htmlClient.get(readerUrl, {
        headers: { Referer: `${baseUrl}/biblioteca` },
    });
    const $ = cheerio.load(data);

    const mowlImages = extractMowlImages($, baseUrl, data);
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

        const absolute = absoluteUrl(baseUrl, src);
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

const getLatestFromHome = async ({ baseUrl, source }) => {
    const attempts = [
        {
            url: baseUrl,
            headers: { Referer: baseUrl },
        },
        {
            url: `${baseUrl}/home`,
            headers: { Referer: baseUrl },
        },
        {
            url: `${baseUrl}/biblioteca`,
            headers: { Referer: `${baseUrl}/home` },
        },
        {
            url: `${baseUrl}/biblioteca?search=`,
            headers: { Referer: `${baseUrl}/biblioteca` },
        },
    ];

    let lastError = null;
    for (const attempt of attempts) {
        try {
            const { data } = await htmlClient.get(attempt.url, {
                headers: attempt.headers,
            });
            const $ = cheerio.load(data);
            let cards = extractLatestFromChaptersSection($, baseUrl, source).slice(0, 20);
            if (cards.length === 0) {
                cards = extractHtmlMangaCards($, baseUrl, source).slice(0, 20);
            }
            if (cards.length > 0) return cards;
        } catch (err) {
            lastError = err;

            // Fallback for anti-bot protected providers returning 403.
            try {
                const body = await cloudGet(attempt.url, attempt.headers);
                const $ = cheerio.load(body || '');
                let cards = extractLatestFromChaptersSection($, baseUrl, source).slice(0, 20);
                if (cards.length === 0) {
                    cards = extractHtmlMangaCards($, baseUrl, source).slice(0, 20);
                }
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
    searchLibrary,
    getMangaDetails,
    getChapterImages,
    getLatestFromHome,
};
