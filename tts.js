'use strict';

/**
 * tts.js — ElevenLabs voice rendering + broadcast stitching
 *
 * Purpose:
 *   Render each dialogue turn to speech using ElevenLabs (Jane = female voice,
 *   Brandon = male voice), then concatenate all clips into one broadcast MP3.
 *
 * Stitching:
 *   ElevenLabs returns MP3 (MPEG audio) frames. MP3 supports naive frame
 *   concatenation — joining the raw byte buffers produces a single continuous,
 *   playable MP3. A short silence gap is inserted between turns for natural
 *   pacing. We use a precomputed silent-MP3 frame buffer for the gap (no
 *   external audio tooling required), keeping the pipeline dependency-light and
 *   deployable on Railway without ffmpeg.
 *
 * Requires env:
 *   ELEVENLABS_API_KEY
 *   ELEVENLABS_VOICE_JANE      (voice_id for the female anchor)
 *   ELEVENLABS_VOICE_BRANDON   (voice_id for the male anchor)
 */

const fetch = require('node-fetch');

const ELEVEN_TTS_URL = 'https://api.elevenlabs.io/v1/text-to-speech';
const ELEVEN_MODEL    = 'eleven_turbo_v2_5'; // fast, high-quality, multilingual

/**
 * A minimal valid silent MP3 frame buffer (~0.3s of silence at 44.1kHz mono).
 * Base64-encoded MPEG-1 Layer III silent frames. Used as the inter-turn gap.
 * This is static encoded silence — not generated at runtime.
 */
const SILENCE_MP3_B64 =
  '//uQxAADwAABpAAAACAAADSAAAAETEFNRTMuMTAwVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV' +
  'VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVV';

/**
 * Render a single text turn to an MP3 buffer via ElevenLabs.
 *
 * @param {string} text
 * @param {string} voiceId
 * @param {Object} opts { apiKey, stability, similarity, style }
 * @returns {Promise<Buffer>} MP3 audio
 */
async function renderTurn(text, voiceId, opts = {}) {
  const apiKey = opts.apiKey || process.env.ELEVENLABS_API_KEY;
  if (!apiKey) throw new Error('ELEVENLABS_API_KEY is not set.');
  if (!voiceId) throw new Error('Voice ID missing for a turn.');

  const body = {
    text,
    model_id: ELEVEN_MODEL,
    voice_settings: {
      stability:        opts.stability  ?? 0.5,
      similarity_boost: opts.similarity ?? 0.75,
      style:            opts.style      ?? 0.3,
      use_speaker_boost: true,
    },
  };

  const res = await fetch(`${ELEVEN_TTS_URL}/${voiceId}`, {
    method: 'POST',
    headers: {
      'xi-api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'audio/mpeg',
    },
    body: JSON.stringify(body),
    timeout: 45_000,
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`ElevenLabs error ${res.status} for voice ${voiceId}: ${errText.slice(0, 200)}`);
  }

  const arrayBuf = await res.arrayBuffer();
  return Buffer.from(arrayBuf);
}

/**
 * Render an entire broadcast: every turn → speech, concatenated to one MP3.
 *
 * Voices are chosen per speaker. A silence gap is inserted between turns.
 * Returns the combined MP3 buffer plus per-turn metadata (byte sizes, order).
 *
 * @param {Array<{speaker, text}>} turns  — from broadcast.flattenTurns()
 * @param {Object} opts {
 *   apiKey, voiceJane, voiceBrandon,
 *   gapMs (default 350), onProgress(fn)
 * }
 * @returns {Promise<{ buffer: Buffer, parts: Array, totalBytes: number }>}
 */
async function renderBroadcast(turns, opts = {}) {
  const apiKey       = opts.apiKey       || process.env.ELEVENLABS_API_KEY;
  const voiceJane    = opts.voiceJane    || process.env.ELEVENLABS_VOICE_JANE;
  const voiceBrandon = opts.voiceBrandon || process.env.ELEVENLABS_VOICE_BRANDON;

  if (!apiKey)       throw new Error('ELEVENLABS_API_KEY is not set.');
  if (!voiceJane)    throw new Error('ELEVENLABS_VOICE_JANE is not set.');
  if (!voiceBrandon) throw new Error('ELEVENLABS_VOICE_BRANDON is not set.');
  if (!turns || turns.length === 0) throw new Error('No turns to render.');

  const chunks = [];
  const parts  = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const voiceId = turn.speaker === 'BRANDON' ? voiceBrandon : voiceJane;

    if (typeof opts.onProgress === 'function') {
      opts.onProgress({ index: i, total: turns.length, speaker: turn.speaker, direction: turn.direction });
    }

    // Prefer the production-engine outputs when present:
    //  - speakText: prosody-normalised text (falls back to raw text)
    //  - voiceSettings: per-turn VoiceDirector settings (falls back to defaults)
    const textToSpeak = turn.speakText || turn.text;
    const vs = turn.voiceSettings || {};

    const audio = await renderTurn(textToSpeak, voiceId, {
      apiKey,
      stability:  typeof vs.stability === 'number' ? vs.stability : undefined,
      similarity: typeof vs.similarity_boost === 'number' ? vs.similarity_boost : undefined,
      style:      typeof vs.style === 'number' ? vs.style : undefined,
    });
    chunks.push(audio);
    parts.push({ index: i, speaker: turn.speaker, bytes: audio.length, segmentType: turn.segmentType });

    // Beat-aware gap: tension beats run tighter, resolves get a touch more air.
    let gapMs = opts.gapMs ?? 350;
    if (turn.beat === 'tension') gapMs = Math.round(gapMs * 0.7);
    else if (turn.beat === 'resolve' || turn.segmentType === 'outro') gapMs = Math.round(gapMs * 1.3);
    if (i < turns.length - 1) chunks.push(buildSilenceGap(gapMs));
  }

  const buffer = Buffer.concat(chunks);
  return { buffer, parts, totalBytes: buffer.length };
}

/**
 * Build an inter-turn silence buffer by repeating the silent MP3 frame.
 * @param {number} ms  — approximate gap length in milliseconds
 * @returns {Buffer}
 */
function buildSilenceGap(ms) {
  const frame = Buffer.from(SILENCE_MP3_B64, 'base64');
  // The silent frame is ~300ms; repeat to approximate requested gap.
  const reps = Math.max(1, Math.round(ms / 300));
  return Buffer.concat(Array.from({ length: reps }, () => frame));
}

module.exports = {
  renderTurn,
  renderBroadcast,
  ELEVEN_MODEL,
};
