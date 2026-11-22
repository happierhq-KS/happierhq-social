// Happier HQ social publisher.
// Reads queue/queue.json, posts anything that's due, records results in queue/posted.json.
// Usage: node scripts/publish.js            (posts for real)
//        node scripts/publish.js --dry-run  (shows what would post, touches nothing)
//        node scripts/publish.js --check    (validates the queue file and exits)

const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const QUEUE = path.join(ROOT, "queue", "queue.json");
const POSTED = path.join(ROOT, "queue", "posted.json");

const args = new Set(process.argv.slice(2));
const DRY = args.has("--dry-run");
const CHECK = args.has("--check");

const env = (k, d) => process.env[k] || d;
const IG_BASE = env("IG_API_BASE", "https://graph.instagram.com");
const IG_VERSION = env("IG_API_VERSION", "v24.0");
const LI_BASE = env("LINKEDIN_API_BASE", "https://api.linkedin.com");
const LI_VERSION = env("LINKEDIN_VERSION", "202609");
const MEDIA_BASE_URL = (env("MEDIA_BASE_URL", "") || "").replace(/\/$/, "");
const LATE_HOURS = Number(env("LATE_LIMIT_HOURS", "12"));
const MAX_TRIES = 3;
const NOW = env("NOW_OVERRIDE") ? new Date(env("NOW_OVERRIDE")) : new Date();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJson = (f, d) => (fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, "utf8")) : d);
const log = (...a) => console.log(...a);
const isUrl = (m) => /^https?:\/\//i.test(m || "");

// ---------- validation ----------
function validate(queue) {
  const errs = [];
  const ids = new Set();
  if (!Array.isArray(queue)) return ["queue.json must be a list of posts"];
  for (const p of queue) {
    const tag = p.id || "(no id)";
    if (!p.id) errs.push(`${tag}: missing id`);
    else if (ids.has(p.id)) errs.push(`${tag}: duplicate id`);
    ids.add(p.id);
    if (!["instagram", "linkedin"].includes(p.platform)) errs.push(`${tag}: platform must be instagram or linkedin`);
    if (!p.publish_at || isNaN(Date.parse(p.publish_at))) errs.push(`${tag}: publish_at must be a date like 2026-11-09T07:00:00-05:00`);
    if (!/[zZ]|[+-]\d\d:\d\d$/.test(p.publish_at || "")) errs.push(`${tag}: publish_at needs a time zone offset`);
    if (typeof p.caption !== "string" || !p.caption.trim()) errs.push(`${tag}: caption is empty`);
    const media = Array.isArray(p.media) ? p.media : [];
    if (!media.length) errs.push(`${tag}: no media files`);
    for (const m of media) if (!isUrl(m) && !fs.existsSync(path.join(ROOT, m))) errs.push(`${tag}: file not found: ${m}`);
    const files = media.filter((m) => !isUrl(m)); // web links (like Drive images) skip the file-type checks
    const ok = {
      instagram: ["image", "carousel", "reel"],
      linkedin: ["image", "document"],
    }[p.platform] || [];
    if (!ok.includes(p.type)) errs.push(`${tag}: type for ${p.platform} must be one of ${ok.join(", ")}`);
    if (p.platform === "instagram") {
      if ((p.caption || "").length > 2200) errs.push(`${tag}: Instagram caption over 2200 characters`);
      if (p.type === "carousel" && (media.length < 2 || media.length > 10)) errs.push(`${tag}: carousel needs 2 to 10 files`);
      if (p.type !== "carousel" && media.length !== 1) errs.push(`${tag}: ${p.type} takes exactly 1 file`);
      if (p.type === "reel" && files.length && !/\.mp4$/i.test(files[0])) errs.push(`${tag}: reel must be an .mp4`);
      if (p.type !== "reel" && files.some((m) => !/\.jpe?g$/i.test(m))) errs.push(`${tag}: Instagram images must be .jpg (Instagram doesn't accept PNG)`);
    }
    if (p.platform === "linkedin") {
      if ((p.caption || "").length > 3000) errs.push(`${tag}: LinkedIn post over 3000 characters`);
      if (media.length !== 1) errs.push(`${tag}: LinkedIn post takes exactly 1 file`);
      if (p.type === "document" && files.length && !/\.pdf$/i.test(files[0])) errs.push(`${tag}: LinkedIn document must be a .pdf`);
      if (p.type === "image" && files.some((m) => !/\.(jpe?g|png)$/i.test(m))) errs.push(`${tag}: LinkedIn image must be .png or .jpg`);
    }
  }
  return errs;
}

// ---------- http ----------
async function http(method, url, { headers = {}, body, raw } = {}) {
  const opts = { method, headers: { ...headers } };
  if (raw !== undefined) opts.body = raw;
  else if (body !== undefined) {
    opts.headers["Content-Type"] = "application/json";
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) {
    const msg = (json && (json.error?.message || json.message)) || text.slice(0, 300);
    throw new Error(`${method} ${url.split("?")[0]} -> ${res.status}: ${msg}`);
  }
  return { json, headers: res.headers };
}

// ---------- instagram ----------
function igUrl(p, params = {}) {
  const u = new URL(`${IG_BASE}/${IG_VERSION}/${p}`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set("access_token", process.env.IG_ACCESS_TOKEN);
  return u.toString();
}
const publicUrl = (file) => (isUrl(file) ? file : `${MEDIA_BASE_URL}/${file.split("/").map(encodeURIComponent).join("/")}`);

async function igWaitReady(containerId, maxWaitMs) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { json } = await http("GET", igUrl(containerId, { fields: "status_code,status" }));
    if (json.status_code === "FINISHED") return;
    if (json.status_code === "ERROR" || json.status_code === "EXPIRED")
      throw new Error(`Instagram couldn't process the media (${json.status || json.status_code})`);
    await sleep(Number(env("IG_POLL_MS", "5000")));
  }
  throw new Error("Instagram took too long to process the media");
}

async function postInstagram(p) {
  const uid = process.env.IG_USER_ID;
  let containerId;
  if (p.type === "image") {
    ({ json: { id: containerId } } = await http("POST", igUrl(`${uid}/media`, { image_url: publicUrl(p.media[0]), caption: p.caption })));
  } else if (p.type === "reel") {
    ({ json: { id: containerId } } = await http("POST", igUrl(`${uid}/media`, {
      media_type: "REELS", video_url: publicUrl(p.media[0]), caption: p.caption, share_to_feed: "true",
    })));
  } else {
    const kids = [];
    for (const m of p.media) {
      const { json } = await http("POST", igUrl(`${uid}/media`, { image_url: publicUrl(m), is_carousel_item: "true" }));
      await igWaitReady(json.id, 60_000);
      kids.push(json.id);
    }
    ({ json: { id: containerId } } = await http("POST", igUrl(`${uid}/media`, {
      media_type: "CAROUSEL", children: kids.join(","), caption: p.caption,
    })));
  }
  await igWaitReady(containerId, p.type === "reel" ? 300_000 : 90_000);
  const { json } = await http("POST", igUrl(`${uid}/media_publish`, { creation_id: containerId }));
  return json.id;
}

// ---------- linkedin ----------
const liHeaders = () => ({
  Authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}`,
  "LinkedIn-Version": LI_VERSION,
  "X-Restli-Protocol-Version": "2.0.0",
});

// LinkedIn treats some characters as markup. Escape them, and turn #tags into real hashtags.
function liText(s) {
  const tags = [];
  let t = s.replace(/(^|\s)#([A-Za-z0-9_]+)/g, (_, pre, tag) => {
    tags.push(tag);
    return `${pre}\u0000${tags.length - 1}\u0000`;
  });
  t = t.replace(/[\\|{}@\[\]()<>#*_~]/g, (c) => "\\" + c);
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `{hashtag|\\#|${tags[Number(i)].replace(/_/g, "\\_")}}`);
}

async function liUpload(kind, file) {
  const owner = process.env.LINKEDIN_AUTHOR_URN;
  const { json } = await http("POST", `${LI_BASE}/rest/${kind}?action=initializeUpload`, {
    headers: liHeaders(), body: { initializeUploadRequest: { owner } },
  });
  const { uploadUrl } = json.value;
  const urn = json.value.image || json.value.document;
  await http("PUT", uploadUrl, {
    headers: { Authorization: `Bearer ${process.env.LINKEDIN_ACCESS_TOKEN}` },
    raw: isUrl(file) ? Buffer.from(await (await fetch(file)).arrayBuffer()) : fs.readFileSync(path.join(ROOT, file)),
  });
  return urn;
}

async function postLinkedIn(p) {
  const author = process.env.LINKEDIN_AUTHOR_URN;
  const file = p.media[0];
  const mediaUrn = await liUpload(p.type === "document" ? "documents" : "images", file);
  const media = { id: mediaUrn };
  if (p.type === "document") media.title = p.document_title || (isUrl(file) ? "Sheet Snacks recap" : path.basename(file, ".pdf"));
  const { headers } = await http("POST", `${LI_BASE}/rest/posts`, {
    headers: liHeaders(),
    body: {
      author,
      commentary: liText(p.caption),
      visibility: "PUBLIC",
      distribution: { feedDistribution: "MAIN_FEED", targetEntities: [], thirdPartyDistributionChannels: [] },
      content: { media },
      lifecycleState: "PUBLISHED",
      isReshareDisabledByAuthor: false,
    },
  });
  const postUrn = headers.get("x-restli-id");
  let note = "";
  if (p.first_comment && postUrn) {
    try {
      await sleep(Number(env("LI_COMMENT_DELAY_MS", "8000")));
      await http("POST", `${LI_BASE}/rest/socialActions/${encodeURIComponent(postUrn)}/comments`, {
        headers: liHeaders(),
        body: { actor: author, object: postUrn, message: { text: p.first_comment } },
      });
    } catch (e) {
      note = `post is up but the first comment failed: ${e.message}`;
    }
  }
  return { id: postUrn, note };
}

// ---------- main ----------
async function main() {
  const queue = readJson(QUEUE, []);
  const errs = validate(queue);
  if (errs.length) {
    console.error("Queue has problems:\n- " + errs.join("\n- "));
    process.exit(1);
  }
  if (CHECK) return log(`Queue looks good: ${queue.length} post(s).`);

  const posted = readJson(POSTED, {});
  const save = () => !DRY && fs.writeFileSync(POSTED, JSON.stringify(posted, null, 2) + "\n");

  const due = queue
    .filter((p) => !["posted", "failed", "skipped_late"].includes(posted[p.id]?.status))
    .filter((p) => new Date(p.publish_at) <= NOW)
    .sort((a, b) => Date.parse(a.publish_at) - Date.parse(b.publish_at));

  if (!due.length) return log("Nothing due right now.");
  if (!DRY && due.some((p) => p.platform === "instagram")) {
    if (!MEDIA_BASE_URL && due.some((p) => p.media.some((m) => !isUrl(m)))) throw new Error("MEDIA_BASE_URL isn't set, so Instagram can't fetch the images");
    for (const k of ["IG_USER_ID", "IG_ACCESS_TOKEN"]) if (!process.env[k]) throw new Error(`${k} isn't set`);
  }
  if (!DRY && due.some((p) => p.platform === "linkedin"))
    for (const k of ["LINKEDIN_ACCESS_TOKEN", "LINKEDIN_AUTHOR_URN"]) if (!process.env[k]) throw new Error(`${k} isn't set`);

  let failures = 0;
  for (const p of due) {
    const hoursLate = (NOW - new Date(p.publish_at)) / 36e5;
    if (hoursLate > LATE_HOURS) {
      log(`SKIP  ${p.id}: ${hoursLate.toFixed(1)} hours late, not posting a stale challenge`);
      posted[p.id] = { status: "skipped_late", at: NOW.toISOString() };
      save();
      continue;
    }
    if (DRY) { log(`WOULD POST  ${p.id}  (${p.platform} ${p.type}, ${p.media.length} file(s))`); continue; }
    const prev = posted[p.id] || { tries: 0 };
    try {
      const r = p.platform === "instagram" ? { id: await postInstagram(p), note: "" } : await postLinkedIn(p);
      posted[p.id] = { status: "posted", at: new Date().toISOString(), platform_id: r.id, ...(r.note ? { note: r.note } : {}) };
      log(`POSTED  ${p.id}  -> ${r.id}${r.note ? "  (" + r.note + ")" : ""}`);
    } catch (e) {
      const tries = (prev.tries || 0) + 1;
      posted[p.id] = { status: tries >= MAX_TRIES ? "failed" : "retrying", tries, last_error: e.message, at: new Date().toISOString() };
      console.error(`ERROR  ${p.id} (try ${tries} of ${MAX_TRIES}): ${e.message}`);
      failures++;
    }
    save();
  }
  if (failures) process.exit(1); // a red run makes GitHub email you
}

module.exports = { liText, validate };
if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
