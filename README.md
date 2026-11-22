# Happier HQ social publisher

Posts go out on their own. Every Sunday Claude drafts the week of Sheet Snacks posts into the Content Queue sheet and writes them to `queue/queue.json` here. GitHub checks every 15 minutes and posts anything that's due to Instagram (and LinkedIn, once it's switched on).

Quiz Stories still go up by hand. Instagram doesn't let any tool add stickers.

## How it behaves

- Posts within about 15 minutes of its time (GitHub runs a little late sometimes)
- Never posts the same thing twice. `queue/posted.json` is the log
- If a post fails it tries twice more, then stops and GitHub emails you
- Anything more than 12 hours late gets skipped, so a Monday challenge never shows up on Wednesday
- The Instagram token renews itself every 2 weeks
- The LinkedIn token lasts 60 days and has to be redone by hand (5 minutes)

## Setup

### 1. The repo
1. Settings > Pages > Source: **Deploy from a branch**, branch `main`, folder `/ (root)`. Save.
2. Settings > Secrets and variables > Actions > **Variables** tab > add `MEDIA_BASE_URL` = `https://happierhq-ks.github.io/happierhq-social`

### 2. Instagram
1. developers.facebook.com > your app (or make a new Business app) > Add product > **Instagram** > "API setup with Instagram login".
2. Add the Happier HQ Instagram account and click **Generate token**. Log in and allow.
3. Copy the token and the Instagram user ID shown next to the account.
4. In GitHub, Settings > Secrets and variables > Actions > **Secrets** tab: add `IG_ACCESS_TOKEN` and `IG_USER_ID`.

### 3. Auto-renewing the Instagram token
1. GitHub > your profile picture > Settings > Developer settings > Fine-grained tokens > Generate.
2. Only this repo. Permissions: **Secrets: Read and write**. Expiration: 1 year.
3. Add it as a repo secret called `GH_PAT`.

### 4. Test it
Actions > **Publish due posts** > Run workflow (leave Dry run ticked). It should say "Nothing due right now." That means everything's wired up.

### Later: LinkedIn (after Jen's OK)
1. linkedin.com/developers > Create app (it asks for a company page; use the Happier HQ page).
2. Products tab > request **Share on LinkedIn** and **Sign In with LinkedIn using OpenID Connect**.
3. Auth tab > OAuth 2.0 tools > **Token generator**. Tick `openid`, `profile`, `w_member_social`. Copy the token.
4. Secret `LINKEDIN_ACCESS_TOKEN` = that token.
5. Actions > **Find my LinkedIn ID** > Run workflow. Copy the `urn:li:person:...` it prints into a secret called `LINKEDIN_AUTHOR_URN`.

## The queue file

Claude writes this. Example:

```json
[
  {
    "id": "2026-11-30-ig",
    "platform": "instagram",
    "type": "carousel",
    "publish_at": "2026-11-30T07:30:00-05:00",
    "caption": "Today's snack is ready ...",
    "media": ["media/2026-11-30_challenge.png", "media/2026-11-30_answer.png"]
  }
]
```

Types: Instagram `image`, `carousel` (2 to 10 images), `reel` (.mp4). LinkedIn `image` or `document` (.pdf, for Friday recaps).

To pull a post before it goes out, delete it from `queue.json` or ask Claude to.

Check the file anytime with `node scripts/publish.js --check`.
