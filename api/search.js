export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
    }

    try {
        // 1. SPOTIFY LINK DETECTOR (Playlist or Album)
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

        // 3. GENERAL TEXT SEARCH ACROSS YOUTUBE
        const searchResults = await searchYouTube(query);
        return res.status(200).json({
            type: 'search_results',
            results: searchResults
        });

    } catch (err) {
        return res.status(500).json({ error: err.message });
    }
}

// --- HELPER 1: Extract Spotify Playlist Tracklist Without API Keys ---
async function parseSpotifyLink(url) {
    const cleanUrl = url.split('?')[0];
    const embedUrl = cleanUrl.replace('spotify.com/', 'spotify.com/embed/');
    
    const response = await fetch(embedUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();

    // Parse Spotify's __NEXT_DATA__ JSON payload inside the embed HTML
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

// --- HELPER 2: Scrape YouTube Top Search Results Without Quota Limits ---
async function searchYouTube(query) {
    const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`;
    const response = await fetch(searchUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
    });
    const html = await response.text();

    const match = html.match(/var ytInitialData = (\{.*?\});<\/script>/);
    if (!match) return [];

    const ytData = JSON.parse(match[1]);
    const contents = ytData.contents?.twoColumnSearchResultsRenderer?.primaryContents?.sectionListRenderer?.contents[0]?.itemSectionRenderer?.contents || [];

    const results = [];
    for (const item of contents) {
        const video = item.videoRenderer;
        if (video && video.videoId) {
            results.push({
                id: video.videoId,
                title: video.title?.runs[0]?.text || "Unknown Track",
                artist: video.ownerText?.runs[0]?.text || "YouTube",
                duration: video.lengthText?.simpleText || "0:00",
                thumbnail: video.thumbnail?.thumbnails[0]?.url || `https://img.youtube.com/vi/${video.videoId}/hqdefault.jpg`
            });
            if (results.length >= 6) break; // Limit to top 6 crisp results
        }
    }
    return results;
}
