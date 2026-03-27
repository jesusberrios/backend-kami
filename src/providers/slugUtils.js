const {
    SOURCE_ZONATMO,
    SOURCE_VISORMANGA,
    SOURCE_MANHWAONLINE,
    SOURCE_LECTORMANGAA_LEGACY,
    SOURCE_DELIMITER,
} = require('./constants');

const sourceSlug = (source, slug) => {
    if (!slug) return '';
    if (source === SOURCE_ZONATMO) return slug;
    return `${source}${SOURCE_DELIMITER}${slug}`;
};

const parseSourceSlug = (value) => {
    const raw = String(value || '').trim();
    if (!raw) return { source: SOURCE_ZONATMO, slug: '' };

    const idx = raw.indexOf(SOURCE_DELIMITER);
    if (idx === -1) return { source: SOURCE_ZONATMO, slug: raw };

    const source = raw.slice(0, idx);
    const slug = raw.slice(idx + SOURCE_DELIMITER.length);
    if (!slug) return { source: SOURCE_ZONATMO, slug: raw };

    if (![SOURCE_ZONATMO, SOURCE_VISORMANGA, SOURCE_MANHWAONLINE, SOURCE_LECTORMANGAA_LEGACY].includes(source)) {
        return { source: SOURCE_ZONATMO, slug: raw };
    }

    // Backward compatibility for previously stored tokens.
    if (source === SOURCE_LECTORMANGAA_LEGACY) {
        return { source: SOURCE_MANHWAONLINE, slug };
    }

    return { source, slug };
};

const splitCompositeSlug = (compositeSlug) => {
    const raw = String(compositeSlug || '');
    const slashIdx = raw.indexOf('/');
    if (slashIdx === -1) return { mangaToken: raw, chapterSlug: '' };
    return {
        mangaToken: raw.slice(0, slashIdx),
        chapterSlug: raw.slice(slashIdx + 1),
    };
};

module.exports = {
    sourceSlug,
    parseSourceSlug,
    splitCompositeSlug,
};
