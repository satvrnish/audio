export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate');

    const query = req.query.q;
    if (!query) return res.status(400).json({ error: "Query parameter 'q' is required" });

    try {
        // 1. DIRECT YOUTUBE LINK DETECTOR
        const ytIdMatch = query.match(/(?:youtube\.com\/(?:[^\/]+\/.+\/|(?:v|e(?:mbed)?)\/|.*[?&]v=)|youtu\.be\/)([^"&?\/\s]{11})/);
        if (ytIdMatch) {
            return res.status(200).json({
                type: 'search_results',
                results: [{
                    id: ytIdMatch[1],
                    title: "YouTube Stream",
                    artist: "Direct Link",
                    duration: "--:--",
                    thumbnail: `https://img.youtube.com/vi/${ytIdMatch[1]}/hqdefault.jpg`
                }]
            });
        }

        // 2. OPEN METADATA & ARTWORK SEARCH (via iTunes Open Directory)
        const itunesUrl = `https://itunes.apple.com/search?term=${encodeURIComponent(query)}&entity=song&limit=15`;
        const itunesRes = await fetch(itunesUrl);
        const itunesData = await itunesRes.json();

        if (itunesData.results && itunesData.results.length > 0) {
            const results = itunesData.results.map(track => ({
                title: track.trackName,
                artist: track.artistName,
                album: track.collectionName,
                duration: formatMillisToTime(track.trackTimeMillis),
                // Upgrade thumbnail to crisp 1000x1000 artwork
                thumbnail: track.artworkUrl100 ? track.artworkUrl100.replace('100x100bb.jpg', '1000x1000bb.jpg') : '',
                searchQuery: `${track.trackName} ${track.artistName} audio`
            }));

            return res.status(200).json({
                type: 'curated_tracks',
                results: results
            });
        }

        // 3. FALLBACK: RAW YOUTUBE SEARCH
        const fallbackResults = await searchYouTubeInnerTube(query);
        return res.status(200).json({
            type: 'search_results',
            results: fallbackResults
        });

    } catch (err) {
        console.error("Engine Error:", err);
        return res.status(500).json({ error: err.message });
    }
}

function formatMillisToTime(ms) {
    if (!ms) return "0:00";
    const totalSecs = Math.floor(ms / 1000);
    const mins = Math.floor(totalSecs / 60);
    const secs = (totalSecs % 60).toString().padStart(2, '0');
    return `${mins}:${secs}`;
}

async function searchYouTubeInnerTube(query) {
    try {
        const response = await fetch('https://www.youtube.com/youtubei/v1/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                context: { client: { clientName: 'WEB', clientVersion: '2.20240101.01.00', hl: 'en', gl: 'US' } },
                query: query
            })
        });
        const ytData = await response.json();
        const results = [];

        function traverse(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.videoRenderer && obj.videoRenderer.videoId) {
                const v = obj.videoRenderer;
                results.push({
                    id: v.videoId,
                    title: v.title?.runs?.[0]?.text || v.title?.simpleText || "Unknown Track",
                    artist: v.ownerText?.runs?.[0]?.text || "YouTube",
                    duration: v.lengthText?.simpleText || "0:00",
                    thumbnail: v.thumbnail?.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`
                });
            }
            if (results.length >= 10) return;
            for (const key of Object.keys(obj)) {
                traverse(obj[key]);
                if (results.length >= 10) return;
            }
        }
        traverse(ytData);
        return results;
    } catch (e) {
        return [];
    }
}
