import { createWriteStream } from "node:fs";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const OUT_DIR = "downloads/audio";
const SOURCES_FILE = `${OUT_DIR}/sources.json`; // file name -> where the episode came from, read by the app

interface Feed { name: string; publisher: string; url: string; perFeed: number; minSeconds?: number; maxSeconds?: number; titleMatch?: RegExp }

// minSeconds / maxSeconds: only episodes at least / at most this long (per the feed's itunes:duration) count toward perFeed.
// titleMatch: only episodes whose title matches count (used to pick the one-on-one interviews out of a mixed feed).
// Run `npx tsx src/download-audio.ts <feed-key>` to fetch just one entry.
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
};

const slug = (s: string) =>
  s.toLowerCase().replace(/&[a-z#0-9]+;/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 80);

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

await mkdir(OUT_DIR, { recursive: true });
const sources: Record<string, { show: string; publisher: string; title: string; url: string }> =
  await readFile(SOURCES_FILE, "utf8").then(JSON.parse, () => ({}));

const only = process.argv[2];
for (const [show, feed] of Object.entries(FEEDS)) {
  if (only && show !== only) continue;
  let eps;
  try { eps = await episodes(feed); } catch (e) { console.error(`FAILED feed ${show}: ${e}`); continue; }
  for (const ep of eps) {
    const ext = new URL(ep.url).pathname.match(/\.(mp3|m4a|aac|wav)$/i)?.[1] ?? "mp3";
    const file = `${OUT_DIR}/${show}--${slug(ep.title)}.${ext}`;
    const record = async () => {
      sources[file.slice(OUT_DIR.length + 1)] = { show: feed.name, publisher: feed.publisher, title: ep.title, url: ep.page };
      await writeFile(SOURCES_FILE, JSON.stringify(sources, null, 2));
    };
    if (await access(file).then(() => true, () => false)) { await record(); console.log(`have  ${file}`); continue; }
    const res = await fetch(ep.url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0" } });
    if (!res.ok || !res.body) {
      console.error(`FAILED ${res.status} ${ep.title}`);
      continue;
    }
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(file));
    await record();
    console.log(`saved ${file}`);
  }
}
