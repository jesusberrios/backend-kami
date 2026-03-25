const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cloudscraper = require('cloudscraper');
const { ZONATMO_BASE } = require('./constants');

const defaultHeaders = {
    'User-Agent':                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language':           'es-419,es;q=0.9,en;q=0.8',
    'Accept-Encoding':           'gzip, deflate, br',
    'Connection':                'keep-alive',
    'Upgrade-Insecure-Requests': '1',
    'Sec-Fetch-Dest':            'document',
    'Sec-Fetch-Mode':            'navigate',
    'Sec-Fetch-Site':            'none',
    'Cache-Control':             'max-age=0',
};

const parseProxyUrl = (proxyUrl) => {
    if (!proxyUrl) return null;
    try {
        const u = new URL(proxyUrl);
        const port = Number(u.port || (u.protocol === 'https:' ? 443 : 80));
        const proxy = {
            protocol: u.protocol.replace(':', ''),
            host: u.hostname,
            port,
        };
        if (u.username) {
            proxy.auth = {
                username: decodeURIComponent(u.username),
                password: decodeURIComponent(u.password || ''),
            };
        }
        return proxy;
    } catch (_) {
        return null;
    }
};

const sharedProxyUrl = process.env.SCRAPER_PROXY_URL || '';
const sharedAxiosProxy = parseProxyUrl(sharedProxyUrl);

const zonatmoJar = new CookieJar();
const zonatmoClient = wrapper(axios.create({
    jar: zonatmoJar,
    timeout: 20000,
    maxRedirects: 5,
    headers: defaultHeaders,
}));

const htmlClient = axios.create({
    timeout: 20000,
    maxRedirects: 5,
    headers: defaultHeaders,
    proxy: sharedAxiosProxy || undefined,
});

const cloudGet = async (url, extraHeaders = {}) => {
    return cloudscraper.get({
        uri: url,
        gzip: true,
        timeout: 20000,
        proxy: sharedProxyUrl || undefined,
        headers: {
            ...defaultHeaders,
            ...extraHeaders,
        },
    });
};

let warmUpDone = false;
const warmUpZonaTmo = async () => {
    if (warmUpDone) return;
    try {
        await zonatmoClient.get(`${ZONATMO_BASE}/home`);
        warmUpDone = true;
        console.log('[Scraper] Warm-up OK');
    } catch (err) {
        console.warn('[Scraper] Warm-up failed (non-critical):', err.message);
    }
};

module.exports = {
    zonatmoClient,
    htmlClient,
    cloudGet,
    warmUpZonaTmo,
    parseProxyUrl,
};
