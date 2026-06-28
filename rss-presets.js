'use strict';

/**
 * rss-presets.js — Curated RSS feed sources
 *
 * 50 established outlets across world news, politics, economics/finance, and
 * creative/culture. Each entry has a public RSS/Atom feed URL — no API key.
 *
 * Identifier strategy:
 *   These are publisher RSS endpoints. URLs occasionally change; the fetcher
 *   degrades gracefully (a dead feed is logged and skipped, never fatal).
 *
 * Selection: editorial judgement by institutional reputation and longevity.
 *   NOT an endorsement of any view and NOT financial/political advice.
 *
 * `authority` mirrors the weighting model used for YouTube sources so the
 * ranking engine can score RSS and video stories on the same scale.
 */

const RSS_PRESETS = [

  // ─── WORLD NEWS / GENERAL ──────────────────────────────────────────────
  { category: 'World',    name: 'Reuters — World',          url: 'https://www.reutersagency.com/feed/?best-topics=world&post_type=best',     authority: 1.6 },
  { category: 'World',    name: 'Associated Press — Top',   url: 'https://feedx.net/rss/ap.xml',                                             authority: 1.6 },
  { category: 'World',    name: 'BBC News — World',         url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                              authority: 1.5 },
  { category: 'World',    name: 'The Guardian — World',     url: 'https://www.theguardian.com/world/rss',                                    authority: 1.4 },
  { category: 'World',    name: 'NPR — News',               url: 'https://feeds.npr.org/1001/rss.xml',                                       authority: 1.4 },
  { category: 'World',    name: 'Al Jazeera — All',         url: 'https://www.aljazeera.com/xml/rss/all.xml',                                authority: 1.3 },
  { category: 'World',    name: 'Deutsche Welle — Top',     url: 'https://rss.dw.com/rdf/rss-en-all',                                        authority: 1.3 },
  { category: 'World',    name: 'France 24 — World',        url: 'https://www.france24.com/en/rss',                                          authority: 1.3 },
  { category: 'World',    name: 'CBC — World',              url: 'https://www.cbc.ca/webfeed/rss/rss-world',                                 authority: 1.3 },
  { category: 'World',    name: 'The Conversation',         url: 'https://theconversation.com/global/articles.atom',                         authority: 1.3 },
  { category: 'World',    name: 'PBS NewsHour',             url: 'https://www.pbs.org/newshour/feeds/rss/headlines',                         authority: 1.4 },
  { category: 'World',    name: 'CNN — Top Stories',        url: 'http://rss.cnn.com/rss/edition.rss',                                       authority: 1.3 },

  // ─── POLITICS ──────────────────────────────────────────────────────────
  { category: 'Politics', name: 'Reuters — Politics',       url: 'https://www.reutersagency.com/feed/?best-topics=political-general&post_type=best', authority: 1.5 },
  { category: 'Politics', name: 'BBC — Politics',           url: 'https://feeds.bbci.co.uk/news/politics/rss.xml',                           authority: 1.5 },
  { category: 'Politics', name: 'The Guardian — Politics',  url: 'https://www.theguardian.com/politics/rss',                                 authority: 1.4 },
  { category: 'Politics', name: 'Politico',                 url: 'https://www.politico.com/rss/politicopicks.xml',                           authority: 1.3 },
  { category: 'Politics', name: 'The Hill',                 url: 'https://thehill.com/rss/syndicator/19110',                                 authority: 1.2 },
  { category: 'Politics', name: 'Foreign Affairs',          url: 'https://www.foreignaffairs.com/rss.xml',                                   authority: 1.4 },
  { category: 'Politics', name: 'Foreign Policy',           url: 'https://foreignpolicy.com/feed/',                                          authority: 1.3 },
  { category: 'Politics', name: 'The Economist — Latest',   url: 'https://www.economist.com/latest/rss.xml',                                 authority: 1.5 },
  { category: 'Politics', name: 'NPR — Politics',           url: 'https://feeds.npr.org/1014/rss.xml',                                       authority: 1.4 },
  { category: 'Politics', name: 'Brookings',                url: 'https://www.brookings.edu/feed/',                                          authority: 1.3 },

  // ─── ECONOMICS / FINANCE ───────────────────────────────────────────────
  { category: 'Finance',  name: 'Reuters — Business',       url: 'https://www.reutersagency.com/feed/?best-topics=business-finance&post_type=best', authority: 1.6 },
  { category: 'Finance',  name: 'Financial Times — Home',   url: 'https://www.ft.com/rss/home',                                              authority: 1.5 },
  { category: 'Finance',  name: 'CNBC — Top News',          url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100003114', authority: 1.5 },
  { category: 'Finance',  name: 'CNBC — Finance',           url: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=10000664', authority: 1.4 },
  { category: 'Finance',  name: 'MarketWatch — Top',        url: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',               authority: 1.3 },
  { category: 'Finance',  name: 'The Economist — Finance',  url: 'https://www.economist.com/finance-and-economics/rss.xml',                  authority: 1.5 },
  { category: 'Finance',  name: 'BBC — Business',           url: 'https://feeds.bbci.co.uk/news/business/rss.xml',                           authority: 1.4 },
  { category: 'Finance',  name: 'The Guardian — Business',  url: 'https://www.theguardian.com/uk/business/rss',                              authority: 1.4 },
  { category: 'Finance',  name: 'Seeking Alpha — Market',   url: 'https://seekingalpha.com/market_currents.xml',                             authority: 1.1 },
  { category: 'Finance',  name: 'Federal Reserve — Press',  url: 'https://www.federalreserve.gov/feeds/press_all.xml',                       authority: 1.7 },
  { category: 'Finance',  name: 'IMF — News',               url: 'https://www.imf.org/en/News/RSS?Language=ENG',                             authority: 1.5 },
  { category: 'Finance',  name: 'ECB — Press',              url: 'https://www.ecb.europa.eu/rss/press.html',                                 authority: 1.5 },

  // ─── CRYPTO ────────────────────────────────────────────────────────────
  { category: 'Crypto',   name: 'CoinDesk',                 url: 'https://www.coindesk.com/arc/outboundfeeds/rss/',                          authority: 1.3 },
  { category: 'Crypto',   name: 'Cointelegraph',            url: 'https://cointelegraph.com/rss',                                            authority: 1.2 },
  { category: 'Crypto',   name: 'Decrypt',                  url: 'https://decrypt.co/feed',                                                  authority: 1.2 },
  { category: 'Crypto',   name: 'The Block',                url: 'https://www.theblock.co/rss.xml',                                          authority: 1.2 },
  { category: 'Crypto',   name: 'Bitcoin Magazine',         url: 'https://bitcoinmagazine.com/feed',                                         authority: 1.1 },

  // ─── TECH ──────────────────────────────────────────────────────────────
  { category: 'Tech',     name: 'Ars Technica',             url: 'https://feeds.arstechnica.com/arstechnica/index',                          authority: 1.3 },
  { category: 'Tech',     name: 'The Verge',                url: 'https://www.theverge.com/rss/index.xml',                                   authority: 1.2 },
  { category: 'Tech',     name: 'MIT Technology Review',    url: 'https://www.technologyreview.com/feed/',                                   authority: 1.4 },
  { category: 'Tech',     name: 'Wired',                    url: 'https://www.wired.com/feed/rss',                                           authority: 1.2 },
  { category: 'Tech',     name: 'TechCrunch',               url: 'https://techcrunch.com/feed/',                                             authority: 1.1 },

  // ─── CREATIVE / CULTURE ────────────────────────────────────────────────
  { category: 'Creative', name: 'The Guardian — Culture',   url: 'https://www.theguardian.com/culture/rss',                                  authority: 1.3 },
  { category: 'Creative', name: 'NPR — Arts',               url: 'https://feeds.npr.org/1008/rss.xml',                                       authority: 1.3 },
  { category: 'Creative', name: 'Aeon',                     url: 'https://aeon.co/feed.rss',                                                 authority: 1.3 },
  { category: 'Creative', name: 'The Paris Review',         url: 'https://www.theparisreview.org/blog/feed/',                                authority: 1.2 },
  { category: 'Creative', name: 'Smithsonian Magazine',     url: 'https://www.smithsonianmag.com/rss/latest_articles/',                      authority: 1.3 },
  { category: 'Creative', name: 'Colossal — Art & Design',  url: 'https://www.thisiscolossal.com/feed/',                                     authority: 1.1 },

];

module.exports = { RSS_PRESETS };
