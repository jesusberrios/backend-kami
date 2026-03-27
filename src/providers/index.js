const {
    SOURCE_ZONATMO,
    SOURCE_VISORMANGA,
    SOURCE_MANHWAONLINE,
    VISORMANGA_BASE,
} = require('./constants');
const { parseSourceSlug, splitCompositeSlug } = require('./slugUtils');
const zonatmoProvider = require('./zonatmoProvider');
const htmlProvider = require('./htmlProvider');
const manhwaonlineProvider = require('./manhwaonlineProvider');

const interleaveBySource = (items, maxItems = 20, options = {}) => {
    const reserveQuota = options.reserveQuota !== false;
    const bySource = new Map();
    const sourceOrder = [];

    for (const item of items || []) {
        const source = String(item?.source || SOURCE_ZONATMO).toLowerCase();
        if (!bySource.has(source)) {
            bySource.set(source, []);
            sourceOrder.push(source);
        }
        bySource.get(source).push(item);
    }

    const merged = [];
    if (reserveQuota && sourceOrder.length > 1 && maxItems > 0) {
        const activeSources = sourceOrder.filter((source) => {
            const queue = bySource.get(source);
            return Array.isArray(queue) && queue.length > 0;
        });

        if (activeSources.length > 1) {
            const perSourceQuota = Math.max(1, Math.floor(maxItems / activeSources.length));
            const quotaTaken = new Map(activeSources.map((source) => [source, 0]));

            while (merged.length < maxItems) {
                let pushedInRound = false;
                for (const source of activeSources) {
                    const queue = bySource.get(source);
                    const taken = quotaTaken.get(source) || 0;
                    if (!queue || queue.length === 0) continue;
                    if (taken >= perSourceQuota) continue;

                    merged.push(queue.shift());
                    quotaTaken.set(source, taken + 1);
                    pushedInRound = true;
                    if (merged.length >= maxItems) break;
                }

                if (!pushedInRound) break;
            }
        }
    }

    while (merged.length < maxItems) {
        let pushedInRound = false;
        for (const source of sourceOrder) {
            const queue = bySource.get(source);
            if (!queue || queue.length === 0) continue;
            merged.push(queue.shift());
            pushedInRound = true;
            if (merged.length >= maxItems) break;
        }

        if (!pushedInRound) break;
    }

    return merged;
};

const searchManga = async (title) => {
    const all = [];
    const seen = new Set();

    const pushMany = (items) => {
        for (const item of items || []) {
            const key = `${item.source || SOURCE_ZONATMO}:${item.slug}`;
            if (seen.has(key)) continue;
            seen.add(key);
            all.push(item);
        }
    };

    const runSource = async (source, fn) => {
        try {
            const items = await fn();
            pushMany(items);
        } catch (err) {
            console.warn(`[Search][${source}] failed:`, err.message);
        }
    };

    await Promise.all([
        runSource(SOURCE_ZONATMO, () => zonatmoProvider.search(title)),
        runSource(SOURCE_VISORMANGA, () => htmlProvider.searchLibrary({
            baseUrl: VISORMANGA_BASE,
            source: SOURCE_VISORMANGA,
            query: title,
        })),
        runSource(SOURCE_MANHWAONLINE, () => manhwaonlineProvider.search(title)),
    ]);

    if (all.length === 0) {
        console.warn('[Search] No results found in configured sources.');
    }

    return interleaveBySource(all, 20, { reserveQuota: true });
};

const getMangaDetails = async (mangaToken) => {
    const { source, slug } = parseSourceSlug(mangaToken);

    if (!slug) {
        return {
            title: '',
            altTitles: '',
            cover: '',
            description: '',
            slug: mangaToken || '',
            source: SOURCE_ZONATMO,
            url: '',
            chapters: [],
        };
    }

    if (source === SOURCE_VISORMANGA) {
        return htmlProvider.getMangaDetails({
            baseUrl: VISORMANGA_BASE,
            source,
            slug,
            originalToken: mangaToken,
        });
    }

    if (source === SOURCE_MANHWAONLINE) {
        return manhwaonlineProvider.getMangaDetails(mangaToken);
    }

    return zonatmoProvider.getMangaDetails(mangaToken);
};

const getMangaChapters = async (mangaToken) => {
    const { chapters } = await getMangaDetails(mangaToken);
    return chapters;
};

const getChapterImages = async (compositeSlug) => {
    const { mangaToken, chapterSlug } = splitCompositeSlug(compositeSlug);
    const { source, slug: mangaSlug } = parseSourceSlug(mangaToken);

    if (!mangaSlug || !chapterSlug) {
        console.warn(`[Chapter] Invalid composite slug: "${compositeSlug}"`);
        return [];
    }

    if (source === SOURCE_VISORMANGA) {
        const images = await htmlProvider.getChapterImages({
            baseUrl: VISORMANGA_BASE,
            chapterSlug,
        });
        return images;
    }

    if (source === SOURCE_MANHWAONLINE) {
        const images = await manhwaonlineProvider.getChapterImages(mangaSlug, chapterSlug);
        return images;
    }

    const images = await zonatmoProvider.getChapterImages(mangaSlug, chapterSlug, compositeSlug);
    return images;
};

const getLatest = async () => {
    const { results } = await getLatestWithMeta();
    return results;
};

const getLatestWithMeta = async () => {
    const all = [];
    const seen = new Set();
    const sources = [];

    const pushMany = (items) => {
        for (const item of items || []) {
            const key = `${item.source || SOURCE_ZONATMO}:${item.slug}`;
            if (!item?.slug || seen.has(key)) continue;
            seen.add(key);
            all.push(item);
        }
    };

    const runSource = async (source, fn) => {
        const start = Date.now();
        try {
            const items = await fn();
            pushMany(items);
            const count = Array.isArray(items) ? items.length : 0;
            sources.push({
                source,
                ok: true,
                count,
                durationMs: Date.now() - start,
                error: '',
            });
        } catch (err) {
            const message = String(err?.message || err || 'Unknown error').slice(0, 500);
            sources.push({
                source,
                ok: false,
                count: 0,
                durationMs: Date.now() - start,
                error: message,
            });
            console.warn(`[Latest][${source}] failed:`, message);
        }
    };

    await Promise.all([
        runSource(SOURCE_ZONATMO, () => zonatmoProvider.getLatest()),
        runSource(SOURCE_VISORMANGA, () => htmlProvider.getLatestFromHome({
            baseUrl: VISORMANGA_BASE,
            source: SOURCE_VISORMANGA,
        })),
        runSource(SOURCE_MANHWAONLINE, () => manhwaonlineProvider.getLatest()),
    ]);

    const mixedResults = interleaveBySource(all, Math.max(40, all.length), { reserveQuota: true });

    return {
        results: mixedResults,
        diagnostics: {
            generatedAt: new Date().toISOString(),
            total: mixedResults.length,
            sources,
        },
    };
};

module.exports = {
    searchManga,
    getMangaDetails,
    getMangaChapters,
    getChapterImages,
    getLatest,
    getLatestWithMeta,
};
