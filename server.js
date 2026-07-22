const express = require('express');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
    fs.mkdirSync(downloadsDir);
}

function runYtDlp(args) {
    return new Promise((resolve, reject) => {
        // Use python3 on Linux (Render), python on Windows
        const pythonCmd = process.platform === 'win32' ? 'python' : 'python3';
        const ytdlp = spawn(pythonCmd, ['-m', 'yt_dlp', ...args]);
        let stdout = '';
        let stderr = '';

        ytdlp.stdout.on('data', (data) => {
            stdout += data.toString();
        });

        ytdlp.stderr.on('data', (data) => {
            stderr += data.toString();
        });

        ytdlp.on('close', (code) => {
            if (code === 0) {
                resolve(stdout);
            } else {
                reject(new Error(stderr || 'yt-dlp failed'));
            }
        });

        ytdlp.on('error', (err) => {
            reject(new Error('yt-dlp not found. Please install yt-dlp: https://github.com/yt-dlp/yt-dlp'));
        });
    });
}

app.post('/api/info', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const output = await runYtDlp(['--dump-json', '--no-download', url]);
        const info = JSON.parse(output);
        
        res.json({
            title: info.title,
            thumbnail: info.thumbnail,
            duration: info.duration,
            uploader: info.uploader,
            platform: info.extractor_key
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/formats', async (req, res) => {
    const { url } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const output = await runYtDlp(['--dump-json', '--no-download', url]);
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
        res.status(500).json({ error: error.message });
    }
});

app.post('/api/download', async (req, res) => {
    const { url, format, quality } = req.body;

    if (!url) {
        return res.status(400).json({ error: 'URL is required' });
    }

    try {
        const timestamp = Date.now();
        const outputTemplate = path.join(downloadsDir, `${timestamp}-%(title)s.%(ext)s`);
        
        let args = ['-o', outputTemplate];
        
        if (format === 'audio') {
            args.push('-x', '--audio-format', 'mp3');
        } else if (quality) {
            // Use specific format if quality is provided
            args.push('-f', `${quality}+bestaudio/best`);
        } else {
            args.push('-f', 'best[ext=mp4]/best');
        }

        args.push(url);

        await runYtDlp(args);

        const files = fs.readdirSync(downloadsDir);
        const downloadedFile = files.find(f => f.startsWith(timestamp.toString()));
        
        if (downloadedFile) {
            const filePath = path.join(downloadsDir, downloadedFile);
            res.download(filePath, downloadedFile, (err) => {
                if (!err) {
                    fs.unlinkSync(filePath);
                }
            });
        } else {
            res.status(500).json({ error: 'Download failed' });
        }
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.get('/{*path}', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log('Make sure yt-dlp is installed: https://github.com/yt-dlp/yt-dlp');
});