# JudgeYou

A one-page site that judges the people in a group chat, pseudo-scientifically.
It sends the chat to [Jev](https://docs.typesafe.ai/), TypeSafe's decision model,
through OpenRouter's Decisions endpoint, and gets calibrated probabilities back
instead of prose. Everything runs in the browser; there is no backend.

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

- `js/questions.js`: what Jev is asked. One request judges everyone at once.
- `js/verdict.js`: how answers combine into the Menace Index (weights are ours).
- `js/presentation.js`: labels and which color token means what.
- `css/theme.css`: every raw color value.
