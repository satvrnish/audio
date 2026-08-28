export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 's-maxage=1800, stale-while-revalidate');

    const query = req.query.q;
    if (!query) {
        return res.status(400).json({ error: "Query parameter 'q' is required" });
    }

    try {
        // 1. DIRECT YOUTUBE LINK DETECTOR
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

        // 2. DIRECT INNERTUBE ENGINE (Direct Video IDs, Zero Rate-Limits, Instant Playback)
        const searchResults = await searchYouTubeInnerTube(query);
        return res.status(200).json({
            type: 'search_results',
            results: searchResults
        });

    } catch (err) {
        console.error("Engine API Error:", err);
        return res.status(500).json({ error: err.message || "Internal Engine Error" });
    }
}

// --- YOUTUBE INNERTUBE JSON SEARCH ENGINE ---
async function searchYouTubeInnerTube(query) {
    try {
        const response = await fetch('https://www.youtube.com/youtubei/v1/search', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
            },
            body: JSON.stringify({
                context: {
                    client: {
                        clientName: 'WEB',
                        clientVersion: '2.20240101.01.00',
                        hl: 'en',
                        gl: 'US'
                    }
                },
                query: query
            })
        });

        if (!response.ok) return [];

        const ytData = await response.json();
        const results = [];

        function traverse(obj) {
            if (!obj || typeof obj !== 'object') return;
            if (obj.videoRenderer && obj.videoRenderer.videoId) {
                const v = obj.videoRenderer;
                const rawTitle = v.title?.runs?.[0]?.text || v.title?.simpleText || "Unknown Track";
                const rawArtist = v.ownerText?.runs?.[0]?.text || v.shortBylineText?.runs?.[0]?.text || "YouTube";
                const duration = v.lengthText?.simpleText || v.lengthText?.runs?.[0]?.text || "0:00";
                const thumb = v.thumbnail?.thumbnails?.slice(-1)[0]?.url || `https://img.youtube.com/vi/${v.videoId}/hqdefault.jpg`;
                
                // Clean up editorial titles (strip out messy video tags)
                const cleanTitle = rawTitle
                    .replace(/\(.*?(official|video|audio|lyrics|hd|4k|remaster|visualizer).*?\)/gi, '')
                    .replace(/\[.*?(official|video|audio|lyrics|hd|4k|remaster|visualizer).*?\]/gi, '')
                    .trim();

                const cleanArtist = rawArtist.replace(/ - Topic|VEVO/gi, '').trim();

                results.push({
                    id: v.videoId,
                    title: cleanTitle || rawTitle,
                    artist: cleanArtist || rawArtist,
                    duration: duration,
                    thumbnail: thumb
                });
            }
            if (results.length >= 15) return;
            for (const key of Object.keys(obj)) {
                traverse(obj[key]);
                if (results.length >= 15) return;
            }
        }

        traverse(ytData);
        return results;
    } catch (err) {
        console.error("InnerTube Parse Error:", err);
        return [];
    }
}
