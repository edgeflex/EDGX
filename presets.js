'use strict';

/**
 * presets.js — Curated channel preset
 *
 * Purpose: A vetted list of 50 credible, established YouTube channels across
 *          global finance, cryptocurrency, politics, and central-bank / Fed
 *          coverage. Used to one-click populate the Channel Manager.
 *
 * Identifier strategy:
 *   - `channelId` (UC…) is provided where it has been verified from the
 *     channel's own public page. These are used directly — no lookup needed.
 *   - Where only the `handle` is provided, the app resolves it to a channel ID
 *     at runtime via /api/channel/resolve (scrapes the channel page once).
 *
 * Selection criteria (editorial — institutions, established outlets, and
 *   widely-followed analysts; not an endorsement of any investment view):
 *   - Major financial news institutions (Bloomberg, CNBC, Reuters, FT, WSJ…)
 *   - Official central bank / Federal Reserve channels
 *   - Established political / public-affairs news outlets
 *   - Long-running, high-subscriber cryptocurrency education channels
 *
 * NOTE: Credibility is editorial judgement about institutional reputation and
 *       longevity. It is NOT a guarantee of accuracy and NOT financial advice.
 *       Users should verify any channel before relying on it.
 */

const CHANNEL_PRESETS = [

  // ─── GLOBAL FINANCE & MARKETS ──────────────────────────────────────────
  { category: 'Finance',  name: 'Bloomberg Television',  handle: '@markets',          channelId: 'UCIALMKvObZNtJ6AmdCLP7Lg' },
  { category: 'Finance',  name: 'Bloomberg Originals',   handle: '@business',         channelId: 'UCUMZ7gohGI9HcU9VNsr2FJQ' },
  { category: 'Finance',  name: 'Bloomberg Podcasts',    handle: '@BloombergPodcasts', channelId: 'UChF5O40UBqAc82I7-i5ig6A' },
  { category: 'Finance',  name: 'CNBC Television',       handle: '@CNBCtelevision',   channelId: 'UCrp_UI8XtuYfpiqluWLD7Lw' },
  { category: 'Finance',  name: 'CNBC',                  handle: '@CNBC',             channelId: null },
  { category: 'Finance',  name: 'CNBC International',    handle: '@cnbci',            channelId: 'UCo7a6riBFJ3tkeHjvkXPn1g' },
  { category: 'Finance',  name: 'Yahoo Finance',         handle: '@YahooFinance',     channelId: null },
  { category: 'Finance',  name: 'Reuters',               handle: '@Reuters',          channelId: null },
  { category: 'Finance',  name: 'Financial Times',       handle: '@FinancialTimes',   channelId: null },
  { category: 'Finance',  name: 'The Wall Street Journal', handle: '@wsj',            channelId: null },
  { category: 'Finance',  name: 'The Economist',         handle: '@TheEconomist',     channelId: null },
  { category: 'Finance',  name: 'Forbes',                handle: '@Forbes',           channelId: null },
  { category: 'Finance',  name: 'Real Vision',           handle: '@RealVisionFinance', channelId: null },
  { category: 'Finance',  name: 'Bloomberg Quicktake',   handle: '@BloombergQuicktake', channelId: null },
  { category: 'Finance',  name: 'CNBC-TV18',             handle: '@CNBC-TV18',        channelId: null },
  { category: 'Finance',  name: 'Morningstar',           handle: '@Morningstarinc',   channelId: null },

  // ─── CRYPTOCURRENCY ────────────────────────────────────────────────────
  { category: 'Crypto',   name: 'Coin Bureau',           handle: '@CoinBureau',       channelId: 'UCqK_GSMbpiV8spgD3ZGloSw' },
  { category: 'Crypto',   name: 'Coin Bureau Clips',     handle: '@CoinBureauClips',  channelId: 'UC-D__iMuvU30QcAyLDxwc7g' },
  { category: 'Crypto',   name: 'Benjamin Cowen',        handle: '@intothecryptoverse', channelId: null },
  { category: 'Crypto',   name: 'Bankless',              handle: '@Bankless',         channelId: null },
  { category: 'Crypto',   name: 'Unchained Podcast',     handle: '@UnchainedPodcast', channelId: null },
  { category: 'Crypto',   name: 'a16z crypto',           handle: '@a16zcrypto',       channelId: null },
  { category: 'Crypto',   name: 'CoinDesk',              handle: '@CoinDesk',         channelId: null },
  { category: 'Crypto',   name: 'Cointelegraph',         handle: '@cointelegraph',    channelId: null },
  { category: 'Crypto',   name: 'The Defiant',           handle: '@TheDefiant',       channelId: null },
  { category: 'Crypto',   name: 'Whiteboard Crypto',     handle: '@WhiteboardCrypto', channelId: null },
  { category: 'Crypto',   name: 'Andreas M. Antonopoulos', handle: '@aantonop',       channelId: null },
  { category: 'Crypto',   name: 'Real Vision Crypto',    handle: '@RealVisionCrypto', channelId: null },
  { category: 'Crypto',   name: 'Altcoin Daily',         handle: '@AltcoinDaily',     channelId: null },

  // ─── POLITICS & PUBLIC AFFAIRS ─────────────────────────────────────────
  { category: 'Politics', name: 'PBS NewsHour',          handle: '@PBSNewsHour',      channelId: null },
  { category: 'Politics', name: 'Associated Press',      handle: '@AP',               channelId: null },
  { category: 'Politics', name: 'C-SPAN',                handle: '@cspan',            channelId: null },
  { category: 'Politics', name: 'BBC News',              handle: '@BBCNews',          channelId: null },
  { category: 'Politics', name: 'Sky News',              handle: '@SkyNews',          channelId: null },
  { category: 'Politics', name: 'DW News',               handle: '@dwnews',           channelId: null },
  { category: 'Politics', name: 'Channel 4 News',        handle: '@Channel4News',     channelId: null },
  { category: 'Politics', name: 'The Guardian',          handle: '@guardian',         channelId: null },
  { category: 'Politics', name: 'CNBC Make It',          handle: '@cnbcmakeit',       channelId: 'UCH5_L3ytGbBziX0CLuYdQ1Q' },

  // ─── FEDERAL RESERVE & CENTRAL BANKS ───────────────────────────────────
  { category: 'Fed',      name: 'Federal Reserve',           handle: '@federalreserve',     channelId: null },
  { category: 'Fed',      name: 'St. Louis Fed',             handle: '@StLouisFed',         channelId: null },
  { category: 'Fed',      name: 'New York Fed',              handle: '@TheNewYorkFed',      channelId: null },
  { category: 'Fed',      name: 'Atlanta Fed',               handle: '@AtlantaFed',         channelId: null },
  { category: 'Fed',      name: 'Boston Fed',                handle: '@FederalReserveBoston', channelId: null },
  { category: 'Fed',      name: 'Chicago Fed',               handle: '@ChicagoFed',         channelId: null },
  { category: 'Fed',      name: 'Richmond Fed',              handle: '@RichmondFed',        channelId: null },
  { category: 'Fed',      name: 'Kansas City Fed',           handle: '@KansasCityFed',      channelId: null },
  { category: 'Fed',      name: 'San Francisco Fed',         handle: '@sffed',              channelId: null },
  { category: 'Fed',      name: 'European Central Bank',     handle: '@ecbeuro',            channelId: null },
  { category: 'Fed',      name: 'Bank of England',           handle: '@BankofEngland',      channelId: null },
  { category: 'Fed',      name: 'International Monetary Fund', handle: '@imf',              channelId: null },

];

module.exports = { CHANNEL_PRESETS };
