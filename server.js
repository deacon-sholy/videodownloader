const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

// ==================== PERFORMANCE MIDDLEWARE ====================
app.use(compression({ level: 6, memLevel: 9 })); // Gzip compression for smaller payloads

// Aggressive caching for static assets
const staticOptions = {
    maxAge: '7d',
    etag: true,
    lastModified: true,
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.svg')) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        } else if (filePath.endsWith('.css') || filePath.endsWith('.js')) {
            res.setHeader('Cache-Control', 'public, max-age=86400');
        } else if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'public, max-age=300');
        }
    }
};
app.use(express.static(path.join(__dirname, 'public'), staticOptions));

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir, { recursive: true });
}

// Clean old downloads every 10 minutes to prevent disk buildup
setInterval(() => {
    try {
        const files = fs.readdirSync(downloadsDir);
        const now = Date.now();
        for (const file of files) {
            const filePath = path.join(downloadsDir, file);
            const stats = fs.statSync(filePath);
            if (now - stats.mtimeMs > 5 * 60 * 1000) { // Delete files older than 5 minutes
                fs.unlinkSync(filePath);
            }
        }
    } catch (e) { /* silently clean */ }
}, 10 * 60 * 1000);

// Deno path for yt-dlp JS runtime support (required for YouTube extraction)
const DENO_PATH = process.platform === 'win32'
    ? path.join(process.env.USERPROFILE || 'C:\\Users\\dell', '.deno', 'bin', 'deno.exe')
    : '/root/.deno/bin/deno';

function runYtDlp(args, isYouTube = false) {
    return new Promise((resolve, reject) => {
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        
        // Base performance flags — optimized for speed
        const ytArgs = [
            '--concurrent-fragments', '10',
            '--compat-options', 'no-live-chat',
            '--no-overwrites',
            '--no-part',
            '--buffer-size', '64K',
            '--socket-timeout', '30',
        ];

        // YouTube-specific flags to bypass bot detection
        if (isYouTube) {
            // Try multiple client approaches for YouTube robustness
            ytArgs.push(
                '--extractor-args', [
                    'youtube:player_client=android,android_creator,android_music,ios,web',
                    'youtube:skip=webpage:downloads',
                    'youtube:player_skip=webpage,configs',
                ].join(';'),
                '--js-runtimes', 'deno',
                '--extractor-retries', '3',
                '--fragment-retries', '10',
                '--retry-sleep-fragment', '1',
                '--retry-sleep', 'extractor=2',
                '--sleep-requests', '0.3',
                '--no-abort-on-error',
                '--geo-bypass',
            );
        } else {
            ytArgs.push(
                '--extractor-retries', '3',
                '--fragment-retries', '5',
            );
        }

        ytArgs.push(...args);
        
        const env = { ...process.env };
        if (process.platform === 'win32') {
            const denoDir = path.dirname(DENO_PATH);
            env.PATH = `${denoDir};${env.PATH}`;
        } else {
            // Ensure Deno is on PATH for Linux/Render
            env.PATH = `/root/.deno/bin:${env.PATH}`;
        }
        env.PYTHONUNBUFFERED = '1';
        
        const ytdlp = spawn(pythonCmd, ['-m', 'yt_dlp', ...ytArgs], { 
            env,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true 
        });
        
        const chunks = [];
        let stderr = '';

        ytdlp.stdout.on('data', (data) => {
            chunks.push(data);
        });

        ytdlp.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ytdlp.on('close', (code) => {
            if (code === 0) {
                resolve(Buffer.concat(chunks).toString('utf-8'));
            } else {
                // Include stderr in error for debugging
                reject(new Error(stderr || 'yt-dlp failed'));
            }
        });

        ytdlp.on('error', (err) => {
            reject(new Error('yt-dlp not found. Please install yt-dlp: https://github.com/yt-dlp/yt-dlp'));
        });

        // Timeout: 3 min for info requests, 15 min for downloads
        const timeout = args.includes('--dump-json') ? 180000 : 900000;
        const timeoutId = setTimeout(() => {
            ytdlp.kill('SIGKILL');
            reject(new Error('Request timed out'));
        }, timeout);

        ytdlp.on('close', () => clearTimeout(timeoutId));
    });
}

// Helper to detect if URL is YouTube
function isYouTubeUrl(url) {
    return /(?:youtube\.com|youtu\.be)/i.test(url);
}

app.post('/api/info', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const isYouTube = isYouTubeUrl(url);

    try {
        const infoArgs = [
            '--dump-json',
            '--no-download',
            '--no-warnings',
            '--skip-download',
            '--flat-playlist',
            url
        ];

        const output = await runYtDlp(infoArgs, isYouTube);
        const info = JSON.parse(output);
        
        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            uploader: info.uploader,
            platform: info.extractor_key
        });
    } catch (error) {
        console.error('Info fetch error:', error.message.substring(0, 500));
        res.status(500).json({ error: error.message.substring(0, 500) });
    }
});

app.post('/api/formats', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const isYouTube = isYouTubeUrl(url);

    try {
        const formatArgs = [
            '--dump-json',
            '--no-download',
            '--no-warnings',
            '--skip-download',
            '--flat-playlist',
            url
        ];

        const output = await runYtDlp(formatArgs, isYouTube);
        const info = JSON.parse(output);
        
        const formats = (info.formats || [])
            .filter(f => f.video_ext && f.video_ext !== 'none')
            .map(f => ({
                format_id: f.format_id,
                ext: f.ext,
                resolution: f.height ? `${f.height}p` : 'audio only',
                filesize: f.filesize || f.filesize_approx || null,
                vcodec: f.vcodec,
                acodec: f.acodec,
                fps: f.fps || null
            }))
            // Deduplicate by resolution, keep best quality per resolution
            .reduce((acc, f) => {
                const key = f.resolution;
                if (!acc[key] || (f.filesize && (!acc[key].filesize || f.filesize > acc[key].filesize))) {
                    acc[key] = f;
                }
                return acc;
            }, {});

        // Sort by resolution (highest first)
        const sortedFormats = Object.values(formats)
            .filter(f => f.resolution !== 'audio only')
            .sort((a, b) => {
                const aRes = parseInt(a.resolution) || 0;
                const bRes = parseInt(b.resolution) || 0;
                return bRes - aRes;
            });

        res.json({ formats: sortedFormats });
    } catch (error) {
        console.error('Formats fetch error:', error.message.substring(0, 500));
        res.status(500).json({ error: error.message.substring(0, 500) });
    }
});

app.post('/api/download', async (req, res) => {
    const { url, format, quality } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    const isYouTube = isYouTubeUrl(url);

    try {
        const timestamp = Date.now();
        const outputTemplate = path.join(downloadsDir, `${timestamp}-%(title)s.%(ext)s`);
        
        let args = ['-o', outputTemplate];
        
        // For YouTube, use more compatible format selection
        if (isYouTube) {
            if (format === 'audio') {
                args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
                args.push('-f', 'bestaudio[ext=m4a]/bestaudio');
            } else if (quality) {
                args.push('-f', `${quality}+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best`);
                args.push('--merge-output-format', 'mp4');
            } else {
                // YouTube: prefer mp4 with H.264 for broad compatibility
                args.push('-f', 'bestvideo[ext=mp4][vcodec^=avc1]+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
                args.push('--merge-output-format', 'mp4');
            }
        } else {
            // Non-YouTube: force mp4 output
            if (format === 'audio') {
                args.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
                args.push('-f', 'bestaudio/best');
            } else if (quality) {
                args.push('-f', `${quality}+bestaudio[ext=m4a]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best`);
                args.push('--merge-output-format', 'mp4');
            } else {
                args.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best[ext=mp4]/best');
                args.push('--merge-output-format', 'mp4');
            }
        }

        args.push(url);

        await runYtDlp(args, isYouTube);

        const files = fs.readdirSync(downloadsDir);
        const downloadedFile = files.find(f => f.startsWith(timestamp.toString()));
        
        if (downloadedFile) {
            const filePath = path.join(downloadsDir, downloadedFile);
            const stat = fs.statSync(filePath);
            
            // Ensure the filename ends with .mp4 for video downloads
            let safeFilename = downloadedFile;
            if (format !== 'audio' && !safeFilename.toLowerCase().endsWith('.mp4')) {
                safeFilename = safeFilename.replace(/\.[^.]+$/, '.mp4');
            }
            
            res.setHeader('Content-Length', stat.size);
            res.setHeader('Content-Type', format === 'audio' ? 'audio/mpeg' : 'video/mp4');
            res.setHeader('Content-Disposition', `attachment; filename="${safeFilename}"`);
            
            const readStream = fs.createReadStream(filePath);
            readStream.pipe(res);
            
            readStream.on('end', () => { try { fs.unlinkSync(filePath); } catch(e) {} });
            readStream.on('error', () => { try { fs.unlinkSync(filePath); } catch(e) {} });
        } else {
            res.status(500).json({ error: 'Download failed' });
        }
    } catch (error) {
        console.error('Download error:', error.message.substring(0, 500));
        res.status(500).json({ error: error.message.substring(0, 500) });
    }
});

app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'), {
        maxAge: '5m',
        etag: true
    });
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(`Compression: enabled | Cache: 7d static | Concurrent fragments: 10 | Buffer: 64K`);
    console.log('Make sure yt-dlp is installed: https://github.com/yt-dlp/yt-dlp');
});
