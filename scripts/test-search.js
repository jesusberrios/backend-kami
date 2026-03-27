// Quick search test: node scripts/test-search.js "the ghost of nocturne"
const provider = require('../src/providers/manhwaonlineProvider');

const query = process.argv[2] || 'the ghost of nocturne';

(async () => {
    console.log(`Searching for: "${query}"`);
    const results = await provider.search(query);
    console.log(`Results (${results.length}):`);
    for (const r of results) {
        console.log(' -', r.title || '(no title)', '|', r.slug, '|', r.cover ? 'has cover' : 'no cover');
    }
    const hit = results.find(r => String(r.slug || '').includes('ghost') || String(r.title || '').toLowerCase().includes('ghost'));
    console.log('\nGhost hit found:', hit ? '✓ YES' : '✗ NO');
    if (hit) console.log('  =>', JSON.stringify(hit, null, 2));
})().catch(err => {
    console.error('Error:', err.message);
    process.exit(1);
});
