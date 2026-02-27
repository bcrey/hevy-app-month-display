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
    const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
    const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;

    if (!GOOGLE_API_KEY || !DRIVE_FOLDER_ID) {
      throw new Error(
        "Missing GOOGLE_API_KEY or DRIVE_FOLDER_ID environment variables"
      );
    }

    // Return cache if fresh
    const now = Date.now();
    const forceRefresh = req.query.refresh === "true";
    if (!forceRefresh && cache.data && now - cache.timestamp < CACHE_TTL) {
      return res.json(cache.data);
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
      return res.json({
        workouts: {},
        meta: { error: "No CSV files found in folder" },
      });
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

    const workoutsByDate = {};
    for (const row of records) {
      const title = row.title;
      const startTime = row.start_time;
      if (!title || !startTime) continue;

      const dt = parseHevyDate(startTime);
      if (!dt) continue;

      const dateKey = formatDateKey(dt);
      if (!workoutsByDate[dateKey]) {
        workoutsByDate[dateKey] = new Set();
      }
      workoutsByDate[dateKey].add(title);
    }

    // Convert Sets to arrays
    const result = {};
    for (const [date, titles] of Object.entries(workoutsByDate)) {
      result[date] = [...titles];
    }

    const payload = {
      workouts: result,
      meta: {
        fileName: latestFile.name,
        fileDate: latestFile.createdTime,
        totalDays: Object.keys(result).length,
        fetchedAt: new Date().toISOString(),
      },
    };

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