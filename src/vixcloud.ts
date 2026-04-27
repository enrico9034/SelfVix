import * as cheerio from 'cheerio';
import { request } from 'undici';
import { config } from './config';
import { makeProxyToken, VIXCLOUD_HEADERS } from './proxy';

const ANIMEMAPPING_BASE = 'https://animemapping.stremio.dpdns.org';
const AU_BASE = 'https://www.animeunity.so';
const AU_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36';

// All requests go through the global undici dispatcher set in addon.ts.
// When WARP_PROXY is configured there, every outbound request (including AU)
// is routed through SOCKS automatically — no per-host plumbing needed here.

// Infer dub language from AU path or slug. "-ita" segment → ITA dub, else SUB.
function inferLang(pathOrTitle: string): 'ITA' | 'SUB' {
    return /(?:^|[-_/])ita(?:[-_/]|$)/i.test(pathOrTitle) ? 'ITA' : 'SUB';
}

// Language filter from env (ita | sub | both). Default: both.
const AU_LANG_PREF = ((process.env.AU_LANG || 'both').toLowerCase()) as 'ita' | 'sub' | 'both';

export type MappingProvider = 'kitsu' | 'imdb' | 'tmdb' | 'mal' | 'anilist';

interface MappingResult {
    paths: string[];
    episode: number;
}

// Small TTL cache for mapping lookups. Key = provider:id:s:ep.
const MAPPING_CACHE_TTL_MS = 15 * 60 * 1000; // 15 min
const mappingCache = new Map<string, { value: MappingResult, expires: number }>();

function cacheGet(key: string): MappingResult | null {
    const hit = mappingCache.get(key);
    if (!hit) return null;
    if (Date.now() > hit.expires) {
        mappingCache.delete(key);
        return null;
    }
    return hit.value;
}

function cacheSet(key: string, value: MappingResult) {
    // Prevent unbounded growth
    if (mappingCache.size > 500) {
        const firstKey = mappingCache.keys().next().value;
        if (firstKey) mappingCache.delete(firstKey);
    }
    mappingCache.set(key, { value, expires: Date.now() + MAPPING_CACHE_TTL_MS });
}

// ── Resolve any provider ID (kitsu/imdb/tmdb/...) → AU paths + remapped ep ──
async function resolveMapping(
    provider: MappingProvider,
    externalId: string,
    season: number | undefined,
    episodeNum: number
): Promise<MappingResult> {
    const cacheKey = `${provider}:${externalId}:${season || ''}:${episodeNum}`;
    const cached = cacheGet(cacheKey);
    if (cached) {
        console.log(`[VixCloud] Mapping cache hit: ${cacheKey} → ${cached.paths.length} path(s)`);
        return cached;
    }

    const empty: MappingResult = { paths: [], episode: episodeNum };
    try {
        const qs = new URLSearchParams();
        if (season) qs.set('s', String(season));
        qs.set('ep', String(episodeNum));
        const url = `${ANIMEMAPPING_BASE}/${provider}/${encodeURIComponent(externalId)}?${qs.toString()}`;
        console.log(`[VixCloud] Fetching mapping: ${url}`);

        const { body, statusCode } = await request(url, { headers: { 'Accept': 'application/json' } });
        if (statusCode !== 200) {
            console.log(`[VixCloud] Mapping API returned ${statusCode} for ${provider}:${externalId}`);
            cacheSet(cacheKey, empty);
            return empty;
        }
        const data: any = await body.json();

        const auMapping = data?.mappings?.animeunity;
        const items = auMapping ? (Array.isArray(auMapping) ? auMapping : [auMapping]) : [];
        const paths: string[] = [];
        for (const item of items) {
            const path = typeof item === 'string' ? item : (item?.path || item?.url || item?.href || null);
            if (path && !paths.includes(path)) paths.push(path);
        }

        // Remapped episode (handles absolute episode numbering across seasons)
        const fromKitsu = data?.kitsu?.episode;
        const fromRequested = data?.requested?.episode;
        const remappedEp =
            (typeof fromKitsu === 'number' && fromKitsu > 0) ? fromKitsu :
            (typeof fromRequested === 'number' && fromRequested > 0) ? fromRequested :
            episodeNum;

        const result: MappingResult = { paths, episode: remappedEp };
        cacheSet(cacheKey, result);

        if (paths.length) console.log(`[VixCloud] Mapping found ${paths.length} AU path(s), ep→${remappedEp}: ${paths.join(', ')}`);
        else console.log(`[VixCloud] No AU paths in mapping for ${provider}:${externalId}`);
        return result;
    } catch (err: any) {
        console.error('[VixCloud] Mapping API error:', err?.message || err);
        return empty;
    }
}

// ── Step 3: Kitsu canonical title fallback ──
async function getKitsuTitle(kitsuId: string): Promise<string | null> {
    try {
        const { body, statusCode } = await request(`https://kitsu.io/api/edge/anime/${kitsuId}`);
        if (statusCode !== 200) return null;
        const data: any = await body.json();
        const attr = data?.data?.attributes;
        return attr?.titles?.en || attr?.titles?.en_jp || attr?.canonicalTitle || null;
    } catch {
        return null;
    }
}

// ── Step 4: AnimeUnity session + search ──
async function getAnimeUnitySession(): Promise<{csrfToken: string, cookie: string}> {
    const { body, headers, statusCode } = await request(AU_BASE, {
        headers: { 'User-Agent': AU_UA }
    });
    const html = await body.text();
    if (statusCode !== 200 || /error code:\s*\d+/i.test(html.slice(0, 200))) {
        throw new Error(`AnimeUnity blocked (status ${statusCode}). Set AU_PROXY to a SOCKS proxy.`);
    }
    const $ = cheerio.load(html);
    const csrfToken = $('meta[name="csrf-token"]').attr('content') || '';
    let cookie = '';
    const setCookieHeader = headers['set-cookie'];
    if (setCookieHeader) {
         if (Array.isArray(setCookieHeader)) {
             cookie = setCookieHeader.map((c: string) => c.split(';')[0]).join('; ');
         } else {
             cookie = String(setCookieHeader).split(';')[0] || '';
         }
    }
    return { csrfToken, cookie };
}

async function searchAnimeUnity(title: string, session: {csrfToken: string, cookie: string}): Promise<any[]> {
    const { body, statusCode, headers } = await request(`${AU_BASE}/livesearch`, {
        method: 'POST',
        headers: {
            'User-Agent': AU_UA,
            'X-Requested-With': 'XMLHttpRequest',
            'Content-Type': 'application/json;charset=utf-8',
            'X-CSRF-Token': session.csrfToken,
            'Referer': AU_BASE + '/',
            'Cookie': session.cookie
        },
        body: JSON.stringify({ title })
    });
    const ctype = String(headers['content-type'] || '');
    if (statusCode !== 200 || !ctype.includes('json')) {
        const preview = (await body.text()).slice(0, 120);
        console.log(`[VixCloud] livesearch blocked (status ${statusCode}): ${preview}`);
        return [];
    }
    const result: any = await body.json();
    return result?.records || [];
}

// ── Step 5: Extract embed URL from AnimeUnity anime page ──
async function getEmbedUrl(animePath: string, episodeNum: number): Promise<string | null> {
    const animeUrl = animePath.startsWith('http') ? animePath : `${AU_BASE}${animePath}`;
    console.log(`[VixCloud] Fetching anime page: ${animeUrl}`);

    const { body, statusCode } = await request(animeUrl, {
        headers: { 'User-Agent': AU_UA }
    });
    const html = await body.text();
    if (statusCode !== 200 || /error code:\s*\d+/i.test(html.slice(0, 200))) {
        console.log(`[VixCloud] AnimeUnity page blocked (status ${statusCode}) — set AU_PROXY to a SOCKS proxy to bypass`);
        return null;
    }
    const $ = cheerio.load(html);
    
    const vp = $('video-player').first();
    const episodesStr = vp.attr('episodes') || '[]';
    
    let parsedEpisodes: any[] = [];
    try {
        // AnimeUnity HTML-encodes the JSON
        const unescaped = episodesStr
            .replace(/&quot;/g, '"')
            .replace(/&#039;/g, "'")
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>');
        parsedEpisodes = JSON.parse(unescaped);
    } catch(e) {
        console.error('[VixCloud] Failed to parse episodes JSON');
        return null;
    }

    // Find episode by number
    const targetEp = parsedEpisodes.find((e: any) => {
        const num = parseFloat(String(e.number || ''));
        return num === episodeNum;
    });
    
    if (!targetEp) {
        console.log(`[VixCloud] Episode ${episodeNum} not found in ${parsedEpisodes.length} episodes`);
        // For movies or single-episode anime, just use the first episode
        if (parsedEpisodes.length === 1) {
            const singleEp = parsedEpisodes[0];
            return singleEp.embed_url || null;
        }
        return null;
    }

    // Get embed URL from the episode page
    const epPageUrl = `${animeUrl}/${targetEp.id}`;
    console.log(`[VixCloud] Fetching episode page: ${epPageUrl}`);
    
    const { body: epBody } = await request(epPageUrl, {
        headers: { 'User-Agent': AU_UA }
    });
    const epHtml = await epBody.text();
    const $ep = cheerio.load(epHtml);
    
    let embedUrl = $ep('video-player').first().attr('embed_url');
    if (!embedUrl) {
        embedUrl = $ep('iframe[src*="vixcloud"]').first().attr('src');
    }
    if (embedUrl && !embedUrl.startsWith('http')) {
        embedUrl = AU_BASE + embedUrl;
    }
    
    return embedUrl || null;
}

// ── Step 6: Extract HLS manifest from VixCloud embed ──
async function extractVixCloudManifest(embedUrl: string): Promise<string | null> {
    console.log(`[VixCloud] Extracting manifest from embed: ${embedUrl}`);
    
    // Parse input URL for fallback tokens
    const inputUrlObj = new URL(embedUrl);
    const tokenFromInput = inputUrlObj.searchParams.get('token');
    const expiresFromInput = inputUrlObj.searchParams.get('expires');
    const asnFromInput = inputUrlObj.searchParams.get('asn');

    const { body, statusCode } = await request(embedUrl, {
        headers: VIXCLOUD_HEADERS
    });

    let html = "";
    if (statusCode === 200) {
        html = await body.text();
    } else if (statusCode === 403 && tokenFromInput && expiresFromInput) {
        console.log("[VixCloud] 403 Received, but tokens provided in URL. Using fallback.");
    } else {
        console.log(`[VixCloud] Embed fetch failed with status ${statusCode}`);
        return null;
    }
    
    // Extract components from script
    let token = tokenFromInput || "";
    let expires = expiresFromInput || "";
    let asn = asnFromInput || "";
    let playlistUrl = "";

    // Regex for window.masterPlaylist block
    const masterPlaylistMatch = html.match(/window\.masterPlaylist\s*=\s*\{.*?params\s*:\s*\{(?<params>.*?)\}\s*,\s*url\s*:\s*['"](?<url>[^'"]+)['"]/s);
    
    if (masterPlaylistMatch?.groups) {
        const paramsBlock = masterPlaylistMatch.groups.params;
        playlistUrl = masterPlaylistMatch.groups.url.replace(/\\/g, '');
        
        const tMatch = paramsBlock.match(/['"]token['"]\s*:\s*['"]([^'"]+)['"]/);
        const eMatch = paramsBlock.match(/['"]expires['"]\s*:\s*['"]([^'"]+)['"]/);
        const aMatch = paramsBlock.match(/['"]asn['"]\s*:\s*['"]([^'"]+)['"]/);
        
        if (tMatch) token = tMatch[1];
        if (eMatch) expires = eMatch[1];
        if (aMatch) asn = aMatch[1];
    } else {
        // Fallback regex patterns (match Python implementation)
        const urlMatch = html.match(/masterPlaylist[\s\S]*?url\s*:\s*['"]([^'"]+)['"]/) || html.match(/url\s*:\s*['"](https?:[^'"]+\/playlist\/[^'"]+)['"]/);
        const tMatch = html.match(/token['"]\s*:\s*['"]([^'"]+)['"]/);
        const eMatch = html.match(/expires['"]\s*:\s*['"](\d+)['"]/);
        const aMatch = html.match(/asn['"]\s*:\s*['"]([^'"]*)['"]/);

        if (urlMatch) playlistUrl = urlMatch[1].replace(/\\/g, '');
        if (tMatch && !token) token = tMatch[1];
        if (eMatch && !expires) expires = eMatch[1];
        if (aMatch && !asn) asn = aMatch[1];
    }

    // Build fallback playlist URL if missing
    if (!playlistUrl) {
        const videoIdMatch = embedUrl.match(/\/embed\/(\d+)/);
        if (videoIdMatch) {
            playlistUrl = `${inputUrlObj.origin}/playlist/${videoIdMatch[1]}`;
        }
    }

    if (!token || !expires || !playlistUrl) {
        console.log(`[VixCloud] Extraction failed: token=${!!token} expires=${!!expires} url=${!!playlistUrl}`);
        return null;
    }

    // Build final URL
    const finalUrlObj = new URL(playlistUrl);
    finalUrlObj.searchParams.set('token', token);
    finalUrlObj.searchParams.set('expires', expires);
    if (asn) finalUrlObj.searchParams.set('asn', asn);
    
    // Check FHD
    const canFHD = /canPlayFHD\s*=\s*true/i.test(html) || inputUrlObj.searchParams.get('canPlayFHD') === '1';
    if (canFHD) finalUrlObj.searchParams.set('h', '1');

    console.log(`[VixCloud] Extracted manifest: ${finalUrlObj.toString()}`);
    return ensureM3u8(finalUrlObj.toString());
}

function ensureM3u8(url: string): string {
    try {
        const u = new URL(url);
        if (u.pathname.includes('/playlist/')) {
            const parts = u.pathname.split('/');
            const leaf = parts[parts.length - 1];
            if (leaf && !leaf.includes('.') && !leaf.endsWith('.m3u8')) {
                u.pathname = u.pathname + '.m3u8';
                return u.toString();
            }
        }
        return url;
    } catch { return url; }
}

// ── Main entry point ──
export async function getVixCloudStreams(
    provider: MappingProvider,
    externalId: string,
    season: number | undefined,
    episodeNumber: string = "1"
): Promise<{name: string, title: string, url: string}[]> {
    try {
        const epNum = parseInt(episodeNumber) || 1;
        console.log(`[VixCloud] Resolving ${provider}:${externalId} s=${season ?? '-'} ep=${epNum}`);

        const mapping = await resolveMapping(provider, externalId, season, epNum);
        const resolvedEp = mapping.episode;
        let paths = mapping.paths;

        // Fallback: search AnimeUnity by title (only works when we have a Kitsu ID to look up canonical title)
        if (paths.length === 0 && provider === 'kitsu') {
            const title = await getKitsuTitle(externalId);
            if (!title) {
                console.log(`[VixCloud] Could not resolve title for kitsu:${externalId}`);
                return [];
            }
            console.log(`[VixCloud] Searching AnimeUnity for title: "${title}"`);

            const session = await getAnimeUnitySession();
            const searchResults = await searchAnimeUnity(title, session);

            if (searchResults.length === 0) {
                console.log(`[VixCloud] No AnimeUnity results for "${title}"`);
                return [];
            }
            const anime = searchResults[0];
            paths = [`/anime/${anime.id}-${anime.slug}`];
            console.log(`[VixCloud] Found AnimeUnity: id=${anime.id} slug=${anime.slug}`);
        }

        if (paths.length === 0) return [];

        // Apply language preference from AU_LANG env (ita | sub | both)
        if (AU_LANG_PREF === 'ita' || AU_LANG_PREF === 'sub') {
            const want = AU_LANG_PREF.toUpperCase() as 'ITA' | 'SUB';
            const filtered = paths.filter(p => inferLang(p) === want);
            if (filtered.length) paths = filtered;
            else console.log(`[VixCloud] AU_LANG=${AU_LANG_PREF} but no matching variant; returning all`);
        }

        // Resolve each path → embed URL → manifest, in parallel
        const streams = await Promise.all(paths.map(async (p) => {
            const lang = inferLang(p);
            try {
                const embedUrl = await getEmbedUrl(p, resolvedEp);
                if (!embedUrl) return null;
                const manifestUrl = await extractVixCloudManifest(embedUrl);
                if (!manifestUrl) return null;
                const proxyToken = makeProxyToken(manifestUrl, VIXCLOUD_HEADERS);
                const flag = lang === 'ITA' ? '🇮🇹' : '🇯🇵';
                return {
                    name: `AU 🤌 ${flag}`,
                    title: `VIX 1080 · ${lang}`,
                    url: `/proxy/hls/manifest.m3u8?token=${proxyToken}`
                };
            } catch (err: any) {
                console.error(`[VixCloud] ${lang} path ${p} failed:`, err?.message || err);
                return null;
            }
        }));

        const out = streams.filter((s): s is {name: string, title: string, url: string} => s !== null);
        if (out.length === 0) console.log(`[VixCloud] No streams produced from ${paths.length} path(s)`);
        return out;

    } catch (err: any) {
        console.error("VixCloud Stream extraction error:", err?.message || err);
        return [];
    }
}
