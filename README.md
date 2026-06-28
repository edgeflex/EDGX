# YouTube Transcript Server

Free YouTube transcript fetcher and channel manager. No YouTube Data API key required.

## How it works

| Feature | Method |
|---|---|
| Transcript fetch | `youtube-transcript` npm package — scrapes YouTube's timedtext caption endpoint |
| Channel video listing | YouTube public Atom RSS feed (`/feeds/videos.xml?channel_id=UC…`) |
| Channel ID resolution | One-time scrape of the channel page HTML to extract the `UC…` ID |

No API quota is consumed at any point.

## API Endpoints

| Method | Path | Params | Description |
|---|---|---|---|
| GET | `/api/presets` | — | Curated list of 50 credible YouTube channels |
| GET | `/api/rss-presets` | — | Curated list of 50 credible RSS news sources |
| GET | `/api/rss-health` | — | Per-feed health report (status, failures, quarantine) |
| POST | `/api/rss-health/reset` | `{url}` | Clear quarantine for one feed, or all if no url |
| POST | `/api/rss-health/quarantine` | `{url}` | Manually quarantine a feed |
| GET | `/api/broadcast/latest` | — | Manifest of the most recent EDGX News bulletin |
| GET | `/api/broadcast/:slug/audio` | — | Stream a bulletin's stitched MP3 |
| GET | `/api/broadcast/:slug/script` | — | A bulletin's full Jane/Brandon script (JSON) |
| POST | `/api/broadcast/run` | `{renderAudio}` | Generate a bulletin on demand |
| GET | `/api/storage` | — | Where data is stored and whether it persists across redeploys |
| GET | `/api/broadcast/preflight` | — | Green-light check: API keys + storage durability + feed health |
| GET | `/api/health` | — | Railway health check |
| GET | `/api/transcript` | `url` | Fetch transcript for a single video URL |
| GET | `/api/channel/resolve` | `input` | Resolve a @handle or URL to a channel ID + name |
| GET | `/api/channel/videos` | `channelId` | Fetch 15 most recent videos via RSS |
| GET | `/api/channel/latest-transcript` | `channelId` | Resolve latest video + return its transcript in one call |

### Example responses

```
GET /api/transcript?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ

{
  "videoId": "dQw4w9WgXcQ",
  "lines": [
    { "text": "Never gonna give you up", "offset": 18540, "duration": 1960 },
    ...
  ]
}
```

```
GET /api/channel/resolve?input=@mkbhd

{
  "channelId": "UCBcRF18a7Qf58cCRy5xuWwQ",
  "name": "Marques Brownlee"
}
```

```
GET /api/channel/videos?channelId=UCBcRF18a7Qf58cCRy5xuWwQ

{
  "channelId": "UCBcRF18a7Qf58cCRy5xuWwQ",
  "videos": [
    {
      "videoId": "abc123",
      "title": "Video Title",
      "published": "Jun 20, 2026",
      "thumbnail": "https://i.ytimg.com/vi/abc123/mqdefault.jpg",
      "url": "https://www.youtube.com/watch?v=abc123"
    },
    ...
  ]
}
```

## Proprietary Engines (automatic)

Every transcript fetch automatically runs four deterministic analysis engines. All values are derived purely from the real caption text and timing data — no LLM, no randomness, no fabricated data. Given identical input, output is byte-identical.

| Engine | Method | Output |
|---|---|---|
| **SmartChapters™** | TextTiling-style topic segmentation: cosine similarity between adjacent text blocks; topic boundaries detected at similarity valleys (local minima below mean − ½σ) | Chapters with timestamp + auto-titled from top terms |
| **KeyMoments™** | Line salience ranking: TF-IDF term mass × speech-rate anomaly (slower-than-baseline delivery signals emphasis), normalised 0–100 | Top moments ranked, presented chronologically |
| **InstantSummary™** | Extractive TextRank: weighted PageRank over a sentence-similarity graph (40 fixed iterations, damping 0.85) | The most central real sentences, in order |
| **TranscriptDNA™** | Readability/pace fingerprint from real timings: words-per-minute, type-token ratio, vocabulary tier, talk density, sentence complexity | Radar profile + raw metrics |

These are computed server-side in `engines.js` and returned in the `analysis` field of `/api/transcript` and `/api/channel/latest-transcript`. The frontend renders them automatically beneath the transcript.

### Determinism

`engines.js` uses no `Date.now()`, no `Math.random()`, and no external state. The same transcript always produces the same analysis.

## Deploy to Railway

### Option A — GitHub → Railway (recommended)

1. Push this repo to GitHub
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub repo
3. Select the repo — Railway auto-detects Node.js and runs `npm start`
4. Done. Railway assigns a public URL.

### Option B — Railway CLI

```bash
npm install -g @railway/cli
railway login
railway init
railway up
```

### Environment variables

No environment variables are required. The server listens on `process.env.PORT` (set automatically by Railway) or port `3000` locally.

## Run locally

```bash
npm install
npm start
# Server runs at http://localhost:3000
```

Or with live reload:

```bash
npm run dev
```

## EDGX News — Hourly Two-Anchor Broadcast

At the top of every hour, the server automatically builds a professional news bulletin debated by two AI anchors — **Jane** (female) and **Brandon** (male).

### Pipeline

1. **Gather** — pulls the latest video from each preset channel via RSS (no API key) and fetches its transcript.
2. **Extract → Dedupe → Rank** (`news-engine.js`) — turns transcripts into candidate stories, then deduplicates across four layers:
   - Layer 1: exact normalised-headline hash (order-independent)
   - Layer 2: token-set Jaccard (lexical overlap)
   - Layer 3: 3-gram shingle Jaccard (phrase-level near-duplicate)
   - Layer 4: domain-entity overlap (catches the same event reported in different words, e.g. "Fed holds rates" vs "central bank keeps rates unchanged")
   Duplicates are **merged**, accumulating corroborating sources. Stories are then ranked by recency, source authority, corroboration count, and substance. Top 3 are selected.
3. **Script** (`broadcast.js`) — Groq (`llama-3.3-70b-versatile`) writes the two-anchor dialogue: intro, per-story segments with setup → analysis → debate → hand-off, and an outro. The model is strictly constrained to the supplied story facts — it is instructed not to invent figures, quotes, or sources.
4. **Audio** (`tts.js`) — each turn is rendered through ElevenLabs (Jane voice / Brandon voice) and the clips are stitched into one continuous MP3 with natural inter-turn gaps. No ffmpeg required.
5. **Persist** (`orchestrator.js`) — writes `{slug}-script.json`, `{slug}-script.txt`, `{slug}-broadcast.mp3`, and a manifest, plus a `latest.json` pointer.

### Scheduling

A `node-cron` job fires at minute 0 of every hour. Set `BROADCAST_AUTORUN=off` to disable it (e.g. to trigger manually via `POST /api/broadcast/run`).

### Required environment variables

See `.env.example`. The broadcast needs `GROQ_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_JANE`, and `ELEVENLABS_VOICE_BRANDON`. Everything else (transcripts, channel listing, the curated presets) works without any keys.

### Determinism & integrity

Story extraction, dedup, and ranking are pure deterministic functions of the transcript inputs — no `Math.random()`, no hidden state. The Groq script step is the only non-deterministic stage (LLM sampling), and its output is validated and normalised before use: malformed turns are dropped and speaker names are enforced to exactly `JANE` or `BRANDON`.

## Broadcast Duration Mandate (6-7 minutes)

Every broadcast is enforced to run **6 to 7 minutes** — never less. This is not left to the prompt; it is measured and enforced:

1. After each Groq draft, `estimateDuration()` computes spoken length from the word count (at a 150-wpm anchor pace) plus the inter-turn gaps the stitcher inserts.
2. If a draft comes in under the 6-minute floor (360s), the generator automatically runs an **expansion pass** — it feeds the current draft back to Groq and asks it to lengthen the *existing* discussion (more angles, sharper debate, clearer "what it means" beats) to reach the 6-7 minute target.
3. This repeats up to 3 expansion passes, keeping the longest valid draft. The result carries `meetsDurationMandate` and the measured `durationSeconds`, both surfaced in the bulletin manifest and logs.

**Integrity guardrail:** expansion never adds facts. Each pass explicitly instructs the model to lengthen only by examining the already-briefed facts more thoroughly — no invented numbers, names, or sources, and no filler or repetition. A longer broadcast is a deeper look at the same real facts.

Tunable constants live at the top of `broadcast.js`: `MIN_BROADCAST_SECONDS`, `MAX_BROADCAST_SECONDS`, `WORDS_PER_MINUTE`, `GAP_SECONDS_PER_TURN`.

## Broadcast Production EnginesThree deterministic engines sit between script generation (Groq) and voice synthesis (ElevenLabs), turning flat text into a directed two-anchor segment. They run automatically in `orchestrator.js`: `script → DialogueWeave™ → ProsodyEngine™ → VoiceDirector™ → TTS`.

**DialogueWeave™** restructures each story's turns into a genuine two-perspective debate. It deterministically assigns Jane and Brandon complementary lenses (e.g. data-led vs. skeptical, market-impact vs. human-impact, near-term vs. long-term) from the story's headline, then tags every turn with a debate role (setup, analysis, counterpoint, rebuttal, hand-off), an arc beat (open → develop → tension → resolve), and whether it reacts to the previous turn. It classifies and orders the existing dialogue — it does not invent facts.

**ProsodyEngine™** normalises punctuation for broadcast-correct delivery (smart quotes, em-dashes, spacing, abbreviation expansion like "vs." → "versus", "%" → "percent") and annotates each line with SSML — `<emphasis>` on salient domain terms, `<break>` pauses tuned per anchor, and a pacing rate. ElevenLabs consumes the clean normalised text; the SSML is preserved for portability and the on-screen direction view.

**VoiceDirector™** computes ElevenLabs `voice_settings` per turn from the anchor profile, arc beat, and debate role. Tension beats lower stability and raise style for a more dynamic, leaning-in delivery; resolves and openings settle down. Each anchor has a distinct base profile, so Jane and Brandon sound different and consistent.

All three are pure functions — no randomness, no I/O. The same script always produces the same direction. The full annotated "production script" is persisted alongside each bulletin and surfaced in the EDGX News tab (stance per story, beat/role per line).

## RSS Enrichment — 50 News Sources Mixed with YouTube

The broadcast pipeline fuses two source pools through the **same** dedup and ranking engine:

- **50 YouTube channels** (`presets.js`) — latest video + transcript per channel
- **50 RSS feeds** (`rss-presets.js`) — across World, Politics, Finance, Crypto, Tech, and Creative/Culture

`rss-sources.js` fetches feeds concurrently (bounded pool, individual failures tolerated), parses both RSS 2.0 and Atom, and emits each article in the **same story shape** the engine already understands. RSS and YouTube candidates are merged into one pool before dedup, so the same event reported by a YouTube channel and a newswire collapses into a single story — flagged `mixedSources: true` and boosted by cross-source corroboration.

Each RSS source carries an `authority` weight on the same scale as the YouTube sources, so ranking treats both pools fairly. RSS enrichment can be disabled per-run with `includeRss: false`.

**Note:** Both lists are editorial selections by institutional reputation and longevity — not an endorsement and not financial/political advice. RSS feed URLs occasionally change; a dead feed is logged and skipped, never fatal.

## Durable Storage (survives redeploys)

Bulletins (script JSON, transcript text, MP3) and the RSS feed-health / quarantine state are written through an atomic, fsync-backed storage layer (`storage.js`). To make them survive Railway redeploys and restarts, mount a Volume:

1. In Railway, add a **Volume** to the service and set its mount path to `/data`.
2. Set the env var `BROADCAST_DIR=/data`.

That's it. On boot the server logs exactly where it's writing and whether it's durable:

```
[storage] dir=/data writable=true durable=true
[storage] persistence confirmed — data survived a prior restart (boot #4, 12 bulletins on disk).
```

If you forget the Volume, the app still runs but logs a clear warning that storage is **ephemeral** and will reset on the next redeploy. Check status any time:

```bash
curl https://your-app.up.railway.app/api/storage
```

**Atomic writes:** every file is written to a temp file, fsynced, then renamed over the target. A crash mid-write can never corrupt an existing bulletin or the quarantine history — readers always see either the old complete file or the new complete file, never a partial one.

**Preflight before you rely on it:**

```bash
curl https://your-app.up.railway.app/api/broadcast/preflight
```

Returns `ready: true` only when all four API keys are present and storage is writable, and lists any warnings (missing keys, ephemeral storage) so you get a green light before triggering a full run.



Dead RSS feeds prune themselves — no manual cleanup needed after deploy.

`feed-health.js` tracks every feed's fetch outcomes across runs and persists them to `feed-health.json`. The policy:

- A feed is **quarantined** after 3 consecutive failures (configurable via `failThreshold`).
- Quarantined feeds are **skipped** entirely on subsequent runs, so the pipeline stops wasting time on dead URLs.
- Every 6 hours (configurable via `retryAfterMs`) a quarantined feed gets one **probation retry** — a single success clears the quarantine immediately, so a temporarily-down feed self-heals.

This is fully automatic. To inspect or override:

```bash
# See which feeds are healthy vs quarantined
curl https://your-app.up.railway.app/api/rss-health

# Force a re-check of one feed (clears its quarantine)
curl -X POST https://your-app.up.railway.app/api/rss-health/reset \
  -H 'Content-Type: application/json' -d '{"url":"https://feed-url"}'

# Clear ALL quarantines at once
curl -X POST https://your-app.up.railway.app/api/rss-health/reset \
  -H 'Content-Type: application/json' -d '{}'
```

After your first deploy, check `/api/rss-health` to see which of the 50 feeds resolved — any that 404 or time out three times will quietly drop out of the rotation on their own.

## Project structure

```
yttranscript/
├── server.js          # Express API server + cron scheduler
├── sources.js         # Shared YouTube fetchers (RSS feed + transcripts)
├── rss-sources.js     # RSS/Atom feed fetcher + parser (health-aware)
├── rss-presets.js     # Curated 50 RSS news sources
├── feed-health.js     # Feed health tracking + automatic pruning
├── engines.js         # Transcript analysis engines
├── news-engine.js     # Story extraction, 4-layer dedup, unified ranking
├── broadcast.js       # Groq two-anchor script generation
├── speech-engines.js  # DialogueWeave™ · ProsodyEngine™ · VoiceDirector™
├── tts.js             # ElevenLabs voice rendering + MP3 stitching
├── orchestrator.js    # Hourly pipeline (YouTube + RSS → broadcast)
├── storage.js         # Durable storage layer (atomic writes, Volume-aware)
├── presets.js         # Curated 50 YouTube channels
├── public/
│   └── index.html     # Frontend (Single Video · Channel Manager · EDGX News)
├── .env.example
├── package.json
├── railway.toml
├── Dockerfile
└── .gitignore
```

## Curated Channel Presets

The Channel Manager includes a one-click **"Load 50 trusted channels"** button that opens a category-filterable list (Finance · Crypto · Politics · Fed). Add individual channels or bulk-add everything in a category.

The list (`presets.js`) covers 16 finance, 13 crypto, 9 politics, and 12 Fed/central-bank channels — major institutions, official central-bank channels, established news outlets, and long-running analyst channels. Eight channel IDs are pre-verified from the channels' own public pages; the rest resolve from their stable `@handle` at runtime via `/api/channel/resolve`.

**Note:** The selection is editorial judgement based on institutional reputation and longevity. It is not an endorsement of any view and not financial advice. Verify any channel before relying on it.

## Rate limiting

The server applies a soft rate limit of 60 requests per minute (in-memory, per process). This protects against accidental bursts — YouTube may impose its own throttling independently.

## Known limitations

- Transcripts require captions to be enabled on the video (auto-generated or manual)
- RSS feed returns a maximum of 15 most recent videos per channel
- Private, age-restricted, and region-locked videos cannot be transcribed
- Channel ID resolution requires one HTTP request per new channel handle (result is cached in-memory for the process lifetime)
