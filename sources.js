'use strict';

/**
 * sources.js — Shared YouTube data fetchers (no YouTube Data API key).
 *
 * Both the HTTP server and the broadcast orchestrator use these functions, so
 * they live in one module to avoid duplication.
 *
 *   fetchChannelFeedFn(channelId) → latest videos via public Atom RSS
 *   fetchTranscriptFn(videoId)    → transcript lines via youtube-transcript
 */

const fetch = require('node-fetch');
const { YoutubeTranscript } = require('youtube-transcript');

/**
 * Fetch recent videos for a channel via its public Atom RSS feed.
 * Returns newest-first. No API key required.
 *
 * @param {string} channelId  — UC… channel ID
 * @returns {Promise<Array<{videoId,title,published,publishedMs,publishedRaw,thumbnail,url}>>}
 */
async function fetchChannelFeedFn(channelId) {
  if (!/^UC[a-zA-Z0-9_-]{22}$/.test(channelId)) {
    throw new Error(`Invalid channelId: ${channelId}`);
  }
  const feedUrl = `https://www.youtube.com/feeds/videos.xml?channel_id=${channelId}`;
  const res = await fetch(feedUrl, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10_000 });
  if (!res.ok) throw new Error(`RSS feed HTTP ${res.status}`);
  const xml = await res.text();

  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];
  if (entries.length === 0) return [];

  return entries.map(([, entry]) => {
    const videoId       = (entry.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)   || [])[1] || '';
    const titleRaw      = (entry.match(/<title>([^<]+)<\/title>/)             || [])[1] || 'Untitled';
    const publishedRaw  = (entry.match(/<published>([^<]+)<\/published>/)     || [])[1] || '';
    const publishedMs   = publishedRaw ? Date.parse(publishedRaw) : 0;
    const title = decodeEntities(titleRaw);
    return {
      videoId,
      title,
      publishedRaw,
      publishedMs,
      published: publishedRaw
        ? new Date(publishedRaw).toLocaleDateString('en-US', { year:'numeric', month:'short', day:'numeric' })
        : '',
      thumbnail: `https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`,
      url:       `https://www.youtube.com/watch?v=${videoId}`,
    };
  });
}

/**
 * Fetch a transcript for a video as normalised line objects.
 * @param {string} videoId
 * @returns {Promise<Array<{text,offset,duration}>>}
 */
async function fetchTranscriptFn(videoId) {
  const transcript = await YoutubeTranscript.fetchTranscript(videoId);
  if (!transcript || transcript.length === 0) {
    throw new Error('No transcript available');
  }
  return transcript.map(item => ({
    text:     item.text,
    offset:   item.offset,
    duration: item.duration,
  }));
}

/**
 * Decode the small set of XML/HTML entities that appear in RSS titles.
 * @param {string} s
 * @returns {string}
 */
function decodeEntities(s) {
  return s
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#x27;/g, "'");
}

module.exports = { fetchChannelFeedFn, fetchTranscriptFn, decodeEntities };
