const puppeteer = require('puppeteer');
const { parseProxyUrl } = require('./httpClients');
const { SOURCE_LECTORMANGAA } = require('./constants');

const USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const getProxyUrlForSource = (source) => {
    if (source === SOURCE_LECTORMANGAA && process.env.LECTORMANGAA_PROXY_URL) {
        return process.env.LECTORMANGAA_PROXY_URL;
    }
    return process.env.BROWSER_PROXY_URL || process.env.SCRAPER_PROXY_URL || '';
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isCloudflareChallenge = (html) => {
    const value = String(html || '').toLowerCase();
    return value.includes('just a moment...') || value.includes('cf_chl_opt') || value.includes('/cdn-cgi/challenge-platform/');
};

const tryPlaywrightStealth = async (url, referer, source) => {
    let chromium;
    let browser;

    try {
        const playwrightExtra = require('playwright-extra');
        const stealthPlugin = require('puppeteer-extra-plugin-stealth');
        chromium = playwrightExtra.chromium;
        chromium.use(stealthPlugin());

        const proxyUrl = getProxyUrlForSource(source);
        const parsedProxy = parseProxyUrl(proxyUrl);
        const playwrightProxy = parsedProxy
            ? {
                server: `${parsedProxy.protocol}://${parsedProxy.host}:${parsedProxy.port}`,
                username: parsedProxy.auth?.username,
                password: parsedProxy.auth?.password,
            }
            : undefined;

        browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox'],
            proxy: playwrightProxy,
        });

        const context = await browser.newContext({
            userAgent: USER_AGENT,
            locale: 'es-419',
            extraHTTPHeaders: referer ? { Referer: referer } : {},
        });

        const page = await context.newPage();
        await page.addInitScript(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // Cloudflare may need a few seconds to finish the JS challenge.
        await wait(9000);
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

        const html = await page.content();
        await browser.close();

        if (isCloudflareChallenge(html)) {
            return '';
        }

        return html;
    } catch (_) {
        if (browser) {
            try {
                await browser.close();
            } catch (_) {}
        }
        return '';
    }
};

const tryPuppeteer = async (url, referer, source) => {
    let browser;
    try {
        const proxyUrl = getProxyUrlForSource(source);
        const parsedProxy = parseProxyUrl(proxyUrl);
        const launchArgs = ['--no-sandbox', '--disable-setuid-sandbox'];
        if (parsedProxy) {
            launchArgs.push(`--proxy-server=${parsedProxy.protocol}://${parsedProxy.host}:${parsedProxy.port}`);
        }

        browser = await puppeteer.launch({
            headless: true,
            args: launchArgs,
        });

        const page = await browser.newPage();
        if (parsedProxy?.auth?.username) {
            await page.authenticate({
                username: parsedProxy.auth.username,
                password: parsedProxy.auth.password || '',
            });
        }
        await page.setUserAgent(USER_AGENT);
        if (referer) {
            await page.setExtraHTTPHeaders({ Referer: referer });
        }
        await page.evaluateOnNewDocument(() => {
            Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        });

        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await wait(9000);
        await page.waitForNetworkIdle({ timeout: 15000 }).catch(() => {});

        const html = await page.content();
        await browser.close();

        if (isCloudflareChallenge(html)) {
            return '';
        }

        return html;
    } catch (_) {
        if (browser) {
            try {
                await browser.close();
            } catch (_) {}
        }
        return '';
    }
};

const getHtmlWithBrowser = async (url, referer, source) => {
    const fromPlaywright = await tryPlaywrightStealth(url, referer, source);
    if (fromPlaywright) return fromPlaywright;
    return tryPuppeteer(url, referer, source);
};

module.exports = {
    getHtmlWithBrowser,
};