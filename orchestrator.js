'use strict';

/**
 * orchestrator.js — EDGX hourly broadcast pipeline
 *
 * Ties the full pipeline together:
 *   1. Pull latest video from each preset channel (RSS, no API key)
 *   2. Fetch each video's transcript
 *   3. Extract → dedupe (3-layer + entity) → rank → top 3 stories
 *   4. Generate the Jane/Brandon script via Groq
 *   5. Render both voices via ElevenLabs and stitch to one MP3
 *   6. Persist the bulletin (script JSON, transcript text, MP3) to disk
 *
 * Each stage is independently fault-tolerant: a single channel or transcript
 * failure is logged and skipped rather than aborting the whole bulletin.
 *
 * Designed to be called once per hour by the scheduler, or on demand via API.
 */

const fs   = require('fs');
const path = require('path');

const { fetchChannelFeedFn, fetchTranscriptFn } = require('./sources');
const { fetchAllRss } = require('./rss-sources');
const { FeedHealth } = require('./feed-health');
const { selectTopStories } = require('./news-engine');
const { generateScript, renderScriptText } = require('./broadcast');
const { produceScript, flattenProduced } = require('./speech-engines');
const { renderBroadcast } = require('./tts');
const { CHANNEL_PRESETS } = require('./presets');
const { RSS_PRESETS } = require('./rss-presets');
const storage = require('./storage');

const OUTPUT_DIR = storage.DATA_DIR;

// Ensure output directory exists (delegates to storage module)
function ensureDir() {
  return storage.ensureDir();
}

/**
 * Format an hour label and date label for the bulletin metadata.
 * @param {Date} d
 * @returns {{ hourLabel, dateLabel, slug }}
 */
function buildTimeMeta(d) {
  const hourLabel = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
  const dateLabel = d.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const slug = `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}-${String(d.getUTCHours()).padStart(2,'0')}00`;
  return { hourLabel, dateLabel, slug };
}

/**
 * Stage 1+2: gather the latest video + transcript for each preset channel,
 * limited to those published within the lookback window.
 *
 * @param {Object} opts { nowMs, windowMs, maxChannels, log }
 * @returns {Promise<Array>} videos with transcripts
 */
async function gatherVideos(opts = {}) {
  const nowMs       = opts.nowMs ?? Date.now();
  const windowMs    = opts.windowMs ?? 3_600_000;
  const maxChannels = opts.maxChannels ?? CHANNEL_PRESETS.length;
  const log         = opts.log || (() => {});

  // Only channels with a known channelId can be fetched via RSS directly.
  const channels = CHANNEL_PRESETS.filter(c => c.channelId).slice(0, maxChannels);
  const videos = [];

  for (const ch of channels) {
    try {
      const feed = await fetchChannelFeedFn(ch.channelId);
      if (!feed || feed.length === 0) continue;

      // Latest video is first in the RSS feed
      const latest = feed[0];
      const publishedMs = latest.publishedMs ?? Date.parse(latest.publishedRaw || '') ?? 0;

      // Skip videos outside the lookback window (older than `windowMs`)
      if (nowMs && publishedMs && (nowMs - publishedMs) > windowMs) {
        log(`  skip (stale): ${ch.name}`);
        continue;
      }

      // Fetch transcript
      let lines = [];
      try {
        lines = await fetchTranscriptFn(latest.videoId);
      } catch (err) {
        log(`  no transcript: ${ch.name} (${err.message})`);
        // Still include the story using the title alone (synopsis will be empty)
      }

      videos.push({
        videoId:     latest.videoId,
        title:       latest.title,
        published:   latest.published,
        publishedMs,
        channelName: ch.name,
        channelId:   ch.channelId,
        lines,
      });
      log(`  ok: ${ch.name} — "${latest.title.slice(0, 50)}"`);
    } catch (err) {
      log(`  channel failed: ${ch.name} (${err.message})`);
    }
  }

  return videos;
}

/**
 * Run the full hourly pipeline.
 *
 * @param {Object} opts {
 *   now (Date), windowMs, topN, maxChannels,
 *   groqApiKey, elevenApiKey, voiceJane, voiceBrandon,
 *   renderAudio (bool), log (fn)
 * }
 * @returns {Promise<Object>} bulletin manifest
 */
async function runHourlyBroadcast(opts = {}) {
  ensureDir();
  const now      = opts.now || new Date();
  const nowMs    = now.getTime();
  const windowMs = opts.windowMs ?? 3_600_000;
  const topN     = opts.topN ?? 3;
  const log      = opts.log || console.log;
  const meta     = buildTimeMeta(now);

  log(`[EDGX] Building bulletin ${meta.slug} (${meta.hourLabel})`);

  // ── Stage 1: gather YouTube videos + transcripts ──
  log('[EDGX] Gathering latest YouTube videos…');
  const videos = await gatherVideos({ nowMs, windowMs, maxChannels: opts.maxChannels, log });
  log(`[EDGX] Gathered ${videos.length} YouTube videos.`);

  // ── Stage 2: gather RSS stories (unless disabled) ──
  let rssStories = [];
  if (opts.includeRss !== false) {
    log('[EDGX] Gathering RSS sources…');
    const health = opts.feedHealth || new FeedHealth({ dir: OUTPUT_DIR });
    const rss = await fetchAllRss(RSS_PRESETS, {
      nowMs, windowMs,
      maxItems: opts.rssMaxItems ?? 3,
      concurrency: opts.rssConcurrency ?? 6,
      health,
      log,
    });
    rssStories = rss.stories;
    const rep = health.report();
    log(`[EDGX] RSS: ${rss.ok} ok, ${rss.failed} failed, ${rss.skipped} quarantined → ${rssStories.length} stories. (${rep.quarantined} feeds currently pruned)`);
  }

  // Merge both source types into one candidate pool for unified dedup/ranking.
  const allCandidates = [...videos, ...rssStories];
  if (allCandidates.length === 0) {
    throw new Error('No stories available within the lookback window (YouTube or RSS) — cannot build bulletin.');
  }
  log(`[EDGX] Combined pool: ${allCandidates.length} candidates (${videos.length} video + ${rssStories.length} RSS).`);

  // ── Stage 3: extract, dedupe, rank (unified) ──
  log('[EDGX] Extracting, deduplicating, ranking…');
  const { topStories, totalCandidates, afterDedup } =
    selectTopStories(allCandidates, { nowMs, windowMs, topN });
  log(`[EDGX] ${totalCandidates} candidates → ${afterDedup} after dedup → top ${topStories.length}.`);

  if (topStories.length === 0) {
    throw new Error('No stories survived ranking — cannot build bulletin.');
  }

  // ── Stage 4: generate script via Groq ──
  log('[EDGX] Generating Jane/Brandon script via Groq…');
  const script = await generateScript(topStories, meta, { apiKey: opts.groqApiKey, log });
  if (script.duration) {
    const mm = Math.floor(script.duration.seconds / 60);
    const ss = String(script.duration.seconds % 60).padStart(2, '0');
    log(`[EDGX] Script duration: ${mm}:${ss} (${script.duration.words} words)${script.meetsDurationMandate ? '' : ' — UNDER 6-MINUTE MANDATE'}`);
  }
  const scriptText = renderScriptText(script, meta);
  log(`[EDGX] Script generated: ${script.segments.length} segments.`);

  // ── Stage 4b: production engines (DialogueWeave → Prosody → VoiceDirector) ──
  log('[EDGX] Producing script: DialogueWeave™ · ProsodyEngine™ · VoiceDirector™…');
  const produced = produceScript(script);
  const turns = flattenProduced(produced);
  log(`[EDGX] Production complete: ${turns.length} turns annotated with prosody + voice direction.`);

  // Persist script + production + transcript regardless of audio outcome
  const scriptPath  = path.join(OUTPUT_DIR, `${meta.slug}-script.json`);
  const textPath    = path.join(OUTPUT_DIR, `${meta.slug}-script.txt`);
  storage.writeFileAtomic(scriptPath, JSON.stringify({ meta, topStories: topStories.map(stripSets), script, produced }, null, 2));
  storage.writeFileAtomic(textPath, scriptText);

  const manifest = {
    slug:        meta.slug,
    hourLabel:   meta.hourLabel,
    dateLabel:   meta.dateLabel,
    generatedAt: now.toISOString(),
    stats:       {
      totalCandidates, afterDedup, topStories: topStories.length, turns: turns.length,
      durationSeconds: script.duration ? script.duration.seconds : null,
      words: script.duration ? script.duration.words : null,
      meetsDurationMandate: !!script.meetsDurationMandate,
    },
    stories:     topStories.map(s => ({
      headline:   s.headline,
      sources:    s.sources,
      score:      s.score,
      sourceType: s.sourceType,
      mixedSources: !!s.mixedSources,
      link:       s.link || '',
    })),
    files:       { script: path.basename(scriptPath), text: path.basename(textPath), audio: null },
  };

  // ── Stage 5: render audio via ElevenLabs (optional) ──
  if (opts.renderAudio !== false) {
    log('[EDGX] Rendering broadcast audio via ElevenLabs…');
    const { buffer } = await renderBroadcast(turns, {
      apiKey:       opts.elevenApiKey,
      voiceJane:    opts.voiceJane,
      voiceBrandon: opts.voiceBrandon,
      onProgress: ({ index, total, speaker }) =>
        log(`  tts ${index + 1}/${total} (${speaker})`),
    });
    const audioPath = path.join(OUTPUT_DIR, `${meta.slug}-broadcast.mp3`);
    storage.writeFileAtomic(audioPath, buffer);
    manifest.files.audio = path.basename(audioPath);
    log(`[EDGX] Audio written: ${audioPath} (${(buffer.length/1024).toFixed(0)} KB)`);
  } else {
    log('[EDGX] Audio rendering skipped (renderAudio=false).');
  }

  // Persist manifest (and update "latest" pointer)
  const manifestPath = path.join(OUTPUT_DIR, `${meta.slug}-manifest.json`);
  storage.writeFileAtomic(manifestPath, JSON.stringify(manifest, null, 2));
  storage.writeFileAtomic(path.join(OUTPUT_DIR, 'latest.json'), JSON.stringify(manifest, null, 2));

  log(`[EDGX] Bulletin ${meta.slug} complete.`);
  return manifest;
}

/**
 * Strip non-serialisable Set fields from a story for JSON persistence.
 * @param {Object} s
 */
function stripSets(s) {
  const { tokenSet, shingles, entities, ...rest } = s;
  return rest;
}

module.exports = {
  runHourlyBroadcast,
  gatherVideos,
  buildTimeMeta,
  OUTPUT_DIR,
};
