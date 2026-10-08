// Downloads short interviews from podcast RSS feeds into the library, through the same safe downloader the app uses.
// Run `npx tsx src/download-audio.ts`, or `npx tsx src/download-audio.ts <feed-key>` to fetch just one entry.

import { downloadAudio } from "./fetch-audio.js";
import { fileNameForEpisode, hasAudio, recordAudio } from "./store/library.js";

interface Feed { name: string; publisher: string; url: string; perFeed: number; minSeconds?: number; maxSeconds?: number; titleMatch?: RegExp }

// minSeconds / maxSeconds: only episodes at least / at most this long (per the feed's itunes:duration) count toward perFeed.
// titleMatch: only episodes whose title matches count (used to pick the one-on-one interviews out of a mixed feed).
const FEEDS: Record<string, Feed> = {
  "foreign-affairs-interview": { name: "The Foreign Affairs Interview", publisher: "Foreign Affairs", url: "https://feed.podbean.com/foreignaffairsmagazine/feed.xml", perFeed: 2 },
  "reason-interview": { name: "The Reason Interview", publisher: "Reason", url: "https://reason.com/podcasts/the-reason-interview-with-nick-gillespie/feed/", perFeed: 2 },
  "scott-horton-show": { name: "Scott Horton Show", publisher: "Scott Horton", url: "https://feeds.megaphone.fm/scotthortonshow", perFeed: 2 },
  "lars-larson-interviews": { name: "The Lars Larson Show Interviews", publisher: "Lars Larson", url: "https://rss.buzzsprout.com/2602482.rss", perFeed: 3, maxSeconds: 600 },
  "driving-it-home": {
    name: "Driving It Home with Patti Vasquez", publisher: "WCPT 820", url: "https://www.omnycontent.com/d/playlist/a4fbb17d-6885-4043-a617-ae830105a1b2/ef8467aa-9b0c-46d0-ab47-af0801431845/5340fc95-7d4e-435d-9a65-af08014c883b/podcast.rss",
    perFeed: 3, maxSeconds: 600,
  },
  "piers-morgan-uncensored": { name: "Piers Morgan Uncensored", publisher: "Piers Morgan Uncensored", url: "https://feeds.megaphone.fm/RSV2152356740", perFeed: 8, minSeconds: 120, maxSeconds: 900 },
  "piers-morgan-interviews": {
    name: "Piers Morgan Uncensored (full interviews)", publisher: "Piers Morgan Uncensored", url: "https://feeds.megaphone.fm/RSV2152356740",
    perFeed: 7, minSeconds: 1800, maxSeconds: 4000, titleMatch: /Phil Collins|Qatar PM Speaks|Houthis|Moses Itauma|Roger Waters|Gary Stevenson|Martina Navratilova/,
  },
  "lex-fridman": {
    name: "Lex Fridman Podcast", publisher: "Lex Fridman", url: "https://lexfridman.com/feed/podcast/",
    perFeed: 3, maxSeconds: 7200, titleMatch: /^(Max Tegmark: Life 3\.0|Judea Pearl:|Noam Chomsky: Language)/,
  },
  "bbc-best-of-today": { name: "BBC Radio 4 Best of Today", publisher: "BBC", url: "https://podcasts.files.bbci.co.uk/p02nrtvg.rss", perFeed: 3, maxSeconds: 900 },
  "pbs-newshour-segments": { name: "PBS News Hour Segments", publisher: "PBS News", url: "https://www.pbs.org/newshour/feeds/rss/podcasts/segments", perFeed: 3, maxSeconds: 600 },
  "face-the-nation": {
    name: "Face the Nation with Margaret Brennan", publisher: "CBS News", url: "https://rss.amperwave.net/v2/feed/audacynetwork/1f7cbcf4fc75edeae6e4b9e605092da5",
    perFeed: 30, maxSeconds: 5400,
    // Some titles use a non-breaking space in "Extended Interview", hence \s. The panels and group interviews are left out.
    titleMatch: /^(Senator JD Vance on|Extended\s+Interview:\s+(?!America's|Former Iran detainees)|Canadian Ambassador Kirsten Hillman|Brian Moynihan \[Extended Interview\]|Rep\. Mike Waltz and Rep\. Pat Ryan|Bonus: Israeli PM Benjamin Netanyahu|Speaker Emerita Nancy Pelosi|Bill Gates on|EXTRA: +Full interview with British Prime Minister Boris Johnson)/,
  },
  "bbc-the-interview": {
    name: "The Interview", publisher: "BBC World Service", url: "https://podcasts.files.bbci.co.uk/p004t1s0.rss", perFeed: 5, maxSeconds: 1800,
    titleMatch: /^(Shami Chakrabarti|Kai Bird|Estelle Brachlianoff|Earl Spencer|Fally Ipupa)/,
  },
  "meet-the-press": {
    name: "Meet the Press", publisher: "NBC News", url: "https://podcastfeeds.nbcnews.com/yf3E6y7x", perFeed: 5, maxSeconds: 1800,
    titleMatch: /^(Full interview: Smithsonian|Meet the Moment: Reshma Saujani|Full Interview: Delcy Rodríguez|Full interview: Zohran Mamdani|Zelenskyy says Trump must apply)/i,
  },
  "fox-news-rundown": {
    name: "The Fox News Rundown", publisher: "FOX News", url: "https://feeds.megaphone.fm/FOXM1880458659", perFeed: 4, maxSeconds: 1800,
    titleMatch: /^(Extra:\s+Ending the NIL|Extra:\s+Cure Cancer or Kill Us All|Evening Edition:\s+Russian Plague|Evening Edition:\s+The Long-lasting Trauma)/,
  },
  "cnn-amanpour": {
    name: "Amanpour", publisher: "CNN", url: "https://feeds.megaphone.fm/WMHY4537236541", perFeed: 1, maxSeconds: 1800, titleMatch: /^John Kerry on a New Era/,
  },
  "cnn-one-thing": {
    name: "CNN One Thing", publisher: "CNN", url: "https://feeds.megaphone.fm/WMHY5177234123", perFeed: 2, maxSeconds: 1800,
    titleMatch: /^(Why FIFA \(or Trump\)|Are Lawmakers Taking Medical Privacy)/,
  },
  "npr-wild-card": {
    name: "Wild Card with Rachel Martin", publisher: "NPR", url: "https://feeds.npr.org/510379/podcast.xml", perFeed: 4, maxSeconds: 1800,
    titleMatch: /^(Lena Waithe|LeVar Burton|Kyle MacLachlan daydreams|Bowen Yang)/,
  },
  "npr-bullseye": {
    name: "Bullseye with Jesse Thorn", publisher: "NPR", url: "https://feeds.npr.org/510309/podcast.xml", perFeed: 4, maxSeconds: 1800,
    titleMatch: /^(Elvis Costello$|Allison Janney$|Bonus: Bullseye's 'Put You On' with (Derek Guy|Tonya Mosley))/,
  },
  "desert-island-discs": {
    name: "Desert Island Discs", publisher: "BBC Radio 4", url: "https://podcasts.files.bbci.co.uk/b006qnmr.rss", perFeed: 1, maxSeconds: 1800, titleMatch: /^Maya Angelou$/,
  },
};

// itunes:duration is plain seconds, mm:ss or hh:mm:ss.
const toSeconds = (d: string | undefined) => (d ? d.split(":").map(Number).reduce((t, p) => t * 60 + p, 0) : null);

const decode = (s: string) =>
  s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&#0?39;|&apos;/g, "\u0027");

async function episodes({ url, perFeed, minSeconds, maxSeconds, titleMatch }: Feed) {
  const xml = await (await fetch(url)).text();
  const found: { url: string; title: string; page: string }[] = [];
  const channelLink = xml.split(/<item[\s>]/)[0].match(/<link>\s*(https?:[^<\s]+)/)?.[1];
  for (const item of xml.split(/<item[\s>]/).slice(1)) {
    const enclosure = item.match(/<enclosure[^>]*\surl="([^"]+)"/)?.[1]?.replace(/&amp;/g, "&");
    const seconds = toSeconds(item.match(/<itunes:duration>\s*([\d:]+)/)?.[1]);
    if (!enclosure) continue;
    if ((minSeconds !== undefined || maxSeconds !== undefined) && (seconds === null || seconds < (minSeconds ?? 0) || seconds > (maxSeconds ?? Infinity))) continue;
    const title = item.match(/<title>(?:<!\[CDATA\[)?(.*?)(?:\]\]>)?<\/title>/s)?.[1]?.trim() ?? "episode";
    const link = item.match(/<link>\s*(https?:[^<\s]+)/)?.[1];
    if (titleMatch && !titleMatch.test(decode(title))) continue;
    found.push({ url: enclosure, title: decode(title), page: link ?? (/buzzsprout\.com\/\d+\/episodes\//.test(enclosure) ? enclosure.replace(/\.mp3$/, "") : channelLink ?? enclosure) });
    if (found.length === perFeed) break;
  }
  return found;
}

const only = process.argv[2];
for (const [show, feed] of Object.entries(FEEDS)) {
  if (only && show !== only) continue;
  let eps;
  try { eps = await episodes(feed); } catch (e) { console.error(`FAILED feed ${show}: ${e}`); continue; }
  for (const ep of eps) {
    const file = fileNameForEpisode(show, ep.title, new URL(ep.url));
    const source = { show: feed.name, publisher: feed.publisher, title: ep.title, url: ep.page };
    if (await hasAudio(file)) { await recordAudio(file, source); console.log(`have  ${file}`); continue; }
    try {
      await downloadAudio(ep.url, file, source);
      console.log(`saved ${file}`);
    } catch (e) {
      console.error(`FAILED ${ep.title}: ${e instanceof Error ? e.message : e}`);
    }
  }
}
