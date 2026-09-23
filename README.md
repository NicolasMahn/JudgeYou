# JudgeYou

A one-page field guide that judges the people in a group chat, pseudo-scientifically.
It sends the chat to [Jev](https://docs.typesafe.ai/), TypeSafe's decision model,
through OpenRouter's Decisions endpoint, and gets calibrated probabilities back
instead of prose. Each person is classified as one of twelve types, each with an
engraved mascot. Everything runs in the browser; there is no backend.

Chats can be pasted, dropped or opened as exports from WhatsApp (also the ZIP
"with media"), Telegram (JSON, HTML, copy-paste), Messenger and Instagram,
Discord, Slack, Teams, iMessage exporters, IRC, LINE, KakaoTalk, CSV, or plain
`Name: message` text. If the format isn't recognised, the page asks who is in
the chat and Jev reads the raw text.

Next to Jev's verdicts, the page shows numbers it counts itself, without any
request: messages, median words per message and median reply time. A reply is
the gap between someone else's last message and a person's next one; after 6
hours of silence the next message starts a new conversation instead. Medians
need at least 3 observations, and a record ("Slowest thumbs") needs a clear
winner.

The results can be shared as an image. It shows names, types and counts, never
chat text; names default to first names, phone numbers are hidden, and all of
them can be edited first.

The page speaks English, German, French and Spanish, picked from the browser's
language and switchable in the header.

## Run locally

```sh
echo "export const OPENROUTER_KEY = 'sk-or-…';" > js/key.js   # git-ignored
npm start        # serves http://localhost:8000
npm test
```

Without `js/key.js`, the page asks for a key and keeps it in `localStorage`.

## Deploy

Pushing to `main` deploys to GitHub Pages (Settings → Pages → Source: GitHub Actions).
If the repository has an `OPENROUTER_KEY` secret, the workflow bakes it into the
deployed `js/key.js`. Anyone can read it from there, so use a separate key with a
low credit limit.

## Where things live

- `js/parse.js`, `js/parse-structured.js`: chat formats. `js/stamps.js`: their timestamps.
- `js/files.js`: opening files, including WhatsApp ZIPs.
- `js/stats.js`: the counted numbers and records.
- `js/card.js`: the share image.
- `js/questions.js`: what Jev is asked. One request judges everyone at once.
- `js/verdict.js`: how answers combine into the Menace Index (weights are ours).
- `js/presentation.js`: the twelve types, mascots (`img/types/`) and number formats.
- `js/locales/`: every visible string, one file per language; `js/i18n.js` picks one.
- `css/theme.css`: every raw color value.
