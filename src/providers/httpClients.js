const http = require('http');
const https = require('https');
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');
const cloudscraper = require('cloudscraper');
const { ZONATMO_BASE } = require('./constants');

const REQUEST_TIMEOUT_MS = Math.max(3000, Number(process.env.SCRAPER_HTTP_TIMEOUT_MS || 12000));
const MAX_SOCKETS = Math.max(4, Number(process.env.SCRAPER_MAX_SOCKETS || 30));
const MAX_FREE_SOCKETS = Math.max(2, Number(process.env.SCRAPER_MAX_FREE_SOCKETS || 10));
const KEEP_ALIVE_MSECS = Math.max(1000, Number(process.env.SCRAPER_KEEP_ALIVE_MSECS || 10000));

const httpAgent = new http.Agent({
    keepAlive: true,
    maxSockets: MAX_SOCKETS,
    maxFreeSockets: MAX_FREE_SOCKETS,
    keepAliveMsecs: KEEP_ALIVE_MSECS,
});

const httpsAgent = new https.Agent({
    keepAlive: true,
    maxSockets: MAX_SOCKETS,
    maxFreeSockets: MAX_FREE_SOCKETS,
    keepAliveMsecs: KEEP_ALIVE_MSECS,
});

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
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    httpAgent,
    httpsAgent,
    headers: defaultHeaders,
}));

const htmlClient = axios.create({
    timeout: REQUEST_TIMEOUT_MS,
    maxRedirects: 5,
    httpAgent,
    httpsAgent,
    headers: defaultHeaders,
    proxy: sharedAxiosProxy || undefined,
});

const cloudGet = async (url, extraHeaders = {}) => {
    return cloudscraper.get({
        uri: url,
        gzip: true,
        timeout: REQUEST_TIMEOUT_MS,
        proxy: sharedProxyUrl || undefined,
        headers: {
            ...defaultHeaders,
            ...extraHeaders,
        },
    });
};

let warmUpDone = false;
let warmUpInFlight = null;
const warmUpZonaTmo = async () => {
    if (warmUpDone) return;
    if (warmUpInFlight) return warmUpInFlight;

    warmUpInFlight = (async () => {
    try {
        await zonatmoClient.get(`${ZONATMO_BASE}/home`);
        warmUpDone = true;
        console.log('[Scraper] Warm-up OK');
    } catch (err) {
        console.warn('[Scraper] Warm-up failed (non-critical):', err.message);
    } finally {
        warmUpInFlight = null;
    }
    })();

    return warmUpInFlight;
};

module.exports = {
    zonatmoClient,
    htmlClient,
    cloudGet,
    warmUpZonaTmo,
    parseProxyUrl,
};
