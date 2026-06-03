# Companion clip generator

Automatically generates the cat-companion video clips by calling the
**xAI Grok Imagine video API** from your machine, using the 1000 prompts in
`companion/clip-catalog.json`. No clicking through the Grok UI 1000 times.

## Where the API key goes 🔑

1. Copy the template:
   ```
   cp tools/.env.example tools/.env
   ```
2. Open **`tools/.env`** and paste your key:
   ```
   XAI_API_KEY=xai-...your key...
   ```

`tools/.env` is **gitignored** — it is never committed and never shipped to the
browser. (Your app is a public client-side site; an API key in the frontend
would be readable by anyone and could drain your billing. That's why generation
runs here, locally, and only the finished *videos* go to Supabase.)

While you're in `tools/.env`, also set **`SEED_IMAGE_URL`** to a public URL of
your cat photo so every clip is *your* cat (image-to-video). Easiest: upload
`cat-base.jpg` to the public `companion` bucket and paste its public URL.

## Run it

Requires Node 18+ (uses the built-in `--env-file` flag and `fetch`).

```bash
# 1) Always test a handful first — check the look AND the cost:
node --env-file=tools/.env tools/generate-clips.mjs --limit 5

# 2) Happy with the results? Do the full run and auto-upload to Supabase:
node --env-file=tools/.env tools/generate-clips.mjs --all --upload
```

Clips download to `companion/generated/` (gitignored). With `--upload` and a
`SUPABASE_SERVICE_KEY` set, each finished clip also lands in the
`companion/clips` Storage bucket — which is exactly where the app reads them.

### Flags
| Flag | Effect |
|---|---|
| `--limit N` | Generate the first N not-yet-done clips (great for testing). |
| `--all` | Generate everything remaining. Required for a full run. |
| `--start N` | Skip clips with id < N (resume / redo a range). |
| `--force` | Re-generate even if the local `.mp4` already exists. |
| `--text-only` | Ignore the seed image (cat won't look like your cat). |
| `--upload` | Upload each finished clip to Supabase (needs `SUPABASE_SERVICE_KEY`). |
| `--dry-run` | Print the plan; make no API calls. |

**It's resumable.** Clips already downloaded are skipped, so you can stop with
Ctrl-C and re-run anytime. Failures are written to
`companion/generated/_failures.json`; just re-run to retry them.

## ⚠️ Cost & storage (read this)

**Cost.** xAI bills per second of video: **$0.05/sec at 480p**, $0.07/sec at
720p, plus ~$0.002 per seed image. So at the default 6 s / 480p, **each clip is
~$0.30**. That means:

| Clips | 6 s @ 480p | 4 s @ 480p |
|------:|-----------:|-----------:|
|    50 |      ~$15  |      ~$10  |
|   150 |      ~$45  |      ~$30  |
|  1000 |     ~$300  |     ~$200  |

The script prints `cost_in_usd_ticks` after each run — divide by **10,000,000,000**
to get USD (e.g. `3020000000` ticks = **$0.30**). The safety gate refuses to run
all 1000 unless you pass `--all`.

**Storage.** A 6 s 480p clip is ~3 MB (4 s ≈ 2 MB). Supabase's **free tier is
1 GB** storage + limited egress, so ~300 clips is the practical free-tier
ceiling, and every in-app play streams the file. Keep the pool modest or move
to Supabase Pro for a large library.

**Bottom line:** you do NOT need 1000. The random-draw mechanic feels endlessly
fresh at **~50–150 clips** (the engine won't repeat the last 60). Start there,
add more anytime. Drop `CLIP_DURATION` to `4` to cut both cost and size by a
third.

## Tunables (in `tools/.env`)
`CLIP_DURATION` (sec), `CLIP_RESOLUTION` (480p/720p/1080p), `CLIP_ASPECT_RATIO`
(1:1 suits the round orb), `CLIP_CONCURRENCY` (parallel generations).
