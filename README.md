# JudgeYou

A one-page field guide that judges the people in a chat, pseudo-scientifically:
each person gets one of twelve types, and a chat of two gets one of eight duos.
A decision model answers narrow questions about each person with probabilities
instead of prose, through OpenRouter's Decisions endpoint. Each person is
classified as one of twelve types, each with an engraved mascot. Everything runs
in the browser except the model requests, which go through a small server so the
OpenRouter key never reaches visitors. The page never names the model: the
server picks it (`JUDGE_MODEL`, today [Jev](https://docs.typesafe.ai/) from
TypeSafe), so it can change without touching the page.

Chats can be pasted, dropped or opened as exports from WhatsApp (also the ZIP
"with media"), Telegram (JSON, HTML, copy-paste), Messenger and Instagram,
Discord, Slack, Teams, iMessage exporters, IRC, LINE, KakaoTalk, CSV, or plain
`Name: message` text. If the format isn't recognised, the page asks who is in
the chat and the model reads the raw text.

Screenshots work too: pasted, dropped or picked, up to 10 at once. The page
shrinks them to JPEG, the server has a vision model (`SCREENSHOT_MODEL`, today
`openai/gpt-6-luna`, about $0.0005 for five screenshots) copy them out as
`HH:MM - Author: text` lines, and the transcript lands in the text box, where
it can be checked and fixed before judging. Screenshots rarely show dates, so
`server/transcribe.js` adds them: a time earlier than the one before means a
new day, counted back from today. The images are never stored.

Installed as an app (Chrome on Android offers it; the page shows an install
link), JudgeYou appears in the share menu, so WhatsApp's "Export chat" and the
gallery's share button can send to it directly. `manifest.webmanifest`
declares the share target; `sw.js` receives the files, parks them in a cache
for the page and touches nothing else. iOS doesn't let web apps receive
shares; there, people save the export to Files and open it.

Next to the model's verdicts, the page shows numbers it counts itself, without any
request: messages, median words per message and median reply time. A reply is
the gap between someone else's last message and a person's next one; after 6
hours of silence the next message starts a new conversation instead. Medians
need at least 3 observations, and a record ("Slowest thumbs") needs a clear
winner.

The results can be shared as an image with a link back to the verdict,
`judge-you.de/v/<id>#Ana,Ben`. The server stores each verdict and its counted
numbers with names replaced by "Person 1, 2…" (`GET /api/results/<id>`); the
names travel only in the link's fragment, which browsers never send, and the
page puts them back (`js/share.js`). Sample verdicts link as
`/v/sample-<id>`. The image shows names, types and counts, never chat text;
names default to first names, phone numbers are hidden, and all of them can be
edited first.

The page speaks English, German, French and Spanish, picked from the browser's
language and switchable in the header.

Unfinished chat text, manually entered names and participant selections are kept
in this tab’s session storage so reload can restore them. “Clear” removes the
draft. Consent resets on reload; screenshots must be added again. If the browser
blocks draft storage, the page explains that reloading may lose the chat.

## Run locally

Use Node.js 22 with `OPENROUTER_KEY` supplied through the environment.
For development, serve the source directly:

```sh
npm ci
npm start   # serves http://localhost:8000
```

To serve the production build locally, stop the development server, then run:

```sh
npm run build
PUBLIC_DIR=$PWD/dist npm start
```

Checks and the local synthetic benchmark make no paid model calls:

```sh
npm test
npm run benchmark -- --levels 1,10,32 --duration 2
```

## Server

`server/server.js` serves the page and forwards `POST /api/decisions` to
OpenRouter with its own key, always with its own model, so a page can't spend
the key on a pricier one. `POST /api/screenshots` only accepts images and
always sends the same transcription prompt. Both only answer the page's
origin, and `server/limits.js` caps requests per visitor per hour and in total
per day (`LIMIT_PER_IP_PER_HOUR`, `LIMIT_PER_DAY`), separately for each. A script can fake the
origin, so the caps are what bound the cost; give the key a credit limit on
OpenRouter as well.

Model work has separate concurrency limits, configurable in `/admin`: 32
judgments and 4 screenshot requests per process by default, including uploads.
Excess requests receive 503 with `Retry-After`, without consuming an allowance.
A 30-second deadline cancels stalled uploads/model responses; leaving the page
cancels model work.
These are capacity caps, not proven provider concurrency or a limit on people
simply opening the page. See the [historical performance report](docs/performance.md)
and the [R2 performance report](docs/performance-r2.md).

Set a random `ADMIN_TOKEN` of at least 32 characters in the deployment `.env`
to enable `/admin` (for example, generate one with `openssl rand -hex 32`).
Keep the token private. The page stores it only in memory and its API requires
it for every read and save. Changes apply immediately and persist in
`data/settings.json` on the existing data volume. There is no restart needed.
The dashboard shows active requests, today's usage and the allowance reset time.
Zero in an allowance pauses that kind of model request. Lowering concurrency
lets existing requests finish before admitting more.

Without saved dashboard settings, these environment variables set defaults:

| Variable | Default |
| --- | ---: |
| `LIMIT_PER_IP_PER_HOUR` | 20 |
| `LIMIT_PER_DAY` | 1000 |
| `SCREENSHOT_LIMIT_PER_IP_PER_HOUR` | Same as `LIMIT_PER_IP_PER_HOUR` |
| `SCREENSHOT_LIMIT_PER_DAY` | Same as `LIMIT_PER_DAY` |
| `MAX_CONCURRENT_DECISIONS` | 32 |
| `MAX_CONCURRENT_SCREENSHOTS` | 4 |
| `UPSTREAM_TIMEOUT_MS` | 30000 |

Docker Compose passes the optional admin token; use `/admin` for persistent
limit changes. Custom environment defaults must also be passed into the
container if you use them. Invalid settings stop startup. Allowance counters
are still in memory: restarts reset them. Backend replicas need shared settings,
quotas, admission control and a journal; these are not coordinated across
instances. Keep one backend instance until that storage and coordination exist.
Deleting a kept chat has a separate allowance and remains possible when judging
is paused.

The build emits split JavaScript, CSS, fonts and the specimen sprite under
content-hashed `/assets/` URLs, cached for a year as immutable. It prepares
Brotli and gzip copies of generated text assets and HTML. HTML, manifest,
service worker and other unhashed text revalidate with ETags; unhashed images
and fonts cache for a day. Languages, sample answers and share-card code load
when needed. Production uses `NODE_ENV=production` to reuse prepared encodings
and cache asset bytes in memory; development checks for file changes.

Every forwarded request becomes one row in an SQLite journal
(`data/judgeyou.db`, see `server/store.js`): metadata and the model's answers, with
names replaced by "Person 1, 2…". The IP is never stored, only a per-day
visitor ID. When the visitor leaves "keep it" ticked, the request itself is
kept too, with names, phone numbers and emails replaced (`server/scrub.js`),
and sealed with `server/chats-public.pem` (`server/seal.js`). The server can't
read what it kept; the private key lives only in
`~/.config/judgeyou/chats-private.pem` on the operator's machine. Back that
key up: without it, the kept chats are gone for good.

Replacing names only catches the people in the chat, so a friend mentioned by
name stays readable inside the sealed chat.

To read the kept chats, pull a copy and unseal it locally:

```sh
ssh root@judge-you.de docker exec judgeyou node server/export.js > copy.db
node scripts/read-chats.js copy.db > chats.jsonl
```

## Deploy

The site runs at https://judge-you.de on the Hetzner server, next to
AV_Stuttgart, whose Caddy terminates HTTPS and proxies to the `judgeyou`
container over the shared Docker network. Pushing to `main` runs the tests and
then, over SSH, rebuilds the container in `/opt/judgeyou` (secrets
`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY`). The key lives only in
`/opt/judgeyou/.env` on the server.

The multi-stage Docker build runs `npm ci` and `npm run build`; the runtime
serves `/app/dist` without build dependencies. Compose mounts the durable
`public-assets` volume at `/app/dist/assets`. Before listening, the server
copies the current image's assets from `/app/built-assets` into that volume
and prunes assets retired at least seven days ago. Keep the volume across
deployments so open tabs can still fetch an earlier build's lazy chunks.
The build also includes legacy public JS, CSS, font and sprite paths for
source-era tabs, excluding `js/key.js`.

Static delivery currently goes through Caddy to Node. No CDN account exists,
and none was created for this work.

## Where things live

- `js/parse.js`, `js/parse-structured.js`: chat formats. `js/stamps.js`: their timestamps.
- `js/files.js`: opening files, including WhatsApp ZIPs. `js/screenshots.js`: preparing screenshots.
- `server/transcribe.js`: reading screenshots, and dating what they show.
- `js/stats.js`: the counted numbers and records.
- `js/card.js`: the share image.
- `js/questions.js`: what the model is asked. One request judges everyone at once.
- `js/sample.js`: the sample chats. Their verdicts are judged once (`scripts/sample-verdicts.js` writes `js/sample-answers.js`) and replayed when a chat is exactly a sample, with no request.
- `server/models.js`: which models run (`JUDGE_MODEL`, `SCREENSHOT_MODEL`).
- `js/verdict.js`: how answers combine into the Menace Index (weights are ours).
- `js/presentation.js`: the twelve types, mascots (`img/types/`) and number formats.
- `js/locales/`: every visible string, one file per language; `js/i18n.js` picks one.
- `css/theme.css`: every raw color value.
