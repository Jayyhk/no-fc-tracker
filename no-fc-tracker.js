#!/usr/bin/env node
import { google } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createInterface } from 'readline/promises';
import 'dotenv/config';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Config ────────────────────────────────────────────────────────────────────

const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const OSU_API_KEY = process.env.OSU_API_KEY;
const RATE_LIMIT_DELAY = 1000;
const CREDENTIALS_PATH = path.join(__dirname, 'credentials.json');
const TOKEN_PATH = path.join(__dirname, 'token.json');

const INPUT_COL = 23;  // Column W
const OUTPUT_COL = 1;  // Column A
const OUTPUT_ROW = 2;  // First data row (row 1 is header)
const NUM_COLS = 22;   // Columns A–V

const VALID_MODS = { 0:'NM',1:'NF',2:'EZ',4:'TD',8:'HD',16:'HR',32:'SD',64:'DT',256:'HT',512:'NC',1024:'FL',4096:'SO',16384:'PF' };
const INVALID_MODS = 2 | 4 | 256 | 4096; // EZ | TD | HT | SO
const RANK_VALUE_MAP = new Map([['D',1],['C',2],['B',3],['A',4],['S',5],['SH',5],['X',6],['XH',6]]);

// ── Google Auth ───────────────────────────────────────────────────────────────

let sheetsClient;
const sheetIds = {};

async function authorize() {
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`Missing ${CREDENTIALS_PATH}. Download it from Google Cloud Console.`);
    process.exit(1);
  }
  const creds = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const { client_secret, client_id, redirect_uris } = creds.installed;
  const auth = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  if (fs.existsSync(TOKEN_PATH)) {
    auth.setCredentials(JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')));
    return auth;
  }

  const authUrl = auth.generateAuthUrl({ access_type: 'offline', scope: ['https://www.googleapis.com/auth/spreadsheets'] });
  console.log('Authorize this app by visiting:\n');
  console.log(authUrl);
  console.log();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const code = await rl.question('Paste the code from that page here: ');
  rl.close();
  const { tokens } = await auth.getToken(code.trim());
  auth.setCredentials(tokens);
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log('Token saved to', TOKEN_PATH);
  return auth;
}

async function initSheets() {
  const auth = await authorize();
  sheetsClient = google.sheets({ version: 'v4', auth });
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  for (const s of meta.data.sheets) {
    sheetIds[s.properties.title] = s.properties.sheetId;
  }
}

// ── Sheet Helpers ─────────────────────────────────────────────────────────────

function colLetter(n) {
  let s = '';
  while (n > 0) {
    s = String.fromCharCode(64 + ((n - 1) % 26) + 1) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function a1(sheet, startRow, startCol, numRows = 1, numCols = 1) {
  return `${sheet}!${colLetter(startCol)}${startRow}:${colLetter(startCol + numCols - 1)}${startRow + numRows - 1}`;
}

async function sheetGet(sheet, startRow, startCol, numRows, numCols, renderOption = 'UNFORMATTED_VALUE') {
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: a1(sheet, startRow, startCol, numRows, numCols),
    valueRenderOption: renderOption,
  });
  return res.data.values || [];
}

async function sheetSet(sheet, startRow, startCol, values) {
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheet}!${colLetter(startCol)}${startRow}`,
    valueInputOption: 'USER_ENTERED',
    requestBody: { values },
  });
}

async function sheetBatchSet(ranges) {
  // ranges: [{ sheet, startRow, startCol, values }]
  const CHUNK = 200;
  const data = ranges.map(r => ({
    range: `${r.sheet}!${colLetter(r.startCol)}${r.startRow}`,
    values: r.values,
  }));
  for (let i = 0; i < data.length; i += CHUNK) {
    await sheetsClient.spreadsheets.values.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { valueInputOption: 'USER_ENTERED', data: data.slice(i, i + CHUNK) },
    });
  }
}

async function sheetLastRow(sheet) {
  // Column A has =IMAGE() formulas in data rows which return empty in UNFORMATTED_VALUE.
  // Use column W (input URL) for Data — plain text, always populated.
  // Use column K (beatmap ID) for History — plain number, always populated.
  const colMap = { Data: 'W', History: 'K', About: 'A' };
  const col = colMap[sheet] || 'A';
  const res = await sheetsClient.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${sheet}!${col}:${col}`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (res.data.values || []).length;
}

async function sheetDeleteRow(sheet, rowNumber) {
  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        deleteDimension: {
          range: { sheetId: sheetIds[sheet], dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber },
        },
      }],
    },
  });
}

async function sheetSort(sheet, startRow, numCols, sortSpecs) {
  const lastRow = await sheetLastRow(sheet);
  if (lastRow < startRow) return;
  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [{
        sortRange: {
          range: {
            sheetId: sheetIds[sheet],
            startRowIndex: startRow - 1,
            endRowIndex: lastRow,
            startColumnIndex: 0,
            endColumnIndex: numCols,
          },
          sortSpecs: sortSpecs.map(s => ({
            dimensionIndex: s.col - 1, // 1-based col → 0-based index
            sortOrder: s.asc ? 'ASCENDING' : 'DESCENDING',
          })),
        },
      }],
    },
  });
}

async function ensureSheetRows(sheet, requiredRows) {
  const meta = await sheetsClient.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
  const sheetMeta = meta.data.sheets.find(s => s.properties.title === sheet);
  const currentRows = sheetMeta.properties.gridProperties.rowCount;
  if (currentRows < requiredRows) {
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: {
        requests: [{
          appendDimension: {
            sheetId: sheetIds[sheet],
            dimension: 'ROWS',
            length: requiredRows - currentRows + 100,
          },
        }],
      },
    });
  }
}

async function applyBulkFormatting(rowNumbers) {
  if (!rowNumbers.length) return;
  const sheetId = sheetIds['Data'];

  // col is 1-based
  const numberFormats = [
    { col: 3,  pattern: '0.00' },  // C - SR
    { col: 4,  type: 'TEXT' },     // D - Length (force text so "4:10" doesn't become a time)
    { col: 5,  pattern: '0.##' },  // E - BPM
    { col: 6,  pattern: '0.#' },   // F - CS
    { col: 7,  pattern: '0.#' },   // G - AR
    { col: 8,  pattern: '0.#' },   // H - OD
    { col: 9,  pattern: '0.#' },   // I - HP
    { col: 21, pattern: '0.00' },  // U - % FC
  ];

  const requests = [];
  for (const row of rowNumbers) {
    const ri = row - 1; // 0-based
    requests.push({
      updateDimensionProperties: {
        range: { sheetId, dimension: 'ROWS', startIndex: ri, endIndex: ri + 1 },
        properties: { pixelSize: 21 },
        fields: 'pixelSize',
      },
    });
    for (const fmt of numberFormats) {
      const ci = fmt.col - 1; // 0-based
      requests.push({
        repeatCell: {
          range: { sheetId, startRowIndex: ri, endRowIndex: ri + 1, startColumnIndex: ci, endColumnIndex: ci + 1 },
          cell: {
            userEnteredFormat: {
              numberFormat: fmt.type ? { type: fmt.type } : { type: 'NUMBER', pattern: fmt.pattern },
            },
          },
          fields: 'userEnteredFormat.numberFormat',
        },
      });
    }
  }

  const CHUNK = 1000;
  for (let i = 0; i < requests.length; i += CHUNK) {
    await sheetsClient.spreadsheets.batchUpdate({
      spreadsheetId: SPREADSHEET_ID,
      requestBody: { requests: requests.slice(i, i + CHUNK) },
    });
  }
}

// ── Sleep ─────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── osu! API ──────────────────────────────────────────────────────────────────

async function requestContent(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    return await res.text();
  } catch (err) {
    console.error(`API request failed for ${url}: ${err.message}`);
    throw err;
  } finally {
    await sleep(RATE_LIMIT_DELAY);
  }
}

async function fetchFromAPI(beatmapID, endpoint) {
  const urls = {
    beatmaps: `https://osu.ppy.sh/api/get_beatmaps?k=${OSU_API_KEY}&b=${beatmapID}`,
    scores:   `https://osu.ppy.sh/api/get_scores?k=${OSU_API_KEY}&b=${beatmapID}`,
  };
  return requestContent(urls[endpoint]);
}

// ── Pure Logic ────────────────────────────────────────────────────────────────

function sanitize(str) { return String(str).replace(/"/g, '""'); }

function formatDate(input) {
  if (!input) return '';
  try {
    const d = typeof input === 'string' ? new Date(input.replace(' ', 'T') + 'Z') : new Date(input);
    if (isNaN(d.getTime())) return '';
    return `${d.getUTCMonth() + 1}/${d.getUTCDate()}/${d.getUTCFullYear()}`;
  } catch { return ''; }
}

function formatLength(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function calculateDaysRanked(approvedDateString) {
  const d = new Date(approvedDateString.replace(' ', 'T') + 'Z');
  return Math.ceil((Date.now() - d.getTime()) / 86400000);
}

function calculateDaysToFC(rankedDateString, scoreDateString) {
  const [rm, rd, ry] = rankedDateString.split('/').map(Number);
  const [sm, sd, sy] = scoreDateString.split('/').map(Number);
  return Math.ceil((Date.UTC(sy, sm - 1, sd) - Date.UTC(ry, rm - 1, rd)) / 86400000);
}

function getModString(modsEnum) {
  if (modsEnum === 0) return 'NM';
  if (modsEnum & 512) modsEnum &= ~64;    // NC implies DT — drop DT bit
  if (modsEnum & 16384) modsEnum &= ~32;  // PF implies SD — drop SD bit
  let s = '';
  for (const flag of Object.keys(VALID_MODS).map(Number).filter(f => f > 0).sort((a, b) => a - b)) {
    if (modsEnum & flag) s += VALID_MODS[flag];
  }
  return s;
}

function getModEnum(modString) {
  if (!modString || modString === 'NM') return 0;
  const modMap = Object.fromEntries(Object.entries(VALID_MODS).map(([k, v]) => [v, parseInt(k)]));
  let e = 0;
  for (let i = 0; i < modString.length; i += 2) {
    const mod = modString.substr(i, 2);
    if (modMap[mod]) e |= modMap[mod];
  }
  return e;
}

function getRankValue(rank) { return RANK_VALUE_MAP.get(rank) || 0; }
function isRankValid(score) { return score && ['S', 'SH', 'X', 'XH'].includes(score.rank); }
function areModsValid(modsEnum) { return (modsEnum & INVALID_MODS) === 0; }

function isFC(score, maxCombo) {
  if (!score || !isRankValid(score)) return false;
  const mods = parseInt(score.enabled_mods);
  if (!areModsValid(mods)) return false;
  if ((mods & 32) || (mods & 16384)) return true; // SD or PF
  return parseInt(score.maxcombo) >= maxCombo - 1;
}

function isAmbiguousFC(score, maxCombo) {
  if (!score || !isRankValid(score)) return false;
  const mods = parseInt(score.enabled_mods);
  if (!areModsValid(mods) || (mods & 32) || (mods & 16384)) return false;
  return parseInt(score.maxcombo) + parseInt(score.count100) >= maxCombo;
}

function findBestScore(scores, maxCombo) {
  let best = { userID: 0, player: '', modString: '', currentMaxCombo: 0, rank: '', scoreDate: '', percentFC: 0, isAmbiguousFC: false };
  const limit = Math.min(scores.length, 50);

  for (let i = 0; i < limit; i++) {
    const score = scores[i];
    const mods = parseInt(score.enabled_mods);
    if (!areModsValid(mods)) continue;

    if (isFC(score, maxCombo)) {
      return {
        userID: parseInt(score.user_id),
        player: score.username,
        modString: getModString(mods),
        currentMaxCombo: parseInt(score.maxcombo),
        rank: score.rank,
        scoreDate: score.date ? formatDate(score.date) : '',
        percentFC: (parseInt(score.maxcombo) / maxCombo) * 100,
        isAmbiguousFC: false,
      };
    }

    const combo = parseInt(score.maxcombo);
    if (combo > best.currentMaxCombo || (combo === best.currentMaxCombo && getRankValue(score.rank) > getRankValue(best.rank))) {
      best = {
        userID: parseInt(score.user_id),
        player: score.username,
        modString: getModString(mods),
        currentMaxCombo: combo,
        rank: score.rank,
        scoreDate: score.date ? formatDate(score.date) : '',
        percentFC: (combo / maxCombo) * 100,
        isAmbiguousFC: isAmbiguousFC(score, maxCombo),
      };
    }
  }
  return best;
}

function createHyperlink(url, text) { return `=HYPERLINK("${url}","${text}")`; }

function createBeatmapNameHyperlink(b) {
  const url = `https://osu.ppy.sh/beatmapsets/${b.beatmapset_id}#osu/${b.beatmap_id}`;
  const text = `${sanitize(b.artist)}\n${sanitize(b.title)}\n[${sanitize(b.version)}]`;
  return createHyperlink(url, text);
}

function createPlayerHyperlink(userID, username) {
  if (!userID) return '';
  return createHyperlink(`https://osu.ppy.sh/users/${userID}/osu`, username);
}

function createBeatmapRow(beatmapData, scores) {
  const maxCombo = parseInt(beatmapData.max_combo);
  const best = findBestScore(scores, maxCombo);
  return [
    `=IMAGE("https://assets.ppy.sh/beatmaps/${beatmapData.beatmapset_id}/covers/cover.jpg", 2)`,
    createBeatmapNameHyperlink(beatmapData),
    parseFloat(beatmapData.difficultyrating),
    formatLength(parseInt(beatmapData.total_length)),
    parseFloat(beatmapData.bpm),
    parseFloat(beatmapData.diff_size),
    parseFloat(beatmapData.diff_approach),
    parseFloat(beatmapData.diff_overall),
    parseFloat(beatmapData.diff_drain),
    createPlayerHyperlink(beatmapData.creator_id, beatmapData.creator),
    beatmapData.beatmap_id,
    beatmapData.beatmapset_id,
    formatDate(beatmapData.approved_date),
    calculateDaysRanked(beatmapData.approved_date),
    createPlayerHyperlink(best.userID, best.player),
    best.scoreDate,
    best.rank,
    best.modString,
    best.currentMaxCombo,
    maxCombo,
    best.percentFC,
    best.isAmbiguousFC ? '✓' : '',
  ];
}

function createErrorRow(message) {
  return [message, ...Array(NUM_COLS - 1).fill('')];
}

// ── Sheet Operations ──────────────────────────────────────────────────────────

async function getExistingBeatmapIds() {
  const lastRow = await sheetLastRow('Data');
  if (lastRow < OUTPUT_ROW) return [];
  const rows = await sheetGet('Data', OUTPUT_ROW, INPUT_COL, lastRow - OUTPUT_ROW + 1, 1, 'FORMATTED_VALUE');
  return rows
    .map(row => String(row?.[0] || '').match(/\d+$/)?.[0] || '')
    .filter(id => id !== '');
}

async function setBulkRowData(rowNumbers, allRowData) {
  if (!rowNumbers.length) return;
  await ensureSheetRows('Data', Math.max(...rowNumbers));
  await sheetBatchSet(rowNumbers.map((row, i) => ({
    sheet: 'Data', startRow: row, startCol: OUTPUT_COL, values: [allRowData[i]],
  })));
  await applyBulkFormatting(rowNumbers);
}

async function setBulkInputURLs(inputURLs) {
  for (const { row, url } of inputURLs) {
    await sheetSet('Data', row, INPUT_COL, [[url]]);
  }
}

async function sortBeatmapData() {
  await sheetSort('Data', OUTPUT_ROW, NUM_COLS + 1, [{ col: 3, asc: true }]); // col C = SR
}

async function sortHistory() {
  await sheetSort('History', 2, NUM_COLS - 2, [
    { col: 16, asc: true }, // col P = score date
    { col: 3,  asc: true }, // col C = star rating
  ]);
}

async function updateLastUpdatedTimestamp() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const stamp = `${yesterday.getMonth() + 1}/${yesterday.getDate()}/${yesterday.getFullYear()}`;
  await sheetsClient.spreadsheets.values.update({
    spreadsheetId: SPREADSHEET_ID,
    range: 'About!B23:G24',
    valueInputOption: 'USER_ENTERED',
    requestBody: { values: [[`Last Updated: ${stamp}`]] },
  });
}

// ── processBeatmapJobs ────────────────────────────────────────────────────────

async function processBeatmapJobs(jobs) {
  const allRowData = [];
  const allInputURLs = [];
  const rowNumbers = [];
  const beatmapBase = `https://osu.ppy.sh/api/get_beatmaps?k=${OSU_API_KEY}&b=`;
  const scoresBase  = `https://osu.ppy.sh/api/get_scores?k=${OSU_API_KEY}&b=`;

  for (const job of jobs) {
    let beatmapData = job.beatmapData;
    let scores = job.scores || [];

    if (!beatmapData) {
      try {
        beatmapData = JSON.parse(await requestContent(beatmapBase + job.id))[0];
      } catch (err) {
        allRowData.push(createErrorRow('API Error: ' + err.message));
        rowNumbers.push(job.row);
        continue;
      }
      if (!beatmapData) {
        allRowData.push(createErrorRow('Invalid beatmap ID'));
        rowNumbers.push(job.row);
        continue;
      }
    }

    if (!job.scores) {
      try {
        scores = JSON.parse(await requestContent(scoresBase + job.id)) || [];
      } catch {
        console.error('Could not fetch scores for beatmap', job.id);
      }
    }

    allRowData.push(createBeatmapRow(beatmapData, scores));
    rowNumbers.push(job.row);

    if (job.addInputURL && beatmapData) {
      allInputURLs.push({
        row: job.row,
        url: `https://osu.ppy.sh/beatmapsets/${beatmapData.beatmapset_id}#osu/${beatmapData.beatmap_id}`,
      });
    }
  }

  if (allRowData.length > 0) await setBulkRowData(rowNumbers, allRowData);
  if (allInputURLs.length > 0) await setBulkInputURLs(allInputURLs);
}

// ── Main Functions ────────────────────────────────────────────────────────────

async function backfill(sinceDate, untilDate) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(sinceDate) || !/^\d{4}-\d{2}-\d{2}$/.test(untilDate)) {
    console.error('Dates must be in YYYY-MM-DD format.');
    return;
  }
  const label = `${sinceDate} – ${untilDate}`;
  const url = `https://osu.ppy.sh/api/get_beatmaps?k=${OSU_API_KEY}&since=${sinceDate}&m=0&approved=1`;

  let beatmaps;
  try {
    beatmaps = JSON.parse(await requestContent(url));
  } catch (err) {
    console.error('Error fetching beatmaps:', err.message);
    return;
  }
  if (!beatmaps?.length) { console.log('No beatmaps returned.'); return; }

  if (beatmaps.length >= 500) {
    console.warn('Warning: API returned 500+ results — some maps may be truncated. Consider splitting the date range.');
  }

  const ranked = beatmaps.filter(b => {
    if (b.approved !== '1') return false;
    const approvedDate = (b.approved_date || '').split(' ')[0];
    return approvedDate >= sinceDate && approvedDate <= untilDate;
  });
  if (!ranked.length) { console.log(`No ranked beatmaps found in ${label} range.`); return; }

  const existingIds = await getExistingBeatmapIds();
  const newBeatmaps = ranked.filter(b => !existingIds.includes(b.beatmap_id));
  if (!newBeatmaps.length) { console.log(`All ${label} beatmaps already in spreadsheet.`); return; }

  console.log(`Checking ${newBeatmaps.length} new beatmap(s) for FCs...`);
  const lastRow = await sheetLastRow('Data');
  let nextRow = Math.max(lastRow + 1, OUTPUT_ROW);
  const jobs = [];
  const skipped = [];
  let addedCount = 0;

  for (const beatmap of newBeatmaps) {
    let scores = [];
    try {
      scores = JSON.parse(await fetchFromAPI(beatmap.beatmap_id, 'scores')) || [];
    } catch { console.error('Could not fetch scores for', beatmap.beatmap_id); }

    if (scores.some(s => isFC(s, parseInt(beatmap.max_combo)))) {
      skipped.push(beatmap);
    } else {
      jobs.push({ row: nextRow + addedCount, id: beatmap.beatmap_id, beatmapData: beatmap, scores, addInputURL: true });
      addedCount++;
    }
  }

  if (!jobs.length) { console.log(`All ${label} beatmaps already have FCs.`); return; }

  await processBeatmapJobs(jobs);
  await sortBeatmapData();
  await updateLastUpdatedTimestamp();

  console.log(`\nAdded ${addedCount} beatmap(s). Skipped ${skipped.length} with FCs.`);
  for (const job of jobs)  console.log(`  + https://osu.ppy.sh/beatmapsets/${job.beatmapData.beatmapset_id}#osu/${job.beatmapData.beatmap_id}`);
  for (const b of skipped) console.log(`  - https://osu.ppy.sh/beatmapsets/${b.beatmapset_id}#osu/${b.beatmap_id}`);
}

async function refreshAllBeatmaps() {
  console.log('Starting refresh...');
  const lastRow = await sheetLastRow('Data');
  const totalCount = lastRow - OUTPUT_ROW + 1;
  if (totalCount <= 0) { console.log('No beatmaps to refresh.'); return; }

  const urlRows = await sheetGet('Data', OUTPUT_ROW, INPUT_COL, totalCount, 1, 'FORMATTED_VALUE');
  const jobs = urlRows
    .map((row, i) => {
      const id = String(row?.[0] || '').match(/\d+$/)?.[0] || '';
      return id ? { row: OUTPUT_ROW + i, id } : null;
    })
    .filter(Boolean);

  console.log(`Processing ${jobs.length} beatmaps (this will take ~${Math.round(jobs.length * 2 / 60)} minutes)...`);
  await processBeatmapJobs(jobs);
  await moveFCsToHistory();
  await updateLastUpdatedTimestamp();
  console.log(`Done! Processed ${jobs.length} beatmaps.`);
}

async function addNewRankedBeatmaps() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const sinceDate = yesterday.toISOString().split('T')[0];
  const url = `https://osu.ppy.sh/api/get_beatmaps?k=${OSU_API_KEY}&since=${sinceDate}&m=0&approved=1`;

  let beatmaps;
  try {
    beatmaps = JSON.parse(await requestContent(url));
  } catch (err) {
    console.error('Error fetching new ranked beatmaps:', err.message);
    return;
  }
  if (!beatmaps?.length) { console.log('No new ranked beatmaps found.'); return; }

  const ranked = beatmaps.filter(b => b.approved === '1');
  if (!ranked.length) { console.log('No ranked beatmaps (only qualified/other).'); return; }

  const existingIds = await getExistingBeatmapIds();
  const newBeatmaps = ranked.filter(b => !existingIds.includes(b.beatmap_id));
  if (!newBeatmaps.length) { console.log('All new beatmaps already in spreadsheet.'); return; }

  console.log(`Checking ${newBeatmaps.length} new beatmap(s) for FCs...`);
  const lastRow = await sheetLastRow('Data');
  let nextRow = Math.max(lastRow + 1, OUTPUT_ROW);
  const jobs = [];
  const skipped = [];
  let addedCount = 0;

  for (const beatmap of newBeatmaps) {
    let scores = [];
    try {
      scores = JSON.parse(await fetchFromAPI(beatmap.beatmap_id, 'scores')) || [];
    } catch { console.error('Could not fetch scores for', beatmap.beatmap_id); }

    if (scores.some(s => isFC(s, parseInt(beatmap.max_combo)))) {
      skipped.push(beatmap);
    } else {
      jobs.push({ row: nextRow + addedCount, id: beatmap.beatmap_id, beatmapData: beatmap, scores, addInputURL: true });
      addedCount++;
    }
  }

  if (!jobs.length) { console.log('All new beatmaps already have FCs.'); return; }

  await processBeatmapJobs(jobs);
  await sortBeatmapData();
  await updateLastUpdatedTimestamp();

  console.log(`\nAdded ${addedCount} beatmap(s). Skipped ${skipped.length} with FCs.`);
  for (const job of jobs)    console.log(`  + https://osu.ppy.sh/beatmapsets/${job.beatmapData.beatmapset_id}#osu/${job.beatmapData.beatmap_id}`);
  for (const b of skipped)   console.log(`  - https://osu.ppy.sh/beatmapsets/${b.beatmapset_id}#osu/${b.beatmap_id}`);
}

async function moveFCsToHistory() {
  const lastRow = await sheetLastRow('Data');
  const rowCount = lastRow - OUTPUT_ROW + 1;
  if (rowCount <= 0) return;

  // Use FORMATTED_VALUE so dates come back as "M/D/YYYY" strings and mod strings are readable
  const allData = await sheetGet('Data', OUTPUT_ROW, OUTPUT_COL, rowCount, NUM_COLS, 'FORMATTED_VALUE');
  const toMove = [];
  const toDelete = [];

  for (let i = 0; i < allData.length; i++) {
    const row = allData[i] || [];
    if (row.every(c => c === '' || c == null)) continue;

    const daysRanked      = parseInt(row[13]);       // col N
    const scoreDate       = row[15];                 // col P
    const rank            = row[16];                 // col Q
    const modString       = row[17] || '';           // col R
    const currentMaxCombo = parseInt(row[18]);       // col S
    const maxCombo        = parseInt(row[19]);       // col T

    if (isNaN(daysRanked) || isNaN(currentMaxCombo) || isNaN(maxCombo)) continue;

    const score = { rank, maxcombo: currentMaxCombo, enabled_mods: getModEnum(modString) };
    if (!isFC(score, maxCombo)) continue;

    const entry = { row: OUTPUT_ROW + i, beatmapsetID: row[11], beatmapID: row[10] };

    if (daysRanked >= 30) {
      if (scoreDate && scoreDate !== '' && !isNaN(new Date(scoreDate).getTime())) {
        toMove.push(entry);
      }
    } else {
      toDelete.push(entry);
    }
  }

  // Process in reverse row order to avoid row-shift issues after deletions
  const allToProcess = [
    ...toMove.map(e => ({ ...e, action: 'move' })),
    ...toDelete.map(e => ({ ...e, action: 'delete' })),
  ].sort((a, b) => b.row - a.row);

  let moved = 0, deleted = 0;
  for (const item of allToProcess) {
    if (item.action === 'move') {
      await moveRowToHistory(item.row);
      moved++;
    } else {
      await sheetDeleteRow('Data', item.row);
      deleted++;
    }
  }

  // Sort History once at the end rather than after every row move
  if (moved > 0) await sortHistory();

  if (moved || deleted) {
    console.log(`Moved ${moved} FC(s) to History. Deleted ${deleted} recent FC(s).`);
  }
}

async function moveRowToHistory(rowNumber) {
  const columnsToMove = NUM_COLS - 2; // A–T (exclude % FC and Ambiguous FC cols)

  // Two reads: FORMULA for hyperlink formulas, FORMATTED_VALUE for dates/display text
  const [formulaRows, formattedRows] = await Promise.all([
    sheetGet('Data', rowNumber, OUTPUT_COL, 1, columnsToMove, 'FORMULA'),
    sheetGet('Data', rowNumber, OUTPUT_COL, 1, columnsToMove, 'FORMATTED_VALUE'),
  ]);
  const formulaRow   = formulaRows[0]   || [];
  const formattedRow = formattedRows[0] || [];

  // Prefer formula strings (hyperlinks) over formatted values; fall back to formatted for plain cells
  const dataToMove = formulaRow.map((val, i) =>
    typeof val === 'string' && val.startsWith('=') ? val : (formattedRow[i] ?? '')
  );

  const rankedDate = dataToMove[12]; // col M
  const scoreDate  = dataToMove[15]; // col P
  dataToMove[13]   = calculateDaysToFC(rankedDate, scoreDate); // col N → days to FC

  const historyLastRow = await sheetLastRow('History');
  const targetRow = historyLastRow + 1;
  await ensureSheetRows('History', targetRow);
  await sheetSet('History', targetRow, 1, [dataToMove]);

  // Combine row height update and row delete into a single batchUpdate
  await sheetsClient.spreadsheets.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      requests: [
        {
          updateDimensionProperties: {
            range: { sheetId: sheetIds['History'], dimension: 'ROWS', startIndex: historyLastRow, endIndex: historyLastRow + 1 },
            properties: { pixelSize: 21 },
            fields: 'pixelSize',
          },
        },
        {
          deleteDimension: {
            range: { sheetId: sheetIds['Data'], dimension: 'ROWS', startIndex: rowNumber - 1, endIndex: rowNumber },
          },
        },
      ],
    },
  });
}

// ── CLI Entry Point ───────────────────────────────────────────────────────────

async function main() {
  const cmd = process.argv[2];

  if (!SPREADSHEET_ID) { console.error('Missing SPREADSHEET_ID in .env'); process.exit(1); }
  if (!OSU_API_KEY)    { console.error('Missing OSU_API_KEY in .env'); process.exit(1); }

  await initSheets();

  switch (cmd) {
    case 'refresh':   await refreshAllBeatmaps(); break;
    case 'add-new':   await addNewRankedBeatmaps(); break;
    case 'move-fcs':  await moveFCsToHistory(); break;
    case 'sort':      await sortBeatmapData(); console.log('Sorted.'); break;
    case 'backfill':  await backfill(process.argv[3], process.argv[4]); break;
    default:
      console.log('Usage: node no-fc-tracker.js <command> [args]');
      console.log('Commands:');
      console.log('  refresh                       Re-fetch all beatmaps and move FCs to History');
      console.log('  add-new                       Fetch newly ranked beatmaps from the past day');
      console.log('  move-fcs                      Check for FCs and move/delete them');
      console.log('  sort                          Sort Data sheet by star rating');
      console.log('  backfill <since> <until>      Add ranked maps in date range (YYYY-MM-DD)');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
