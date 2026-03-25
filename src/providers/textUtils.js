const normalizeText = (value) => {
    return String(value || '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .trim();
};

const titleFromSlug = (slug) => {
    return String(slug || '')
        .replace(/-/g, ' ')
        .replace(/\b\w/g, (ch) => ch.toUpperCase())
        .trim();
};

const parseChapterNumber = (text) => {
    const match = String(text || '').match(/cap[ií]tulo\s+([\d.]+)/i);
    return match ? match[1] : '';
};

module.exports = {
    normalizeText,
    titleFromSlug,
    parseChapterNumber,
};
