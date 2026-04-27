import * as cheerio from 'cheerio';
import { request, Pool, Dispatcher } from 'undici';
import { socksConnector } from 'fetch-socks';
import { config } from './config';
import { makeProxyToken, VIXSRC_HEADERS } from './proxy';

const VIXSRC_BASE = `https://${config.vixsrcDomain}`;

// Optional SOCKS proxy used ONLY for VixSrc requests, to bypass Cloudflare
// ASN blocks on cloud hosts (Oracle/Hetzner/etc). Mirrors AU_PROXY in vixcloud.ts.
// Examples: socks5h://warp:1080 , socks5://127.0.0.1:1080
let vixsrcPool: Pool | undefined;
(() => {
    const raw = process.env.VIXSRC_PROXY;
    if (!raw) return;
    try {
        const u = new URL(raw);
        const proto = u.protocol.replace(':', '').toLowerCase();
        if (!proto.startsWith('socks')) {
            console.warn(`[VixSrc] VIXSRC_PROXY protocol ${proto} not supported (use socks5/socks5h)`);
            return;
        }
        const connect = socksConnector({
            type: proto === 'socks4' || proto === 'socks4a' ? 4 : 5,
            host: u.hostname,
            port: parseInt(u.port || '1080', 10),
            userId: u.username ? decodeURIComponent(u.username) : undefined,
            password: u.password ? decodeURIComponent(u.password) : undefined,
        });
        vixsrcPool = new Pool(VIXSRC_BASE, { connect: connect as any });
        console.log(`[VixSrc] VIXSRC_PROXY active: ${proto}://${u.hostname}:${u.port}`);
    } catch (err: any) {
        console.warn(`[VixSrc] Invalid VIXSRC_PROXY: ${err?.message || err}`);
    }
})();

// Use the VixSrc pool (through SOCKS) when configured and URL targets vixsrc.to,
// otherwise fall back to direct request().
async function vixsrcRequest(url: string, opts: any = {}): Promise<Dispatcher.ResponseData> {
    if (vixsrcPool && url.startsWith(VIXSRC_BASE)) {
        const u = new URL(url);
        return vixsrcPool.request({
            path: u.pathname + u.search,
            method: opts.method || 'GET',
            headers: opts.headers,
            body: opts.body,
        });
    }
    return request(url, opts);
}

/**
 * Resolve the current embed URL through VixSrc JSON API.
 */
async function getEmbedUrlFromApi(tmdbId: string, season?: string, episode?: string): Promise<string | null> {
    const siteOrigin = `https://${config.vixsrcDomain}`;
    let apiPath = "";

    if (season && episode) {
        apiPath = `/api/tv/${tmdbId}/${season}/${episode}`;
    } else {
        apiPath = `/api/movie/${tmdbId}`;
    }

    const apiUrl = `${siteOrigin}${apiPath}`;
    console.log(`[VixSrc] Fetching embed via API: ${apiUrl}`);

    try {
        const { body, statusCode } = await vixsrcRequest(apiUrl, {
            headers: {
                ...VIXSRC_HEADERS,
                'Accept': 'application/json, text/plain, */*',
                'Referer': `${siteOrigin}/`
            }
        });

        if (statusCode !== 200) {
            console.log(`[VixSrc] API responded with status ${statusCode}`);
            return null;
        }

        const data: any = await body.json();
        const embedPath = data?.src;
        if (!embedPath) {
            console.log(`[VixSrc] No 'src' field in API response`);
            return null;
        }

        return embedPath.startsWith('http') ? embedPath : `${siteOrigin}${embedPath}`;
    } catch (err) {
        console.error(`[VixSrc] API error:`, err);
        return null;
    }
}

export async function getVixSrcStreams(tmdbId: string, season?: string, episode?: string): Promise<{name: string, title: string, url: string}[]> {
    try {
        const siteOrigin = `https://${config.vixsrcDomain}`;
        
        // 1. Resolve embed URL through API
        const embedUrl = await getEmbedUrlFromApi(tmdbId, season, episode);
        if (!embedUrl) {
            console.log("[VixSrc] Failed to resolve embed URL");
            return [];
        }

        console.log("[VixSrc] Embed URL resolved:", embedUrl);

        // 2. Fetch embed page and extract parameters
        const { body, statusCode } = await vixsrcRequest(embedUrl, {
            headers: {
                ...VIXSRC_HEADERS,
                'Referer': `${siteOrigin}/`
            }
        });

        if (statusCode !== 200) {
            console.log(`[VixSrc] Embed page fetch failed: ${statusCode}`);
            return [];
        }

        const html = await body.text();
        const $ = cheerio.load(html);

        // Find the script containing window.masterPlaylist or the token parameters
        const scriptTag = $("script").filter((_, el) => {
            const content = $(el).html() || '';
            return content.includes('window.masterPlaylist') || (content.includes("'token':") && content.includes("'expires':"));
        }).first();

        const scriptContent = scriptTag.html() || '';
        if (!scriptContent) throw new Error("VixSrc player script not found.");

        // Extraction based on the new masterPlaylist structure
        // window.masterPlaylist = { params: { 'token': '...', 'expires': '...', 'asn': '...' }, url: '...' }
        let token = '';
        let expires = '';
        let asn = '';
        let serverUrl = '';

        const tokenMatch = scriptContent.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
        const expiresMatch = scriptContent.match(/['"]expires['"]\s*:\s*['"](\d+)['"]/);
        const asnMatch = scriptContent.match(/['"]asn['"]\s*:\s*['"]([^'"]*)['"]/);
        const urlMatch = scriptContent.match(/url\s*:\s*['"]([^'"]+)['"]/);

        if (tokenMatch) token = tokenMatch[1];
        if (expiresMatch) expires = expiresMatch[1];
        if (asnMatch) asn = asnMatch[1];
        if (urlMatch) serverUrl = urlMatch[1].replace(/\\/g, '');

        if (!token || !expires || !serverUrl) {
            throw new Error("Failed to extract mandatory parameters from VixSrc script.");
        }

        // 3. Construct final stream URL
        const canPlayFHD = /window\.canPlayFHD\s*=\s*true/i.test(scriptContent) || /canPlayFHD/.test(scriptContent);
        
        const urlObj = new URL(serverUrl);
        urlObj.searchParams.set('token', token);
        urlObj.searchParams.set('expires', expires);
        urlObj.searchParams.set('lang', 'it');
        if (asn) urlObj.searchParams.set('asn', asn);
        if (canPlayFHD) urlObj.searchParams.set('h', '1');

        let finalStreamUrl = urlObj.toString();

        // 4. Ensure .m3u8 extension in the path if necessary (as seen in the original code)
        const parts = urlObj.pathname.split('/');
        const pIdx = parts.indexOf('playlist');
        if (pIdx !== -1 && pIdx < parts.length - 1) {
            let nextPart = parts[pIdx + 1];
            if (nextPart && !nextPart.includes('.')) {
                parts[pIdx + 1] = nextPart + '.m3u8';
                urlObj.pathname = parts.join('/');
                finalStreamUrl = urlObj.toString();
            }
        }

        console.log(`[VixSrc] Final stream URL: ${finalStreamUrl}`);

        // 5. Wrap through local HLS proxy
        const proxyToken = makeProxyToken(finalStreamUrl, VIXSRC_HEADERS);

        return [{
            name: "SC 🤌",
            title: "VIX 1080 🤌",
            url: `/proxy/hls/manifest.m3u8?token=${proxyToken}`
        }];

    } catch(err) {
        console.error("VixSrc Stream extraction error", err);
        return [];
    }
}
