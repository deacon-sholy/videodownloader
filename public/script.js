document.addEventListener('DOMContentLoaded', function() {
    // ==================== PERFORMANCE: Lazy load images with Intersection Observer ====================
    if ('IntersectionObserver' in window) {
        const imgObserver = new IntersectionObserver((entries) => {
            entries.forEach(entry => {
                if (entry.isIntersecting) {
                    const img = entry.target;
                    if (img.dataset.src) {
                        img.src = img.dataset.src;
                        img.removeAttribute('data-src');
                    }
                    imgObserver.unobserve(img);
                }
            });
        }, { rootMargin: '200px' });
        window.__imgObserver = imgObserver;
    }

    // ==================== PERFORMANCE: AbortController for request cancellation ====================
    let activeRequests = [];
    let currentController = null;
    let currentTimeoutId = null;

    function abortAllRequests() {
        activeRequests.forEach(controller => controller.abort());
        activeRequests = [];
        currentController = null;
        if (currentTimeoutId) { clearTimeout(currentTimeoutId); currentTimeoutId = null; }
    }

    function createAbortSignal(timeout = 30000) {
        const controller = new AbortController();
        currentController = controller;
        activeRequests.push(controller);
        currentTimeoutId = setTimeout(() => controller.abort(), timeout);
        return controller.signal;
    }

    function cleanupRequest() {
        if (currentTimeoutId) { clearTimeout(currentTimeoutId); currentTimeoutId = null; }
        if (currentController) {
            const idx = activeRequests.indexOf(currentController);
            if (idx > -1) activeRequests.splice(idx, 1);
            currentController = null;
        }
    }

    const platformBtns = document.querySelectorAll('.platform-btn');
    const videoUrlInput = document.getElementById('videoUrl');
    const pasteBtn = document.getElementById('pasteBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const videoInfo = document.getElementById('videoInfo');
    const thumbnail = document.getElementById('thumbnail');
    const videoTitle = document.getElementById('videoTitle');
    const videoMeta = document.getElementById('videoMeta');
    const qualitySelector = document.getElementById('qualitySelector');
    const qualitySelect = document.getElementById('qualitySelect');
    const downloadVideo = document.getElementById('downloadVideo');
    const downloadAudio = document.getElementById('downloadAudio');
    const status = document.getElementById('status');
    const darkModeToggle = document.getElementById('darkModeToggle');

    let selectedPlatform = 'facebook';
    let currentVideoUrl = '';

    // ==================== DARK MODE ====================
    function applyDarkMode(enabled) {
        if (enabled) {
            document.body.classList.add('dark-mode');
            darkModeToggle.textContent = '☀️';
            darkModeToggle.title = 'Toggle Light Mode';
        } else {
            document.body.classList.remove('dark-mode');
            darkModeToggle.textContent = '🌙';
            darkModeToggle.title = 'Toggle Dark Mode';
        }
    }

    // Load saved preference
    const savedDarkMode = localStorage.getItem('darkMode') === 'true';
    applyDarkMode(savedDarkMode);

    darkModeToggle.addEventListener('click', () => {
        const isDark = !document.body.classList.contains('dark-mode');
        applyDarkMode(isDark);
        localStorage.setItem('darkMode', isDark);
    });

    // ==================== PLATFORM SELECTOR ====================
    platformBtns.forEach(btn => {
        btn.addEventListener('click', function() {
            platformBtns.forEach(b => b.classList.remove('active'));
            this.classList.add('active');
            selectedPlatform = this.dataset.platform;
            
            const placeholders = {
                facebook: 'https://www.facebook.com/...',
                instagram: 'https://www.instagram.com/...',
                tiktok: 'https://www.tiktok.com/...',
                youtube: 'https://www.youtube.com/...',
                x: 'https://twitter.com/...'
            };
            videoUrlInput.placeholder = placeholders[selectedPlatform];
        });
    });

    // ==================== PASTE BUTTON ====================
    pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                videoUrlInput.value = text;
                showStatus('URL pasted from clipboard!', 'success');
            }
        } catch (err) {
            // Fallback: focus input and let user Ctrl+V
            videoUrlInput.focus();
            showStatus('Could not access clipboard. Press Ctrl+V to paste.', 'error');
        }
    });

    // ==================== ENTER KEY TRIGGERS DOWNLOAD ====================
    videoUrlInput.addEventListener('keydown', function(e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            downloadBtn.click();
        }
    });

    // ==================== FETCH VIDEO INFO ====================
    downloadBtn.addEventListener('click', async function() {
        const url = videoUrlInput.value.trim();
        
        if (!url) {
            showStatus('Please enter a video URL', 'error');
            return;
        }

        if (!isValidUrl(url)) {
            showStatus('Please enter a valid URL', 'error');
            return;
        }

        if (!isPlatformUrl(url, selectedPlatform)) {
            showStatus(`Please enter a valid ${selectedPlatform} URL`, 'error');
            return;
        }

        // Abort any previous pending requests
        abortAllRequests();

        showStatus('Fetching video info...', 'loading');
        qualitySelector.classList.add('hidden');
        
        try {
            const signal = createAbortSignal(30000); // 30s timeout for info fetch
            const response = await fetch('/api/info', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url }),
                signal
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to fetch video info');
            }

            currentVideoUrl = url;
            
            // Lazy load thumbnail via Intersection Observer
            if (window.__imgObserver) {
                thumbnail.dataset.src = data.thumbnail;
                thumbnail.src = ''; // Clear src, observer will set it
                window.__imgObserver.observe(thumbnail);
            } else {
                thumbnail.src = data.thumbnail;
            }
            
            videoTitle.textContent = data.title;
            videoMeta.textContent = `${data.platform} • ${data.uploader} • ${formatDuration(data.duration)}`;
            
            videoInfo.classList.remove('hidden');
            showStatus('Video info loaded successfully!', 'success');

            // Fetch available qualities for video platforms
            fetchQualityOptions(url);
        } catch (error) {
            if (error.name === 'AbortError') {
                showStatus('Request timed out. Please try again.', 'error');
            } else {
                showStatus(error.message, 'error');
            }
            videoInfo.classList.add('hidden');
        } finally {
            cleanupRequest();
        }
    });

    // ==================== QUALITY SELECTION ====================
    async function fetchQualityOptions(url) {
        try {
            const signal = createAbortSignal(15000); // 15s timeout for format options
            const response = await fetch('/api/formats', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url }),
                signal
            });

            if (!response.ok) return;

            const data = await response.json();
            
            if (data.formats && data.formats.length > 0) {
                // Clear existing options except "Best Available"
                qualitySelect.innerHTML = '<option value="">Best Available</option>';
                
                data.formats.forEach(f => {
                    const option = document.createElement('option');
                    option.value = f.format_id;
                    let label = f.resolution;
                    if (f.filesize) {
                        label += ` (${formatFileSize(f.filesize)})`;
                    }
                    if (f.ext) {
                        label += ` [${f.ext}]`;
                    }
                    option.textContent = label;
                    qualitySelect.appendChild(option);
                });

                qualitySelector.classList.remove('hidden');
            }
        } catch (e) {
            // Silently fail - quality selector just stays hidden
        }
    }

    function formatFileSize(bytes) {
        if (!bytes) return '';
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(1024));
        return (bytes / Math.pow(1024, i)).toFixed(1) + ' ' + sizes[i];
    }

    // ==================== DOWNLOAD ====================
    downloadVideo.addEventListener('click', () => download('video'));
    downloadAudio.addEventListener('click', () => download('audio'));

    async function download(format) {
        if (!currentVideoUrl) {
            showStatus('No video selected', 'error');
            return;
        }

        // Abort any previous pending requests
        abortAllRequests();

        showStatus('Starting download...', 'loading');

        try {
            const body = { url: currentVideoUrl, format };
            
            // Add quality if selected and downloading video
            if (format === 'video' && qualitySelect.value) {
                body.quality = qualitySelect.value;
            }

            const signal = createAbortSignal(600000); // 10 min timeout for download
            const response = await fetch('/api/download', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify(body),
                signal
            });

            if (!response.ok) {
                const data = await response.json();
                throw new Error(data.error || 'Download failed');
            }

            const blob = await response.blob();
            const contentDisposition = response.headers.get('content-disposition');
            let filename = format === 'video' ? 'video.mp4' : 'audio.mp3';
            
            if (contentDisposition) {
                const filenameMatch = contentDisposition.match(/filename="?([^";\s]+)"?/);
                if (filenameMatch) {
                    filename = filenameMatch[1];
                }
            }
            
            // Force correct extension
            if (format === 'video' && !filename.toLowerCase().endsWith('.mp4')) {
                filename = filename.replace(/\.[^.]+$/, '.mp4');
            } else if (format === 'audio' && !filename.toLowerCase().endsWith('.mp3')) {
                filename = filename.replace(/\.[^.]+$/, '.mp3');
            }

            const blobUrl = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = filename;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);

            showStatus('Download completed!', 'success');
            resetToHomepage();
            // Delay revoke to ensure browser has started saving
            setTimeout(() => window.URL.revokeObjectURL(blobUrl), 10000);
        } catch (error) {
            if (error.name === 'AbortError') {
                showStatus('Download timed out. The video may be too large.', 'error');
            } else {
                showStatus(error.message, 'error');
            }
        } finally {
            cleanupRequest();
        }
    }

    // ==================== RESET TO HOMEPAGE ====================
    function resetToHomepage() {
        setTimeout(() => {
            videoUrlInput.value = '';
            currentVideoUrl = '';
            videoInfo.classList.add('hidden');
            qualitySelector.classList.add('hidden');
            status.classList.add('hidden');
        }, 2000);
    }

    // ==================== UTILITY FUNCTIONS ====================
    function showStatus(message, type) {
        status.textContent = message;
        status.className = `status ${type}`;
        status.classList.remove('hidden');
    }

    function isValidUrl(string) {
        try {
            new URL(string);
            return true;
        } catch (_) {
            return false;
        }
    }

    function isPlatformUrl(url, platform) {
        const platforms = {
            facebook: ['facebook.com', 'fb.com', 'fb.watch'],
            instagram: ['instagram.com'],
            tiktok: ['tiktok.com'],
            youtube: ['youtube.com', 'youtu.be', 'm.youtube.com'],
            x: ['twitter.com', 'x.com']
        };

        return platforms[platform].some(domain => url.includes(domain));
    }

    function formatDuration(seconds) {
        if (!seconds) return 'Unknown duration';
        
        const mins = Math.floor(seconds / 60);
        const secs = Math.floor(seconds % 60);
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    }
});