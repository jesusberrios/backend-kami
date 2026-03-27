const assert = require('assert');
const htmlProvider = require('../src/providers/htmlProvider');
const { SOURCE_MANHWAONLINE, MANHWAONLINE_BASE } = require('../src/providers/constants');
const { sourceSlug } = require('../src/providers/slugUtils');

const TEST_SLUG = process.env.MANHWAONLINE_TEST_SLUG || 'trabajando-con-cupido';
const TEST_BASE_URL = process.env.MANHWAONLINE_TEST_BASE_URL || MANHWAONLINE_BASE;

async function run() {
    const mangaToken = sourceSlug(SOURCE_MANHWAONLINE, TEST_SLUG);

    const details = await htmlProvider.getMangaDetails({
        baseUrl: TEST_BASE_URL,
        source: SOURCE_MANHWAONLINE,
        slug: TEST_SLUG,
        originalToken: mangaToken,
    });

    assert(details, 'Expected manga details response');
    assert(details.title && details.title.trim().length > 0, 'Expected manga title');
    assert(Array.isArray(details.chapters), 'Expected chapters array');
    assert(details.chapters.length > 0, 'Expected at least one chapter');

    const firstChapter = details.chapters[0];
    assert(firstChapter.chapterSlug, 'Expected chapter slug');

    const images = await htmlProvider.getChapterImages({
        baseUrl: TEST_BASE_URL,
        mangaSlug: TEST_SLUG,
        chapterSlug: firstChapter.chapterSlug,
    });

    assert(Array.isArray(images), 'Expected images array');
    assert(images.length > 0, 'Expected at least one chapter image');
    assert(images.every((img) => img && typeof img.url === 'string' && img.url.startsWith('http')),
        'Expected all images to have absolute URLs');

    console.log('manhwaonline smoke test passed');
    console.log(`slug=${TEST_SLUG}`);
    console.log(`chapters=${details.chapters.length}`);
    console.log(`images=${images.length}`);
}

run().catch((err) => {
    console.error('manhwaonline smoke test failed');
    console.error(err && err.stack ? err.stack : String(err));
    process.exit(1);
});
