export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

    const query = req.query.q;
    const searchType = req.query.type || 'all';

    if (!query) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
    }

    try {
        // 1. SPOTIFY LINK DETECTOR (Paste direct URL)
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

        // 3. SPOTIFY PLAYLIST SEARCH (Discover & Curate)
        if (searchType === 'spotify_playlists') {
            const playlists = await searchSpotifyPlaylists(query);
            return res.status(200).json({
                type: 'spotify_playlist_search_results',
                results: playlists
            });
        }

        // 4. GENERAL YOUTUBE TRACK SEARCH
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

// --- HELPER 1: Search Spotify Public Playlists Without Quota Keys ---
async function searchSpotifyPlaylists(query) {
    try {
        // Fetch Spotify's public client token
        const tokenRes = await fetch('https://open.spotify.com/get_access_token', {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        });
        const tokenData = await tokenRes.json();
        const token = tokenData.accessToken;

        if (!token) return [];

        const searchUrl = `https://api.spotify.com/v1/search?q=${encodeURIComponent(query)}&type=playlist&limit=15`;
        const res = await fetch(searchUrl, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const data = await res.json();
        const items = data.playlists?.items || [];

        return items.filter(p => p && p.id).map(p => ({
            id: p.id,
            name: p.name || "Untitled Playlist",
            description: p.description || "",
            owner: p.owner?.display_name || "Spotify",
            trackCount: p.tracks?.total || 0,
            thumbnail: p.images?.[0]?.url || "",
            url: p.external_urls?.spotify || `https://open.spotify.com/playlist/${p.id}`
        }));
    } catch (err) {
        console.error("Spotify Playlist Search Error:", err);
        return [];
    }
}

// --- HELPER 2: Extract Spotify Playlist Tracklist ---
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

// --- HELPER 3: Robust YouTube Video Scraper ---
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
