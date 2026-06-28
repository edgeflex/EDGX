'use strict';

/**
 * YouTube Transcript Server
 *
 * Purpose:   REST API for fetching YouTube transcripts and channel video
 *            listings without using the YouTube Data API.
 *
 * Strategy:
 *   - Transcripts  : youtube-transcript npm package (scrapes timedtext endpoint)
 *   - Channel feed : YouTube public Atom RSS feed (no API key required)
 *   - Channel ID   : Resolved once by scraping the channel page HTML
 *
 * Inputs:  HTTP GET requests (see routes below)
 * Outputs: JSON responses
 *
 * Assumptions:
 *   - YouTube's public RSS feed returns up to 15 most recent videos per channel
 *   - youtube-transcript package handles all caption track negotiation
 *   - No YouTube API key is used anywhere in this codebase
 *
 * Known limitations:
 *   - Channels with no captions on their latest video will return an error
 *   - YouTube may throttle aggressive scraping; rate limiting is applied server-side
 *   - RSS feed does not include view counts or video duration
 */

const express        = require('express');
const cors           = require('cors');
const fetch          = require('node-fetch');
const { YoutubeTranscript } = require('youtube-transcript');
const { analyzeTranscript } = require('./engines');
const { CHANNEL_PRESETS } = require('./presets');
const { RSS_PRESETS } = require('./rss-presets');
const { runHourlyBroadcast, OUTPUT_DIR } = require('./orchestrator');
const { FeedHealth } = require('./feed-health');
const storage = require('./storage');
const cron = require('node-cron');
const fs   = require('fs');
const path = require('path');

const app  = express();
const PORT = process.env.PORT || 3000;

// ─── In-memory channel ID cache (handle → channelId) ──────────────────────
// Avoids re-scraping the channel page on every request.
const channelIdCache = new Map();

// ─── Simple in-memory rate limiter ────────────────────────────────────────
// Prevents hammering YouTube with burst requests.
const requestTimestamps = [];
const RATE_WINDOW_MS    = 60_000;
const RATE_MAX_REQUESTS = 60;

function isRateLimited() {
  const now = Date.now();
  // Purge timestamps older than the window
  while (requestTimestamps.length && requestTimestamps[0] < now - RATE_WINDOW_MS) {
    requestTimestamps.shift();
  }
  if (requestTimestamps.length >= RATE_MAX_REQUESTS) return true;
  requestTimestamps.push(now);
  return false;
}

// ─── Middleware ────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.static('public'));   // serves index.html from /public

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Extract a YouTube video ID from any common URL format or bare ID.
 * @param {string} input
 * @returns {string|null}
 */
function extractVideoId(input) {
  if (!input) return null;
  input = input.trim();

  const patterns = [
    /youtu\.be\/([a-zA-Z0-9_-]{11})/,
    /[?&]v=([a-zA-Z0-9_-]{11})/,
    /\/embed\/([a-zA-Z0-9_-]{11})/,
    /\/shorts\/([a-zA-Z0-9_-]{11})/,
    /^([a-zA-Z0-9_-]{11})$/,
  ];

  for (const re of patterns) {
    const m = input.match(re);
    if (m) return m[1];
  }
  return null;
}

/**
 * Resolve a channel handle / URL / ID to a YouTube channel ID (UCxxx…).
 *
 * Resolution order:
 *   1. If input already looks like a UC… channel ID, return it directly.
 *   2. Check cache.
 *   3. Scrape the channel page and extract the canonical channel ID from
 *      the embedded JSON or <link rel="canonical"> tag.
 *
 * @param {string} input  — @handle, URL, or UC… channel ID
 * @returns {Promise<string>}  — resolved UC… channel ID
 */
async function resolveChannelId(input) {
  input = input.trim();

  // Bare channel ID
  if (/^UC[a-zA-Z0-9_-]{22}$/.test(input)) return input;

  // Extract @handle or path segment from URL
  let handle = input;
  const handleMatch = input.match(/youtube\.com\/(?:@|c\/|user\/)?([A-Za-z0-9_.-]+)/);
  if (handleMatch) handle = handleMatch[1];
  // Normalise: strip leading @ for cache key
  const cacheKey = handle.replace(/^@/, '').toLowerCase();

  if (channelIdCache.has(cacheKey)) return channelIdCache.get(cacheKey);

  // Construct the URL to scrape
  let channelUrl;
  if (input.startsWith('http')) {
    channelUrl = input.split('?')[0]; // drop query params
  } else if (input.startsWith('@')) {
    channelUrl = `https://www.youtube.com/${input}`;
  } else {
    channelUrl = `https://www.youtube.com/@${input}`;
  }

  const res = await fetch(channelUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept-Language': 'en-US,en;q=0.9',
    },
    timeout: 10_000,
  });

  if (!res.ok) throw new Error(`Channel page returned HTTP ${res.status}`);
  const html = await res.text();

  // Strategy A: externalId in ytInitialData
  const externalIdMatch = html.match(/"externalId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
  if (externalIdMatch) {
    channelIdCache.set(cacheKey, externalIdMatch[1]);
    return externalIdMatch[1];
  }

  // Strategy B: <link rel="canonical" href="https://www.youtube.com/channel/UCxxx">
  const canonicalMatch = html.match(/rel="canonical"\s+href="https:\/\/www\.youtube\.com\/channel\/(UC[a-zA-Z0-9_-]{22})"/);
  if (canonicalMatch) {
    channelIdCache.set(cacheKey, canonicalMatch[1]);
    return canonicalMatch[1];
  }

  // Strategy C: any UC… ID in the page
  const anyMatch = html.match(/"channelId"\s*:\s*"(UC[a-zA-Z0-9_-]{22})"/);
  if (anyMatch) {
    channelIdCache.set(cacheKey, anyMatch[1]);
    return anyMatch[1];
  }

  throw new Error(`Could not resolve channel ID for: ${input}. The channel may not exist or may be private.`);
}

/**
 * Fetch the 15 most recent videos for a channel using its public Atom RSS feed.
 * YouTube exposes this feed without any API key.
 *
 * Feed URL: https://www.youtube.com/feeds/videos.xml?channel_id=UC…
 *
 * @param {string} channelId  — UC… channel ID
 * @returns {Promise<Array<{ videoId, title, published, thumbnail }>>}
 */
async function fetchChannelFeed(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;

  const res = await fetch(feedUrl, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 10_000,
  });

  if (!res.ok) throw new Error(`RSS feed returned HTTP ${res.status} for channel ${channelId}`);
  const xml = await res.text();

  // Parse Atom XML — no external XML parser needed, structure is stable
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];

  if (entries.length === 0) {
    throw new Error('No videos found in channel RSS feed. The channel may have no public videos.');
  }

  return entries.map(([, entry]) => {
    const videoId   = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)   || [])[1] || '';
    const title     = (entry.match(/<title>([^<]+)<\/title>/)              || [])[1] || 'Untitled';
    const published = (entry.match(/<published>([^<]+)<\/published>/)      || [])[1] || '';
    const thumbnail = `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`;

    return {
      videoId,
      title:     title.replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>').replace(/&quot;/g,'"').replace(/&#39;/g,"'"),
      published: published ? new Date(published).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' }) : '',
      thumbnail,
      url:       `https://www.youtube.com/watch?v=${videoId}`,
    };
  });
}

/**
 * Fetch the channel name from the Atom feed's <title> tag.
 * @param {string} channelId
 * @returns {Promise<string>}
 */
async function fetchChannelName(channelId) {
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10_000 });
  if (!res.ok) return channelId;
  const xml = await res.text();
  // The first <title> in the feed is the channel name (second is the first video title)
  const m = xml.match(/<title>([^<]+)<\/title>/);
  return m ? m[1].replace(/&amp;/g,'&') : channelId;
}

// ─── Routes ───────────────────────────────────────────────────────────────

/**
 * GET /api/transcript?url=<youtube-url>
 *
 * Fetch the transcript for a single YouTube video.
 * Uses the youtube-transcript package which scrapes YouTube's timedtext API.
 *
 * Response: { videoId, lines: [{ text, offset, duration }] }
 */
app.get('/api/transcript', async (req, res) => {
  if (isRateLimited()) {
    return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
  }

  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Missing required query parameter: url' });

  const videoId = extractVideoId(url);
  if (!videoId) return res.status(400).json({ error: 'Could not extract a valid YouTube video ID from the provided URL.' });

  try {
    const transcript = await YoutubeTranscript.fetchTranscript(videoId);

    if (!transcript || transcript.length === 0) {
      return res.status(404).json({ error: 'No transcript available for this video. Captions may be disabled by the uploader.' });
    }

    const lines = transcript.map(item => ({
      text:     item.text,
      offset:   item.offset,   // milliseconds
      duration: item.duration, // milliseconds
    }));

    // Run all four proprietary engines automatically on every fetch.
    const analysis = analyzeTranscript(lines);

    return res.json({ videoId, lines, analysis });
  } catch (err) {
    const msg = err.message || 'Unknown error';

    if (msg.includes('disabled') || msg.includes('Disabled')) {
      return res.status(404).json({ error: 'Transcripts are disabled for this video.' });
    }
    if (msg.includes('unavailable') || msg.includes('private')) {
      return res.status(404).json({ error: 'Video is unavailable or private.' });
    }
    if (msg.includes('Too Many')) {
      return res.status(429).json({ error: 'YouTube is throttling requests. Please wait and try again.' });
    }

    console.error(`[transcript] videoId=${videoId} error:`, msg);
    return res.status(500).json({ error: `Transcript fetch failed: ${msg}` });
  }
});

/**
 * GET /api/channel/resolve?input=<handle-or-url>
 *
 * Resolve a channel handle / URL to a channel ID and name.
 * Result is cached in memory for the lifetime of the server process.
 *
 * Response: { channelId, name }
 */
app.get('/api/channel/resolve', async (req, res) => {
  if (isRateLimited()) {
    return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
  }

  const { input } = req.query;
  if (!input) return res.status(400).json({ error: 'Missing required query parameter: input' });

  try {
    const channelId = await resolveChannelId(input);
    const name      = await fetchChannelName(channelId);
    return res.json({ channelId, name });
  } catch (err) {
    console.error(`[resolve] input="${input}" error:`, err.message);
    return res.status(404).json({ error: err.message });
  }
});

/**
 * GET /api/channel/videos?channelId=UC…
 *
 * Fetch the 15 most recent videos for a channel via its public RSS feed.
 * No YouTube API key is used.
 *
 * Response: { channelId, videos: [{ videoId, title, published, thumbnail, url }] }
 */
app.get('/api/channel/videos', async (req, res) => {
  if (isRateLimited()) {
    return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
  }

  const { channelId } = req.query;
  if (!channelId) return res.status(400).json({ error: 'Missing required query parameter: channelId' });
  if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
    return res.status(400).json({ error: 'Invalid channelId format. Must be a UC… YouTube channel ID.' });
  }

  try {
    const videos = await fetchChannelFeed(channelId);
    return res.json({ channelId, videos });
  } catch (err) {
    console.error(`[videos] channelId=${channelId} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/channel/latest-transcript?channelId=UC…
 *
 * Convenience endpoint: fetches the most recent video for a channel and
 * immediately returns its transcript. This is the primary use-case.
 *
 * Response: { channelId, video: { videoId, title, published, thumbnail, url }, lines: [...] }
 */
app.get('/api/channel/latest-transcript', async (req, res) => {
  if (isRateLimited()) {
    return res.status(429).json({ error: 'Rate limit reached. Please wait a moment and try again.' });
  }

  const { channelId } = req.query;
  if (!channelId) return res.status(400).json({ error: 'Missing required query parameter: channelId' });
  if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
    return res.status(400).json({ error: 'Invalid channelId format.' });
  }

  try {
    const videos = await fetchChannelFeed(channelId);

    if (!videos.length) {
      return res.status(404).json({ error: 'No videos found for this channel.' });
    }

    const latest = videos[0]; // RSS feed returns videos newest-first

    let transcript;
    try {
      transcript = await YoutubeTranscript.fetchTranscript(latest.videoId);
    } catch (err) {
      return res.status(404).json({
        error: `Could not fetch transcript for latest video "${latest.title}": ${err.message}`,
        video: latest,
      });
    }

    if (!transcript || transcript.length === 0) {
      return res.status(404).json({
        error: `Latest video "${latest.title}" has no available transcript.`,
        video: latest,
      });
    }

    const lines = transcript.map(item => ({
      text:     item.text,
      offset:   item.offset,
      duration: item.duration,
    }));

    return res.json({
      channelId,
      video: latest,
      lines,
      analysis: analyzeTranscript(lines),
    });
  } catch (err) {
    console.error(`[latest-transcript] channelId=${channelId} error:`, err.message);
    return res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/presets
 *
 * Returns the curated list of 50 credible finance / crypto / politics / Fed
 * channels. Each entry has { category, name, handle, channelId }.
 * channelId is null where it must be resolved at runtime via /api/channel/resolve.
 *
 * Response: { count, presets: [...] }
 */
app.get('/api/presets', (_req, res) => {
  res.json({ count: CHANNEL_PRESETS.length, presets: CHANNEL_PRESETS });
});

/**
 * GET /api/rss-presets
 * Returns the 50 curated RSS news sources used to enrich the broadcast.
 */
app.get('/api/rss-presets', (_req, res) => {
  res.json({ count: RSS_PRESETS.length, presets: RSS_PRESETS });
});

/**
 * ─── Feed Health (auto-pruning admin) ───────────────────────────────────
 *
 * GET  /api/rss-health           — full health report (status per feed)
 * POST /api/rss-health/reset     — clear quarantine for a feed { url } or all
 * POST /api/rss-health/quarantine— manually quarantine a feed { url }
 */
app.get('/api/rss-health', (_req, res) => {
  try {
    const health = new FeedHealth({ dir: OUTPUT_DIR });
    res.json(health.report());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/rss-health/reset', express.json(), (req, res) => {
  try {
    const health = new FeedHealth({ dir: OUTPUT_DIR });
    const url = req.body?.url;
    if (url) {
      const existed = health.reset(url);
      return res.json({ ok: true, reset: existed ? 1 : 0, url });
    }
    // Reset all quarantined feeds
    const rep = health.report();
    let n = 0;
    for (const f of rep.feeds) {
      if (f.status === 'quarantined') { health.reset(f.url); n++; }
    }
    res.json({ ok: true, reset: n });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/rss-health/quarantine', express.json(), (req, res) => {
  try {
    const url = req.body?.url;
    if (!url) return res.status(400).json({ error: 'Missing url.' });
    const health = new FeedHealth({ dir: OUTPUT_DIR });
    health.quarantine(url);
    res.json({ ok: true, quarantined: url });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * ─── EDGX Hourly Broadcast ──────────────────────────────────────────────
 *
 * GET  /api/broadcast/latest        — manifest of the most recent bulletin
 * GET  /api/broadcast/:slug/audio   — stream the bulletin MP3
 * GET  /api/broadcast/:slug/script  — the bulletin script (JSON)
 * POST /api/broadcast/run           — trigger a bulletin on demand
 *
 * The scheduler (node-cron) runs the pipeline at minute 0 of every hour.
 */

// Guard so only one broadcast builds at a time (pipeline is heavy)
let broadcastInFlight = false;

async function buildBroadcast(opts = {}) {
  if (broadcastInFlight) throw new Error('A broadcast is already being generated.');
  broadcastInFlight = true;
  try {
    return await runHourlyBroadcast({
      now:          new Date(),
      windowMs:     3_600_000,
      topN:         3,
      groqApiKey:   process.env.GROQ_API_KEY,
      elevenApiKey: process.env.ELEVENLABS_API_KEY,
      voiceJane:    process.env.ELEVENLABS_VOICE_JANE,
      voiceBrandon: process.env.ELEVENLABS_VOICE_BRANDON,
      renderAudio:  opts.renderAudio !== false,
      log:          (m) => console.log(m),
    });
  } finally {
    broadcastInFlight = false;
  }
}

app.get('/api/broadcast/latest', (_req, res) => {
  try {
    const p = path.join(OUTPUT_DIR, 'latest.json');
    if (!fs.existsSync(p)) {
      return res.status(404).json({ error: 'No broadcast has been generated yet.' });
    }
    res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/broadcast/:slug/audio', (req, res) => {
  const slug = req.params.slug.replace(/[^0-9A-Za-z-]/g, ''); // sanitise
  const p = path.join(OUTPUT_DIR, `${slug}-broadcast.mp3`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Audio not found for this bulletin.' });
  res.setHeader('Content-Type', 'audio/mpeg');
  fs.createReadStream(p).pipe(res);
});

app.get('/api/broadcast/:slug/script', (req, res) => {
  const slug = req.params.slug.replace(/[^0-9A-Za-z-]/g, '');
  const p = path.join(OUTPUT_DIR, `${slug}-script.json`);
  if (!fs.existsSync(p)) return res.status(404).json({ error: 'Script not found for this bulletin.' });
  res.json(JSON.parse(fs.readFileSync(p, 'utf8')));
});

app.post('/api/broadcast/run', express.json(), async (req, res) => {
  try {
    const renderAudio = req.body?.renderAudio !== false;
    const manifest = await buildBroadcast({ renderAudio });
    res.json({ ok: true, manifest });
  } catch (err) {
    console.error('[broadcast] run failed:', err.message);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Schedule: minute 0 of every hour. Disabled when BROADCAST_AUTORUN=off.
if (process.env.BROADCAST_AUTORUN !== 'off') {
  cron.schedule('0 * * * *', async () => {
    console.log('[cron] Hourly broadcast trigger fired.');
    try { await buildBroadcast({ renderAudio: true }); }
    catch (err) { console.error('[cron] Broadcast failed:', err.message); }
  });
  console.log('[EDGX] Hourly broadcast scheduler armed (minute 0 every hour).');
}

/**
 * GET /api/health
 * Railway health check endpoint.
 */
app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/**
 * GET /api/storage
 * Reports where data is stored and whether it is durable across redeploys.
 */
app.get('/api/storage', (_req, res) => {
  res.json(storage.describeStorage());
});

/**
 * GET /api/broadcast/preflight
 *
 * Green-light check before relying on the broadcast pipeline. Verifies:
 *   - all four API keys are present
 *   - storage is writable and (ideally) durable
 *   - reports how many RSS feeds are currently healthy vs quarantined
 * Returns ready:true only when nothing blocks a full broadcast.
 */
app.get('/api/broadcast/preflight', (_req, res) => {
  const keys = {
    GROQ_API_KEY:             !!process.env.GROQ_API_KEY,
    ELEVENLABS_API_KEY:       !!process.env.ELEVENLABS_API_KEY,
    ELEVENLABS_VOICE_JANE:    !!process.env.ELEVENLABS_VOICE_JANE,
    ELEVENLABS_VOICE_BRANDON: !!process.env.ELEVENLABS_VOICE_BRANDON,
  };
  const missingKeys = Object.entries(keys).filter(([, v]) => !v).map(([k]) => k);

  const store = storage.describeStorage();

  let feeds = { tracked: 0, healthy: 0, quarantined: 0 };
  try {
    const rep = new FeedHealth({ dir: OUTPUT_DIR }).report();
    feeds = { tracked: rep.tracked, healthy: rep.healthy, quarantined: rep.quarantined };
  } catch (_) {}

  const ready = missingKeys.length === 0 && store.writable;

  res.json({
    ready,
    keys,
    missingKeys,
    storage: {
      dir: store.dir,
      writable: store.writable,
      durable: store.durable,
      note: store.durabilityNote,
      bulletinCount: store.bulletinCount,
    },
    feeds,
    warnings: [
      ...(store.writable ? [] : ['Storage is not writable — bulletins cannot be saved.']),
      ...(store.durable ? [] : ['Storage is ephemeral — set BROADCAST_DIR to a Railway Volume mount (e.g. /data) so bulletins and feed-health survive redeploys.']),
      ...(missingKeys.length ? [`Missing API keys: ${missingKeys.join(', ')}. Audio generation will fail.`] : []),
    ],
  });
});

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`YouTube Transcript Server running on port ${PORT}`);

  // Storage durability report at boot — makes ephemeral storage impossible to miss.
  const store = storage.describeStorage();
  const persist = storage.touchPersistMarker();
  console.log(`[storage] dir=${store.dir} writable=${store.writable} durable=${store.durable}`);
  if (!store.durable) {
    console.warn('[storage] WARNING: storage is EPHEMERAL. Set BROADCAST_DIR to a Railway Volume mount (e.g. /data) to persist bulletins and feed-health across redeploys.');
  }
  if (persist.persistedAcrossRestart) {
    console.log(`[storage] persistence confirmed — data survived a prior restart (boot #${persist.marker.boots}, ${store.bulletinCount} bulletins on disk).`);
  } else {
    console.log('[storage] first boot with this storage (no prior marker found).');
  }
});
