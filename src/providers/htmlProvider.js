const cheerio = require('cheerio');
const { htmlClient, cloudGet } = require('./httpClients');
const { parseChapterNumber, titleFromSlug } = require('./textUtils');
const { sourceSlug } = require('./slugUtils');
const { absoluteUrl } = require('./urlUtils');
const { SOURCE_LECTORMANGAA } = require('./constants');
const { getHtmlWithBrowser } = require('./browserClient');

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
        const contentRating = /yaoi|yuri|hentai|adult|erot|nsfw/i.test(`${titleCandidate} ${description}`)
            ? 'erotica'
            : 'safe';

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
        $('meta[name="description"]').attr('content') ||
        $('.description, .summary, .sinopsis, .content p').first().text().replace(/\s+/g, ' ').trim() ||
        '';
    const status = normalizeStatus($('.status, .estado').first().text());
    const genres = $('a[href*="genre"], a[href*="genero"], .genre, .genero')
        .toArray()
        .map((el) => $(el).text().replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    const contentRating = /yaoi|yuri|hentai|adult|erot|nsfw/i.test(`${title} ${description}`)
        ? 'erotica'
        : 'safe';

    const chapters = [];
    const seen = new Set();

    $('a[href*="/leer/"]').each((_, a) => {
        const hrefRaw = $(a).attr('href') || '';
        const href = absoluteUrl(baseUrl, hrefRaw);
        const match = href.match(/\/leer\/([^/?#]+)/);
        if (!match) return;

        const chapterSlug = match[1];
        if (seen.has(chapterSlug)) return;
        seen.add(chapterSlug);

        const label = $(a).text().replace(/\s+/g, ' ').trim();
        chapters.push({
            title: label || `Capitulo ${chapterSlug}`,
            number: parseChapterNumber(label),
            releaseDate: '',
            lang: 'es-419',
            groupName: '',
            chapterSlug,
            mangaSlug: originalToken,
            slug: `${originalToken}/${chapterSlug}`,
            url: `${baseUrl}/leer/${chapterSlug}`,
        });
    });

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

const getChapterImages = async ({ baseUrl, chapterSlug }) => {
    const readerUrl = `${baseUrl}/leer/${chapterSlug}`;
    const { data } = await htmlClient.get(readerUrl, {
        headers: { Referer: `${baseUrl}/biblioteca` },
    });
    const $ = cheerio.load(data);

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
            const cards = extractHtmlMangaCards($, baseUrl, source).slice(0, 20);
            if (cards.length > 0) return cards;
        } catch (err) {
            lastError = err;

            // Fallback for anti-bot protected providers returning 403.
            try {
                const body = await cloudGet(attempt.url, attempt.headers);
                const $ = cheerio.load(body || '');
                const cards = extractHtmlMangaCards($, baseUrl, source).slice(0, 20);
                if (cards.length > 0) return cards;
            } catch (cloudErr) {
                lastError = cloudErr;
            }
        }
    }

    // Last-resort fallback for Cloudflare-protected providers.
    if (source === SOURCE_LECTORMANGAA) {
        const browserAttempts = [
            { url: baseUrl, referer: baseUrl },
            { url: `${baseUrl}/home`, referer: baseUrl },
            { url: `${baseUrl}/biblioteca`, referer: `${baseUrl}/home` },
            { url: `${baseUrl}/biblioteca?search=`, referer: `${baseUrl}/biblioteca` },
        ];

        for (const attempt of browserAttempts) {
            try {
                const html = await getHtmlWithBrowser(attempt.url, attempt.referer, source);
                const $ = cheerio.load(html || '');
                const cards = extractHtmlMangaCards($, baseUrl, source).slice(0, 20);
                if (cards.length > 0) {
                    return cards;
                }
            } catch (browserErr) {
                lastError = browserErr;
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
