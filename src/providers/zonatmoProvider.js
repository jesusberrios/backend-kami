const cheerio = require('cheerio');
const {
    ZONATMO_BASE,
    ZONATMO_CDN,
    SOURCE_ZONATMO,
} = require('./constants');
const { zonatmoClient, warmUpZonaTmo } = require('./httpClients');
const { normalizeText, titleFromSlug } = require('./textUtils');
const { sourceSlug, parseSourceSlug } = require('./slugUtils');

const normalizeStatus = (value) => {
    const raw = String(value || '').toLowerCase().trim();
    if (!raw) return 'unknown';
    if (raw === '1' || raw.includes('curso') || raw.includes('ongoing')) return 'ongoing';
    if (raw === '2' || raw.includes('complet') || raw.includes('finaliz')) return 'completed';
    if (raw === '3' || raw.includes('cancel')) return 'cancelled';
    if (raw === '4' || raw.includes('hiatus') || raw.includes('pausa')) return 'hiatus';
    return raw;
};

const normalizeContentRating = (value) => {
    const raw = String(value || '').toLowerCase().trim();
    if (!raw) return 'safe';
    if (raw.includes('erot')) return 'erotica';
    if (raw.includes('suggest')) return 'suggestive';
    return 'safe';
};

const normalizeGenres = (value) => {
    if (!value) return [];
    if (Array.isArray(value)) {
        return value
            .map((x) => {
                if (!x) return '';
                if (typeof x === 'string') return x;
                return x.name || x.label || x.slug || '';
            })
            .filter(Boolean);
    }
    if (typeof value === 'string') {
        return value.split(',').map((x) => x.trim()).filter(Boolean);
    }
    return [];
};

const buildBadges = ({ status, contentRating, score }) => {
    const badges = [];
    if (status === 'completed') badges.push('Finalizado');
    if (contentRating === 'erotica') badges.push('18+');
    if (contentRating === 'suggestive') badges.push('Suggestivo');
    if (Number(score || 0) >= 4.5) badges.push('Top');
    return badges;
};

const toMangaCard = (item) => {
    const status = normalizeStatus(item.status || item.publication_status);
    const contentRating = normalizeContentRating(item.content_rating || item.rating);
    const genres = normalizeGenres(item.genres || item.tags || item.categories);
    const country = String(item.country || 'jp').toLowerCase();
    const language = String(item.lang || 'es-419').toLowerCase();
    const score = String(item.score || '0.0');

    return {
        title: item.title || '',
        slug: sourceSlug(SOURCE_ZONATMO, item.slug || ''),
        source: SOURCE_ZONATMO,
        cover: item.cover ? `${ZONATMO_BASE}/wp-content/uploads${item.cover}` : '',
        description: item.overview || '',
        totalChapters: item.total_chapters || 0,
        score,
        status,
        country,
        language,
        contentRating,
        genres,
        badges: buildBadges({ status, contentRating, score }),
        url: `${ZONATMO_BASE}/manga/${item.slug}`,
    };
};

const CATALOG_CACHE_TTL_MS = 30 * 60 * 1000;
let catalogCache = { ts: 0, items: [] };

const parseSitemapUrls = async (url) => {
    const { data } = await zonatmoClient.get(url, {
        headers: { Referer: `${ZONATMO_BASE}/home` },
    });
    const $ = cheerio.load(data, { xmlMode: true });
    const urls = [];
    $('url > loc').each((_, el) => {
        const loc = $(el).text().trim();
        if (loc) urls.push(loc);
    });
    return urls;
};

const loadMangaCatalogFromSitemap = async () => {
    const now = Date.now();
    if (now - catalogCache.ts < CATALOG_CACHE_TTL_MS && catalogCache.items.length > 0) {
        return catalogCache.items;
    }

    const { data } = await zonatmoClient.get(`${ZONATMO_BASE}/wp-sitemap.xml`, {
        headers: { Referer: `${ZONATMO_BASE}/home` },
    });
    const $ = cheerio.load(data, { xmlMode: true });

    const mangaSitemaps = [];
    $('sitemap > loc').each((_, el) => {
        const loc = $(el).text().trim();
        if (loc.includes('manga-sitemap') || loc.includes('wp-sitemap-posts-manga')) {
            mangaSitemaps.push(loc);
        }
    });

    const sitemapResults = await Promise.all(
        mangaSitemaps.map(async (smUrl) => {
            try {
                return await parseSitemapUrls(smUrl);
            } catch (err) {
                console.warn(`[Sitemap] Failed ${smUrl}:`, err.message);
                return [];
            }
        })
    );

    const all = [];
    for (const urls of sitemapResults) {
        for (const loc of urls) {
            const m = loc.match(/\/manga\/([^/]+)\/?$/);
            if (!m) continue;
            const slug = m[1];
            if (!slug || slug === 'manga') continue;

            all.push({
                title: titleFromSlug(slug),
                slug: sourceSlug(SOURCE_ZONATMO, slug),
                source: SOURCE_ZONATMO,
                cover: '',
                description: '',
                totalChapters: 0,
                score: '0.0',
                status: 'unknown',
                country: 'jp',
                language: 'es-419',
                contentRating: 'safe',
                genres: [],
                badges: [],
                url: `${ZONATMO_BASE}/manga/${slug}`,
            });
        }
    }

    const unique = [];
    const seen = new Set();
    for (const item of all) {
        const key = `${item.source}:${item.slug}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(item);
    }

    catalogCache = { ts: now, items: unique };
    console.log(`[Sitemap] Catalog loaded: ${unique.length} manga`);
    return unique;
};

const search = async (title) => {
    await warmUpZonaTmo();

    try {
        const { data } = await zonatmoClient.get(`${ZONATMO_BASE}/wp-api/api/listing/manga`, {
            params: { page: 1, postsPerPage: 20, orderBy: 'ID', order: 'desc', search: title },
            headers: { Referer: `${ZONATMO_BASE}/library` },
        });
        if (!data.error && data.data && data.data.items && data.data.items.length > 0) {
            const results = data.data.items
                .map((item) => toMangaCard(item))
                .filter(item => item.slug);
            if (results.length > 0) return results;
        }
    } catch (err) {
        console.warn('[Search][zonatmo] Listing API failed:', err.message);
    }

    try {
        const catalog = await loadMangaCatalogFromSitemap();
        const q = normalizeText(title);
        const results = catalog
            .filter(item => normalizeText(item.slug).includes(q) || normalizeText(item.title).includes(q))
            .slice(0, 20);
        if (results.length > 0) return results;
    } catch (err) {
        console.warn('[Search][zonatmo] Sitemap fallback failed:', err.message);
    }

    return [];
};

const getMangaDetails = async (mangaToken) => {
    await warmUpZonaTmo();

    const { slug } = parseSourceSlug(mangaToken);
    const mangaUrl = `${ZONATMO_BASE}/manga/${slug}`;
    const apiBase = `${ZONATMO_BASE}/wp-api/api/single/manga/${slug}`;
    console.log(`[Manga][zonatmo] API fetch: ${apiBase}`);

    let title = '';
    let altTitles = '';
    let cover = '';
    let description = '';
    let status = 'unknown';
    let country = 'jp';
    let language = 'es-419';
    let contentRating = 'safe';
    let score = '0.0';
    let genres = [];
    let authors = [];
    let artists = [];

    try {
        const { data: meta } = await zonatmoClient.get(apiBase, {
            headers: { Referer: `${ZONATMO_BASE}/home` },
        });
        if (!meta.error && meta.data) {
            const d = meta.data;
            title = d.title || '';
            altTitles = Array.isArray(d.alt_titles) ? d.alt_titles.join('; ') : (d.alt_titles || '');
            cover = d.cover ? `${ZONATMO_BASE}/wp-content/uploads${d.cover}` : '';
            description = d.overview || '';
            status = normalizeStatus(d.status || d.publication_status);
            country = String(d.country || 'jp').toLowerCase();
            language = String(d.lang || d.language || 'es-419').toLowerCase();
            contentRating = normalizeContentRating(d.content_rating || d.rating);
            score = String(d.score || '0.0');
            genres = normalizeGenres(d.genres || d.tags || d.categories);
            authors = normalizeGenres(d.authors);
            artists = normalizeGenres(d.artists);
        }
    } catch (err) {
        console.warn('[Manga][zonatmo] Metadata API failed:', err.message);
    }

    const chapters = [];
    let page = 1;
    let totalPages = 1;

    do {
        try {
            const { data: chData } = await zonatmoClient.get(`${apiBase}/chapters`, {
                params: { page, postsPerPage: 50, order: 'desc' },
                headers: { Referer: mangaUrl },
            });
            if (!chData.error && chData.data) {
                for (const item of (chData.data.items || [])) {
                    chapters.push({
                        title: item.title,
                        number: item.chapter_number,
                        releaseDate: item.release_date,
                        lang: language,
                        groupName: String(item.group_name || ''),
                        chapterSlug: item.slug,
                        mangaSlug: mangaToken,
                        slug: `${mangaToken}/${item.slug}`,
                        url: `${ZONATMO_BASE}/manga/${slug}/${item.slug}`,
                    });
                }
                totalPages = chData.data.pagination ? chData.data.pagination.total_pages || 1 : 1;
            }
        } catch (err) {
            console.warn(`[Manga][zonatmo] Chapters API page ${page} failed:`, err.message);
            break;
        }
        page++;
    } while (page <= totalPages);

    if (!title) {
        try {
            const catalog = await loadMangaCatalogFromSitemap();
            const item = catalog.find(i => parseSourceSlug(i.slug).slug === slug && i.source === SOURCE_ZONATMO);
            title = item ? item.title : titleFromSlug(slug);
            cover = cover || (item ? item.cover || '' : '');
        } catch (err) {
            console.warn('[Manga][zonatmo] Catalog fallback failed:', err.message);
            title = titleFromSlug(slug);
        }
    }

    console.log(`[Manga][zonatmo] "${title}" - ${chapters.length} chapters`);
    return {
        title,
        altTitles,
        cover,
        description,
        slug: mangaToken,
        source: SOURCE_ZONATMO,
        status,
        country,
        language,
        contentRating,
        genres,
        score,
        badges: buildBadges({ status, contentRating, score }),
        authors,
        artists,
        totalChapters: chapters.length,
        url: mangaUrl,
        chapters,
    };
};

const getChapterImages = async (mangaSlug, chapterSlug, compositeSlugForLogs) => {
    await warmUpZonaTmo();

    const apiUrl = `${ZONATMO_BASE}/wp-api/api/single/manga/${mangaSlug}/${chapterSlug}`;
    console.log(`[Chapter][zonatmo] API fetch: ${apiUrl}`);

    const { data } = await zonatmoClient.get(apiUrl, {
        headers: { Referer: `${ZONATMO_BASE}/manga/${mangaSlug}/${chapterSlug}` },
    });

    if (data.error || !data.data || !data.data.chapter) {
        console.warn(`[Chapter][zonatmo] API returned no chapter data for "${compositeSlugForLogs}"`);
        return [];
    }

    const chapter = data.data.chapter;
    const jit = chapter.jit || '';
    return (chapter.images || [])
        .sort((a, b) => a.page_number - b.page_number)
        .map(img => ({
            url: `${ZONATMO_CDN}/manga/${jit}/${img.image_url}`,
            page: img.page_number,
        }));
};

const getLatest = async () => {
    await warmUpZonaTmo();

    try {
        const { data } = await zonatmoClient.get(`${ZONATMO_BASE}/wp-api/api/tops/views/week`, {
            params: { postType: 'any', postsPerPage: 20 },
            headers: { Referer: `${ZONATMO_BASE}/home` },
        });
        if (!data.error && data.data && data.data.items && data.data.items.length > 0) {
            return data.data.items.map((item) => toMangaCard(item));
        }
    } catch (err) {
        console.warn('[Latest][zonatmo] Tops API failed:', err.message);
    }

    try {
        const catalog = await loadMangaCatalogFromSitemap();
        return catalog.slice(0, 20);
    } catch (err) {
        console.warn('[Latest][zonatmo] Sitemap fallback failed:', err.message);
    }

    return [];
};

module.exports = {
    search,
    getMangaDetails,
    getChapterImages,
    getLatest,
};
