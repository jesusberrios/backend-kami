const {
    SOURCE_ZONATMO,
    SOURCE_VISORMANGA,
    VISORMANGA_BASE,
} = require('./constants');
const { parseSourceSlug, splitCompositeSlug } = require('./slugUtils');
const zonatmoProvider = require('./zonatmoProvider');
const htmlProvider = require('./htmlProvider');

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

    try {
        const z = await zonatmoProvider.search(title);
        pushMany(z);
        console.log(`[Search][zonatmo] ${z.length} results`);
    } catch (err) {
        console.warn('[Search][zonatmo] failed:', err.message);
    }

    if (all.length === 0) {
        try {
            const v = await htmlProvider.searchLibrary({
                baseUrl: VISORMANGA_BASE,
                source: SOURCE_VISORMANGA,
                query: title,
            });
            pushMany(v);
            console.log(`[Search][visormanga] ${v.length} results`);
        } catch (err) {
            console.warn('[Search][visormanga] failed:', err.message);
        }
    }

    if (all.length === 0) {
        console.warn('[Search] No results found in configured sources.');
    }

    return all.slice(0, 20);
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
        console.log(`[Chapter][visormanga] ${images.length} images for "${compositeSlug}"`);
        return images;
    }

    const images = await zonatmoProvider.getChapterImages(mangaSlug, chapterSlug, compositeSlug);
    console.log(`[Chapter][zonatmo] ${images.length} images for "${compositeSlug}"`);
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
            console.log(`[Latest][${source}] ${count} manga`);
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
    ]);

    return {
        results: all,
        diagnostics: {
            generatedAt: new Date().toISOString(),
            total: all.length,
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
