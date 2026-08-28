let cachedSpotifyToken = null;
let tokenExpiresAt = 0;

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

    const query = req.query.q;
    const searchType = req.query.type || 'all';

    if (!query) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
    }

    try {
        // 1. DIRECT SPOTIFY LINK DETECTOR (Playlist, Album, or User Profile)
        if (query.includes('spotify.com/playlist/') || query.includes('spotify.com/album/')) {
            const spotifyTracks = await parseSpotifyLink(query);
            return res.status(200).json({
                type: 'spotify_playlist',
                count: spotifyTracks.length,
                tracks: spotifyTracks
            });
        }

        // 2. DIRECT YOUTUBE LINK DETECTOR
        const ytIdMatch = query.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
        if (ytIdMatch) {
            return res.status(200).json({
                type: 'search_results',
                results: [{
                    id: ytIdMatch[1],
                    title: "YouTube Audio Stream",
                    artist: "Direct Link",
                    duration: "--:--",
                    thumbnail: `https://img.youtube.com/vi/${ytIdMatch[1]}/hqdefault.jpg`
                }]
            });
        }

        // 3. SPOTIFY PLAYLIST SEARCH (Searches all user-created & public playlists)
        if (searchType === 'spotify_playlists') {
            const token = await getSpotifyAccessToken(req);
            if (!token) {
                return res.status(200).json({
                    type: 'spotify_playlist_search_results',
                    results: [],
                    warning: "Spotify Client Keys missing. Add SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in Vercel."
                });
            }

            const rawPlaylists = await searchSpotifyPlaylists(query, token);
            const rankedPlaylists = rankPlaylistsByRelevance(rawPlaylists, query);

            return res.status(200).json({
                type: 'spotify_playlist_search_results',
                results: rankedPlaylists
            });
        }

        // 4. GENERAL YOUTUBE SONG SEARCH
        const searchResults = await searchYouTube(query);
        return res.status(200).json({
            type: 'search_results',
            results: searchResults
        });

    } catch (err) {
        console.error("API Route Error:", err);
        return res.status(500).json({ error: err.message || "Internal Engine Error" });
    }
}

// --- SPOTIFY OAUTH TOKEN MANAGER (Cached in memory) ---
async function getSpotifyAccessToken(req) {
    const clientId = process.env.SPOTIFY_CLIENT_ID || req.query.client_id;
    const clientSecret = process.env.SPOTIFY_CLIENT_SECRET || req.query.client_secret;

    if (!clientId || !clientSecret) return null;

    const now = Date.now();
    if (cachedSpotifyToken && now < tokenExpiresAt) {
        return cachedSpotifyToken;
    }

    const authHeader = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
    const response = await fetch('https://accounts.spotify.com/api/token', {
        method: 'POST',
        headers: {
            'Authorization': `Basic ${authHeader}`,
            'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: 'grant_type=client_credentials'
    });

    if (!response.ok) return null;

    const data = await response.json();
    cachedSpotifyToken = data.access_token;
    tokenExpiresAt = now + ((data.expires_in - 120) * 1000); // 2-min buffer
    return cachedSpotifyToken;
}

// --- SEARCH PUBLIC & USER PLAYLISTS ON SPOTIFY ---
async function searchSpotifyPlaylists(query, token) {
    try {
        const url = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=30`;
        const res = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        if (!res.ok) return [];

        const data = await res.json();
        const items = data.playlists?.items || [];

        return items.filter(p => p && p.id).map(p => ({
            id: p.id,
            name: p.name || "Untitled Playlist",
            description: (p.description || "").replace(/<[^>]*>?/gm, ''), // strip HTML
            owner: p.owner?.display_name || "Spotify User",
            ownerId: p.owner?.id || "",
            trackCount: p.tracks?.total || 0,
            thumbnail: p.images?.[0]?.url || "",
            url: p.external_urls?.spotify || `https://open.spotify.com/playlist/${p.id}`
        }));
    } catch (err) {
        console.error("Spotify Search Error:", err);
        return [];
    }
}

// --- CUSTOM RELEVANCE & ORDERING ALGORITHM ---
function rankPlaylistsByRelevance(playlists, query) {
    const cleanQuery = query.trim().toLowerCase();
    const queryWords = cleanQuery.split(/\s+/).filter(Boolean);

    return playlists.map((pl, originalIndex) => {
        const cleanName = pl.name.trim().toLowerCase();
        const cleanOwner = pl.owner.trim().toLowerCase();
        let score = 0;

        // 1. Exact Full Match
        if (cleanName === cleanQuery) {
            score += 1000;
        }
        // 2. Starts With Full Query
        else if (cleanName.startsWith(cleanQuery)) {
            score += 500;
        }
        // 3. User / Creator Name Match
        if (cleanOwner === cleanQuery || cleanOwner.includes(cleanQuery)) {
            score += 300;
        }
        // 4. All Query Words Contained in Title
        const containsAllWords = queryWords.every(w => cleanName.includes(w));
        if (containsAllWords) {
            score += 150;
        }
        // 5. Individual Word Matches
        queryWords.forEach(w => {
            if (cleanName.includes(w)) score += 20;
        });

        // 6. Natural Spotify Order fallback weighting
        score += (30 - originalIndex);

        return { ...pl, relevanceScore: score };
    }).sort((a, b) => b.relevanceScore - a.relevanceScore);
}

// --- SCRAPE SPOTIFY TRACKLIST FROM EMBED ---
async function parseSpotifyLink(url) {
    const cleanUrl = url.split('?')[0];
    const embedUrl = cleanUrl.replace('spotify.com/', 'spotify.com/embed/');
    
    const response = await fetch(embedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();

    const match = html.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
    if (!match) throw new Error("Could not read Spotify playlist structure.");

    const data = JSON.parse(match[1]);
    const entity = data.props.pageProps.state.data.entity;
    const rawList = entity.trackList || entity.tracks || [];

    return rawList.map(t => ({
        title: t.title || t.name,
        artist: t.artists ? t.artists.map(a => a.name).join(', ') : (t.subtitle || "Spotify Import"),
        searchQuery: `${t.title || t.name} ${t.artists ? t.artists[0].name : ''}`
    }));
}

// --- YOUTUBE SCRAPER ---
async function searchYouTube(query) {
    try {
        const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
        const response = await fetch(searchUrl, {
            headers: { 
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });
        const html = await response.text();

        const startIndex = html.indexOf('var ytInitialData = ');
        if (startIndex === -1) return [];
        
        const jsonStart = startIndex + 'var ytInitialData = '.length;
        const jsonEnd = html.indexOf(';</script>', jsonStart);
        if (jsonEnd === -1) return [];

        const jsonString = html.substring(jsonStart, jsonEnd);
        const ytData = JSON.parse(jsonString);

        const sectionList = ytData.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents || [];
        const results = [];

        for (const section of sectionList) {
            const itemSection = section.itemSectionRenderer;
            if (!itemSection || !itemSection.contents) continue;

            for (const item of itemSection.contents) {
                const video = item.videoRenderer;
                if (video && video.videoId) {
                    results.push({
                        id: video.videoId,
                        title: video.title?.runs[0]?.text || "Unknown Track",
                        artist: video.ownerText?.runs[0]?.text || "YouTube",
                        duration: video.lengthText?.simpleText || "0:00",
                        thumbnail: video.thumbnail?.thumbnails[0]?.url || `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`
                    });
                    if (results.length >= 8) break;
                }
            }
            if (results.length >= 8) break;
        }

        return results;
    } catch (err) {
        console.error("Scraper Error:", err);
        return [];
    }
}
