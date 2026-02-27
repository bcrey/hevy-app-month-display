# Hevy Workout Calendar

A visual calendar that auto-reads your latest [Hevy](https://www.hevyapp.com) CSV export from Google Drive. Shows all workouts per day with emoji indicators — no more truncated titles on multi-workout days.

![Calendar preview](https://img.shields.io/badge/status-active-brightgreen)

## Why

Hevy's calendar view only shows the title of the first workout per day, truncated to a few characters. If you do multiple workouts daily (strength, cardio, rehab, mobility), this makes the calendar useless for spotting trends. This project fixes that.

## How It Works

```
Browser  →  Vercel Serverless Function  →  Google Drive API
   ↑                    ↓
   └──── JSON (workouts by date) ────┘
```

1. You export a CSV from Hevy and drop it in a Google Drive folder
2. The serverless function finds the newest CSV in that folder, parses it, and returns structured JSON
3. The frontend renders a responsive multi-month calendar with emoji indicators per workout

## Deploy to Vercel

### Prerequisites

1. **Google Drive API key** (free):
   - Go to [Google Cloud Console](https://console.cloud.google.com)
   - Create a project → Enable **Google Drive API**
   - Create an **API key** → Restrict it to Google Drive API only

2. **Make your Drive folder publicly readable**:
   - Right-click folder → Share → "Anyone with the link" → Viewer

### One-Click Deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/YOUR_USERNAME/hevy-workout-calendar&env=GOOGLE_API_KEY,DRIVE_FOLDER_ID)

Or manually:

1. Push this repo to GitHub
2. Import it in [Vercel](https://vercel.com/new)
3. Add environment variables:
   - `GOOGLE_API_KEY` — your Google API key
   - `DRIVE_FOLDER_ID` — your Drive folder ID (from the folder URL)
4. Deploy

### Local Development

```bash
npm install
npx vercel dev
```

Set environment variables in a `.env` file (see `.env.example`).

## Project Structure

```
├── api/
│   └── workouts.js     # Serverless function: Drive API proxy + CSV parser
├── public/
│   └── index.html      # Self-contained React frontend (no build step)
├── vercel.json         # Vercel routing config
├── .env.example        # Environment variable template
└── package.json
```

## Features

- **Multi-month responsive grid** — shows as many months side-by-side as your screen allows
- **Time filter** — This Month / 2 Months / 6 Months / All Time
- **Emoji indicators** — each workout type shows its emoji directly on the calendar cell
- **Multi-workout badge** — orange count badge on days with 2+ workouts
- **Tap to expand** — click any day to see full workout list
- **Auto-refresh** — reads the latest CSV from your Drive folder (5-min cache)

## Workflow

1. Work out → log in Hevy as normal
2. Export CSV from Hevy (Settings → Export Data)
3. Drop CSV in your Google Drive folder
4. Visit your calendar — it picks up the latest file automatically

## License

MIT
