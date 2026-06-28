'use strict';

/**
 * yt-sync.js — YouTube channel video listing + transcript retrieval
 *
 * Changes from original:
 *
 * 1. CAPTCHA FIX (critical):
 *    Removed direct scraping of https://www.youtube.com/api/timedtext
 *    (unauthenticated, no headers → immediate rate-limit/captcha on server IPs).
 *    Replaced with `youtube-transcript` npm package, which mimics browser
 *    requests correctly and is maintained against YouTube's anti-bot changes.
 *
 * 2. GLOBAL TRANSCRIPT CACHE (24h TTL):
 *    Caption tracks never change after upload. Repeated calls for the same
 *    videoId now return instantly from memory. Eliminates the repeat-request
 *    pattern that triggers fingerprinting.
 *
 * 3. CHANNEL VIDEO LIST CACHE (15min TTL):
 *    YouTube search quota is consumed per call. Caching video lists avoids
 *    burning quota and reduces burst behaviour on the API.
 *
 * 4. SERIALISED REQUEST QUEUE WITH JITTER:
 *    Original code ran Promise.allSettled over all channels simultaneously,
 *    producing N_channels × N_videos transcript requests as a simultaneous
 *    burst. Replaced with a global FIFO queue that enforces a minimum gap
 *    of QUEUE_MIN_GAP_MS + random jitter between transcript fetches.
 *
 * 5. EXPONENTIAL BACKOFF ON 429 / RATE_LIMIT errors:
 *    Catches rate-limit errors from youtube-transcript and backs off with
 *    doubling delay (cap: 32s) before retrying, up to MAX_RETRIES times.
 */

const { YoutubeTranscript } = require('youtube-transcript');

const { YOUTUBE_API_KEY } = process.env;
const YT_BASE = 'https://www.googleapis.com/youtube/v3';

const _fetch = typeof fetch !== 'undefined'
  ? fetch
  : (...args) => import('node-fetch').then(m => m.default(...args));

// ─── Cache ───────────────────────────────────────────────────────────────────

const TRANSCRIPT_CACHE_TTL_MS  = 24 * 60 * 60 * 1000; // captions never change
const CHANNEL_VIDEOS_CACHE_TTL = 15 * 60 * 1000;       // refresh channel list every 15min

/** @type {Map<string, { value: any, expiresAt: number }>} */
const _cache = new Map();

function cacheGet(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _cache.delete(key); return null; }
  return entry.value;
}

function cacheSet(key, value, ttlMs) {
  _cache.set(key, { value, expiresAt: Date.now() + ttlMs });
}

// Prune expired entries periodically to avoid unbounded memory growth
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache) {
    if (now > v.expiresAt) _cache.delete(k);
  }
}, 10 * 60 * 1000).unref();

// ─── Request queue with jitter ───────────────────────────────────────────────

const QUEUE_MIN_GAP_MS  = 800;   // minimum ms between transcript fetches
const QUEUE_JITTER_MS   = 1200;  // additional random jitter ceiling
const MAX_RETRIES       = 3;
const BACKOFF_BASE_MS   = 2000;
const BACKOFF_MAX_MS    = 32000;

let _queueRunning = false;

/** @type {Array<() => Promise<void>>} */
const _queue = [];

function enqueue(task) {
  return new Promise((resolve, reject) => {
    _queue.push(async () => {
      try { resolve(await task()); }
      catch (err) { reject(err); }
    });
    if (!_queueRunning) _drainQueue();
  });
}

async function _drainQueue() {
  _queueRunning = true;
  while (_queue.length > 0) {
    const task = _queue.shift();
    await task();
    if (_queue.length > 0) {
      // Deterministic gap + jitter to avoid burst fingerprinting.
      // jitter derived from current hrtime nanoseconds — not Math.random().
      const ns = Number(process.hrtime.bigint() % BigInt(QUEUE_JITTER_MS));
      const jitter = Number(ns % BigInt(QUEUE_JITTER_MS));
      await _sleep(QUEUE_MIN_GAP_MS + jitter);
    }
  }
  _queueRunning = false;
}

function _sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Transcript fetch (with retry + backoff) ─────────────────────────────────

/**
 * Fetch transcript for a single video via youtube-transcript package.
 * Returns empty string if captions are unavailable — never throws.
 *
 * Uses a cache to avoid re-fetching the same videoId.
 *
 * @param {string} videoId
 * @returns {Promise<string>}
 */
async function getTranscript(videoId) {
  // Cache hit — no network request needed
  const cached = cacheGet(`transcript:${videoId}`);
  if (cached !== null) {
    console.log(`[EDGX YT] transcript cache hit: ${videoId}`);
    return cached;
  }

  // Enqueue so concurrent channel fetches don't burst
  return enqueue(() => _fetchTranscriptWithRetry(videoId));
}

async function _fetchTranscriptWithRetry(videoId) {
  let attempt = 0;
  let delayMs = BACKOFF_BASE_MS;

  while (attempt < MAX_RETRIES) {
    try {
      const items = await YoutubeTranscript.fetchTranscript(videoId, { lang: 'en' });
      const text = items
        .map(item => (item.text || '').replace(/\[.*?\]/g, '').trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 4000);

      // Cache for 24h — captions are immutable once published
      cacheSet(`transcript:${videoId}`, text, TRANSCRIPT_CACHE_TTL_MS);
      return text;

    } catch (err) {
      attempt++;
      const isRateLimit = /rate|429|too many|captcha|unavailable/i.test(err.message);

      if (attempt >= MAX_RETRIES || !isRateLimit) {
        // Non-retriable error or exhausted retries — log and return empty
        console.warn(`[EDGX YT] transcript failed (${videoId}) after ${attempt} attempt(s): ${err.message}`);
        // Cache empty string briefly so we don't hammer a known-failed video
        cacheSet(`transcript:${videoId}`, '', 5 * 60 * 1000);
        return '';
      }

      // Back off before retry
      const cappedDelay = Math.min(delayMs, BACKOFF_MAX_MS);
      console.warn(`[EDGX YT] rate limit on ${videoId} — retry ${attempt}/${MAX_RETRIES} in ${cappedDelay}ms`);
      await _sleep(cappedDelay);
      delayMs *= 2;
    }
  }

  return '';
}

// ─── Channel video listing ────────────────────────────────────────────────────

/**
 * Fetch the most recent videos for a channel via YouTube Data API v3.
 * Results are cached for CHANNEL_VIDEOS_CACHE_TTL to avoid quota burn
 * and burst request patterns.
 *
 * @param {string} channelId
 * @param {string|null} publishedAfter  ISO 8601 string
 * @returns {Promise<Array<{videoId, title, publishedAt, channelId}>>}
 */
async function getChannelVideos(channelId, publishedAfter) {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY not set');

  const cacheKey = `videos:${channelId}:${publishedAfter || ''}`;
  const cached = cacheGet(cacheKey);
  if (cached !== null) {
    console.log(`[EDGX YT] video list cache hit: ${channelId}`);
    return cached;
  }

  const params = new URLSearchParams({
    part: 'snippet', channelId, order: 'date', type: 'video',
    maxResults: '5', key: YOUTUBE_API_KEY,
  });
  if (publishedAfter) params.set('publishedAfter', publishedAfter);

  const res = await _fetch(`${YT_BASE}/search?${params}`, {
    signal: AbortSignal.timeout(12000),
  });

  if (res.status === 429) {
    throw new Error(`YouTube API quota exceeded for channel ${channelId}`);
  }
  if (!res.ok) {
    throw new Error(`YT search HTTP ${res.status} for channel ${channelId}`);
  }

  const data = await res.json();
  const videos = (data.items || []).map(item => ({
    videoId:     item.id?.videoId,
    title:       item.snippet?.title || '',
    publishedAt: item.snippet?.publishedAt || null,
    channelId,
  }));

  cacheSet(cacheKey, videos, CHANNEL_VIDEOS_CACHE_TTL);
  return videos;
}

// ─── Public entry point ───────────────────────────────────────────────────────

/**
 * Sync transcripts for a list of channels.
 *
 * Channels are processed sequentially (not in parallel) to avoid API bursts.
 * Transcript fetches within each channel are also serialised via the global
 * queue, so a payload with 50 channels × 5 videos produces at most 1 timedtext
 * request per (QUEUE_MIN_GAP_MS + jitter) interval.
 *
 * @param {Array<{channelId: string, name?: string, lastVideoPublishedAt?: string}>} channels
 * @returns {Promise<{videos: Array}>}
 */
async function handleYtSync(channels) {
  if (!YOUTUBE_API_KEY) throw new Error('YOUTUBE_API_KEY not set in Railway Variables');
  if (!Array.isArray(channels) || !channels.length) return { videos: [] };

  const videos = [];

  // Sequential channel processing — avoids simultaneous API burst
  for (const ch of channels) {
    try {
      const raw = await getChannelVideos(ch.channelId, ch.lastVideoPublishedAt || null);

      for (const v of raw) {
        if (!v.videoId) continue;
        if (
          ch.lastVideoPublishedAt &&
          v.publishedAt &&
          v.publishedAt <= ch.lastVideoPublishedAt
        ) continue;

        // Transcript fetch is queued globally — no burst
        const transcript = await getTranscript(v.videoId);

        videos.push({
          videoId:     v.videoId,
          channelId:   ch.channelId,
          channelName: ch.name || ch.channelId,
          title:       v.title,
          publishedAt: v.publishedAt,
          transcript,
        });
      }
    } catch (err) {
      console.warn(`[EDGX YT] channel ${ch.channelId}: ${err.message}`);
    }
  }

  return { videos };
}

module.exports = { handleYtSync };
