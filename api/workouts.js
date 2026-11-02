// In-memory cache (persists across warm invocations)
let cache = { data: null, timestamp: 0 };
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Simple CSV parser — handles quoted fields with commas/newlines
function parseCSV(text) {
  const rows = [];
  let current = "";
  let inQuotes = false;
  let fields = [];

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        current += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === ",") {
        fields.push(current);
        current = "";
      } else if (ch === "\n" || (ch === "\r" && text[i + 1] === "\n")) {
        fields.push(current);
        current = "";
        if (fields.some(f => f.trim())) rows.push(fields);
        fields = [];
        if (ch === "\r") i++;
      } else {
        current += ch;
      }
    }
  }
  if (current || fields.length) {
    fields.push(current);
    if (fields.some(f => f.trim())) rows.push(fields);
  }

  if (rows.length < 2) return [];
  const headers = rows[0];
  return rows.slice(1).map(row => {
    const obj = {};
    headers.forEach((h, i) => { obj[h.trim()] = (row[i] || "").trim(); });
    return obj;
  });
}

export default async function handler(req, res) {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  if (req.method !== "GET") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    // Return cache if fresh
    const now = Date.now();
    const forceRefresh = req.query.refresh === "true";
    if (!forceRefresh && cache.data && now - cache.timestamp < CACHE_TTL) {
      return res.json(cache.data);
    }

    // Prefer the Hevy API; fall back to the latest CSV export in Drive
    const payload = process.env.HEVY_API_KEY
      ? await fetchFromHevy(process.env.HEVY_API_KEY)
      : await fetchFromDrive();

    cache = { data: payload, timestamp: now };
    res.json(payload);
  } catch (err) {
    console.error("[hevy-calendar]", err.message);
    res.status(500).json({ error: err.message });
  }
}

function parseHevyDate(str) {
  const match = str.match(/(\d+)\s+(\w+)\s+(\d+),\s*(\d+):(\d+)/);
  if (!match) return null;
  const [, day, monthStr, year, hours, minutes] = match;
  const months = {
    Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
    Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
  };
  return new Date(+year, months[monthStr], +day, +hours, +minutes);
}

function formatDateKey(dt) {
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, "0");
  const d = String(dt.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

// Workouts are bucketed by the calendar day they started on in this timezone
const TIMEZONE = process.env.TIMEZONE || "America/Los_Angeles";
const HEVY_PAGE_SIZE = 10; // API maximum
const HEVY_CONCURRENCY = 5;

async function hevyGet(apiKey, page) {
  const url = `https://api.hevyapp.com/v1/workouts?page=${page}&pageSize=${HEVY_PAGE_SIZE}`;
  const res = await fetch(url, { headers: { "api-key": apiKey, accept: "application/json" } });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Hevy API failed: ${res.status} - ${err}`);
  }
  return res.json();
}

async function fetchFromHevy(apiKey) {
  // Page 1 tells us how many pages there are; fetch the rest in small batches
  const first = await hevyGet(apiKey, 1);
  const pages = [first];
  for (let page = 2; page <= first.page_count; page += HEVY_CONCURRENCY) {
    const batch = [];
    for (let p = page; p < page + HEVY_CONCURRENCY && p <= first.page_count; p++) {
      batch.push(hevyGet(apiKey, p));
    }
    pages.push(...(await Promise.all(batch)));
  }

  const dayKey = new Intl.DateTimeFormat("en-CA", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  });
  const workouts = pages.flatMap(p => p.workouts || []);
  workouts.sort((a, b) => a.start_time.localeCompare(b.start_time));

  const result = {};
  for (const w of workouts) {
    if (!w.title || !w.start_time) continue;
    const dateKey = dayKey.format(new Date(w.start_time));
    (result[dateKey] ||= []).push(w.title);
  }

  return {
    workouts: result,
    meta: {
      source: "hevy",
      totalWorkouts: workouts.length,
      totalDays: Object.keys(result).length,
      fetchedAt: new Date().toISOString(),
    },
  };
}

async function fetchFromDrive() {
  const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
  const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

  if (!GOOGLE_API_KEY || !DRIVE_FOLDER_ID) {
    throw new Error(
      "Missing HEVY_API_KEY, or GOOGLE_API_KEY and DRIVE_FOLDER_ID, environment variables"
    );
  }

  // Step 1: List CSV files in folder, newest first
  const listUrl = new URL("https://www.googleapis.com/drive/v3/files");
  listUrl.searchParams.set(
    "q",
    `'${DRIVE_FOLDER_ID}' in parents and mimeType='text/csv' and trashed=false`
  );
  listUrl.searchParams.set("orderBy", "createdTime desc");
  listUrl.searchParams.set("pageSize", "1");
  listUrl.searchParams.set("fields", "files(id,name,createdTime)");
  listUrl.searchParams.set("key", GOOGLE_API_KEY);

  const listRes = await fetch(listUrl.toString());
  if (!listRes.ok) {
    const err = await listRes.text();
    throw new Error(`Drive API list failed: ${listRes.status} - ${err}`);
  }
  const listData = await listRes.json();

  if (!listData.files || listData.files.length === 0) {
    return {
      workouts: {},
      meta: { error: "No CSV files found in folder" },
    };
  }

  const latestFile = listData.files[0];

  // Step 2: Download the CSV
  const downloadUrl = `https://www.googleapis.com/drive/v3/files/${latestFile.id}?alt=media&key=${GOOGLE_API_KEY}`;
  const dlRes = await fetch(downloadUrl);
  if (!dlRes.ok) {
    const err = await dlRes.text();
    throw new Error(`Drive download failed: ${dlRes.status} - ${err}`);
  }
  const csvText = await dlRes.text();

  // Step 3: Parse CSV → workouts by date
  const records = parseCSV(csvText);

  // sessions: date → Map of "title\0startTime" → title
  const sessionsByDate = {};
  for (const row of records) {
    const title = row.title;
    const startTime = row.start_time;
    if (!title || !startTime) continue;

    const dt = parseHevyDate(startTime);
    if (!dt) continue;

    const dateKey = formatDateKey(dt);
    if (!sessionsByDate[dateKey]) {
      sessionsByDate[dateKey] = new Map();
    }
    const sessionKey = `${title}\0${startTime}`;
    sessionsByDate[dateKey].set(sessionKey, title);
  }

  // Convert Maps to arrays of titles (one entry per unique session)
  const result = {};
  for (const [date, sessions] of Object.entries(sessionsByDate)) {
    result[date] = [...sessions.values()];
  }

  const payload = {
    workouts: result,
    meta: {
      source: "drive",
      fileName: latestFile.name,
      fileDate: latestFile.createdTime,
      totalDays: Object.keys(result).length,
      fetchedAt: new Date().toISOString(),
    },
  };

  return payload;
}
