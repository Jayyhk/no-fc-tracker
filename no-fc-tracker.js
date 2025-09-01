const SPREADSHEET = SpreadsheetApp.getActiveSpreadsheet();
const DATA_SHEET = SPREADSHEET.getSheetByName("Data");
const HISTORY_SHEET = SPREADSHEET.getSheetByName("History");
const ABOUT_SHEET = SPREADSHEET.getSheetByName("About");
const INPUT_COL_NUM = letterToColumn("V"); // Column to input beatmap links
const OUTPUT_COL_NUM = letterToColumn("A"); // Column to start outputting beatmap info
const OUTPUT_ROW_NUM = 2; // Row to start outputting beatmap info
const NUM_OUTPUT_COLS = 21; // Number of columns to return
const LAST_UPDATED_RANGE = "B18:G19"; // Cell range for "Last Updated" timestamp in About sheet
const RATE_LIMIT_DELAY = 200; // API rate limiting delay in ms
const ALLOWED_MODS = {
  ALL_MODS: {
    0: "NM",
    1: "NF",
    2: "EZ",
    4: "TD",
    8: "HD",
    16: "HR",
    32: "SD",
    64: "DT",
    256: "HT",
    512: "NC",
    1024: "FL",
    4096: "SO",
    16384: "PF",
  },
  FORBIDDEN: 2 | 4 | 256 | 4096, // EZ | TD | HT | SO
};
const RANK_VALUE_MAP = new Map([
  ["D", 1],
  ["C", 2],
  ["B", 3],
  ["A", 4],
  ["S", 5],
  ["SH", 5],
  ["X", 6],
  ["XH", 6],
]);
const OSU_API_KEY = (() => {
  try {
    const scriptProperties = PropertiesService.getScriptProperties();
    const apiKey = scriptProperties.getProperty("OSU_API_KEY");
    if (apiKey) {
      return apiKey;
    }
    throw new Error("OSU_API_KEY not found in Script Properties");
  } catch (error) {
    console.error("Error getting API key:", error.message);
    throw new Error(
      "Please set OSU_API_KEY in Google Apps Script Project Settings -> Script Properties"
    );
  }
})();

/**
 * Converts a letter column reference to column number
 * @param {string} letter - Column letter (e.g., "A", "B", "AA")
 * @returns {number} Column number
 */
function letterToColumn(letter) {
  let columnNumber = 0;
  for (let i = 0; i < letter.length; i++) {
    columnNumber = columnNumber * 26 + (letter.charCodeAt(i) - 64);
  }
  return columnNumber;
}

/**
 * Sanitizes strings for use in spreadsheet formulas
 * @param {string} str - String to sanitize
 * @returns {string} Sanitized string
 */
function sanitize(str) {
  return String(str).replace(/"/g, '""');
}

/**
 * Shows a message to the user via UI alert if running manually, or logs to console if running from trigger
 * @param {string} message - Message to display
 */
function showMessage(message) {
  try {
    SpreadsheetApp.getUi().alert(message);
  } catch (error) {
    console.log("Message: " + message);
  }
}

/**
 * Formats date to MM/DD/YYYY format
 * @param {string|Date} dateInput - Date string (YYYY-MM-DD HH:MM:SS) or Date object
 * @returns {string} Formatted date string
 */
function formatDate(dateInput) {
  const date =
    typeof dateInput === "string" ? new Date(dateInput + " UTC") : dateInput;

  const isUTC = typeof dateInput === "string";
  const month = isUTC ? date.getUTCMonth() + 1 : date.getMonth() + 1;
  const day = isUTC ? date.getUTCDate() : date.getDate();
  const year = isUTC ? date.getUTCFullYear() : date.getFullYear();

  return `${month}/${day}/${year}`;
}

/**
 * Formats length in seconds to MM:SS format
 * @param {number} totalSeconds - Length in seconds
 * @returns {string} Formatted length string (MM:SS)
 */
function formatLength(totalSeconds) {
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/**
 * Calculates days since beatmap was ranked
 * @param {string} approvedDate - Date in YYYY-MM-DD HH:MM:SS format
 * @returns {number} Number of days since ranked
 */
function calculateDaysRanked(approvedDate) {
  const date = new Date(approvedDate + " UTC");
  const now = new Date();
  const timeDifference = Math.abs(now - date);
  const daysDifference = Math.ceil(timeDifference / (1000 * 60 * 60 * 24));
  return daysDifference;
}

/**
 * Calculates days between ranked date and score date (for history records)
 * @param {string} rankedDate - Ranked date in MM/DD/YYYY format
 * @param {string} scoreDate - Score date in MM/DD/YYYY format
 * @returns {number} Number of days from ranked to FC
 */
function calculateDaysToFC(rankedDate, scoreDate) {
  const ranked = new Date(rankedDate);
  const score = new Date(scoreDate);
  const timeDifference = Math.abs(score - ranked);
  const daysDifference = Math.ceil(timeDifference / (1000 * 60 * 60 * 24));
  return daysDifference;
}

/**
 * Converts mod enum to string representation
 * @param {number} modsEnum - Bitwise mod flags
 * @returns {string} String representation of mods (e.g., "HDHR", "DT", "NM")
 */
function getModString(modsEnum) {
  if (modsEnum === 0) return "NM";

  let modString = "";

  const modFlags = Object.keys(ALLOWED_MODS.ALL_MODS)
    .map(Number)
    .filter((flag) => flag > 0)
    .sort((a, b) => a - b);

  for (const modFlag of modFlags) {
    if (modsEnum & modFlag) {
      modString += ALLOWED_MODS.ALL_MODS[modFlag];
    }
  }

  return modString;
}

/**
 * Creates the custom menu when the spreadsheet opens
 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu("osu-Tools")
    .addItem("Setup Daily Auto-Refresh", "setupDailyTrigger")
    .addItem("Remove Daily Auto-Refresh", "removeDailyTrigger")
    .addSeparator()
    .addItem("Refresh All Beatmaps", "refreshAllBeatmaps")
    .addItem("Add New Ranked Beatmaps", "addNewRankedBeatmaps")
    .addItem("Move All FCs to History", "moveFCsToHistory")
    .addItem("Move Row to History", "moveRowToHistoryManual")
    .addItem("Sort History", "sortHistoryManual")
    .addToUi();
}

/**
 * Sets up daily triggers: refresh at 11:00 PM, add new beatmaps at 12:00 AM EST/EDT
 */
function setupDailyTrigger() {
  removeDailyTrigger();

  ScriptApp.newTrigger("refreshAllBeatmaps")
    .timeBased()
    .everyDays(1)
    .atHour(23) // 11:00 PM
    .inTimezone("America/New_York") // EST/EDT timezone
    .create();

  ScriptApp.newTrigger("addNewRankedBeatmaps")
    .timeBased()
    .everyDays(1)
    .atHour(0) // 12:00 AM
    .inTimezone("America/New_York") // EST/EDT timezone
    .create();

  showMessage(
    "Daily auto-refresh has been set up with two triggers:\n\n" +
      "• 11:00 PM EST/EDT: Refresh existing beatmaps\n" +
      "• 12:00 AM EST/EDT: Add new ranked beatmaps"
  );
}

/**
 * Removes all triggers for the daily auto-refresh functions
 */
function removeDailyTrigger() {
  const triggers = ScriptApp.getProjectTriggers();
  let removedCount = 0;

  triggers.forEach((trigger) => {
    const handlerFunction = trigger.getHandlerFunction();
    if (
      handlerFunction === "refreshAllBeatmaps" ||
      handlerFunction === "addNewRankedBeatmaps"
    ) {
      ScriptApp.deleteTrigger(trigger);
      removedCount++;
    }
  });

  showMessage(`Removed ${removedCount} daily auto-refresh trigger(s).`);
}

/**
 * Triggers when a cell is edited - processes beatmap data automatically
 * @param {Object} e - The event object
 */
function setBeatmapDataOnEdit(e) {
  const range = e.range;
  const sheet = range.getSheet();

  if (
    sheet.getName() !== DATA_SHEET.getName() ||
    range.getColumn() !== INPUT_COL_NUM ||
    range.getNumColumns() !== 1
  ) {
    return;
  }

  const firstRow = range.getRow();
  for (let i = 0; i < range.getNumRows(); i++) {
    updateSpreadsheetRow(firstRow + i);
  }

  sortBeatmapData();
}

/**
 * Bulk-refreshes all beatmaps in column V by processing in 15-map chunks with 3-second pauses.
 * Also moves any FCs to History and updates the timestamp. Called by menu or trigger.
 */
function refreshAllBeatmaps() {
  const lastRow = DATA_SHEET.getLastRow();
  const rowCount = lastRow - OUTPUT_ROW_NUM + 1;

  const beatmapIdRegex = /\d+$/;

  const rawValues = DATA_SHEET.getRange(
    OUTPUT_ROW_NUM,
    INPUT_COL_NUM,
    rowCount,
    1
  ).getValues();
  const jobs = [];

  for (let i = 0; i < rawValues.length; i++) {
    const url = String(rawValues[i][0]);
    const match = url.match(beatmapIdRegex);
    if (match) {
      jobs.push({ row: OUTPUT_ROW_NUM + i, id: match[0] });
    }
  }

  if (jobs.length === 0) {
    showMessage("No valid beatmap IDs found to refresh.");
    return;
  }

  processBeatmapJobs(jobs);
  moveFCsToHistory();
  updateLastUpdatedTimestamp();

  showMessage(`Refresh complete! Updated ${jobs.length} beatmap(s).`);
}

/**
 * Fetches newly ranked beatmaps from the past day and adds only those without FCs to the spreadsheet
 */
function addNewRankedBeatmaps() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const sinceDate = yesterday.toISOString().split("T")[0];
  const url = `https://osu.ppy.sh/api/get_beatmaps?k=${OSU_API_KEY}&since=${sinceDate}&m=0&approved=1`;

  let beatmaps;
  try {
    const response = requestContent(url);
    beatmaps = JSON.parse(response);
  } catch (error) {
    showMessage("Error fetching new ranked beatmaps: " + error.message);
    return;
  }

  if (!beatmaps || beatmaps.length === 0) {
    showMessage("No new ranked beatmaps found in the past day.");
    return;
  }

  const rankedBeatmaps = beatmaps.filter((beatmap) => beatmap.approved === "1");
  if (rankedBeatmaps.length === 0) {
    showMessage(
      "No new ranked beatmaps found in the past day (only qualified/other status found)."
    );
    return;
  }

  const existingBeatmapIds = getExistingBeatmapIds();
  const newBeatmaps = rankedBeatmaps.filter(
    (beatmap) => !existingBeatmapIds.includes(beatmap.beatmap_id)
  );

  if (newBeatmaps.length === 0) {
    showMessage("All newly ranked beatmaps are already in the spreadsheet.");
    return;
  }

  const lastRow = DATA_SHEET.getLastRow();
  let nextRow = Math.max(lastRow + 1, OUTPUT_ROW_NUM);

  const jobs = [];
  const skippedBeatmapIDs = [];
  let addedCount = 0;

  for (let i = 0; i < newBeatmaps.length; i++) {
    const beatmap = newBeatmaps[i];

    let scores = [];
    try {
      scores = JSON.parse(fetchFromAPI(beatmap.beatmap_id, "scores")) || [];
    } catch (error) {
      console.log("Could not fetch scores for beatmap " + beatmap.beatmap_id);
    }

    const maxCombo = parseInt(beatmap.max_combo);
    const hasFC = scores.some((score) => isFC(score, maxCombo));

    if (!hasFC) {
      jobs.push({
        row: nextRow + addedCount,
        id: beatmap.beatmap_id,
        beatmapData: beatmap,
        scores: scores,
        addInputURL: true,
      });
      addedCount++;
    } else {
      skippedBeatmapIDs.push({
        beatmapsetID: beatmap.beatmapset_id,
        beatmapID: beatmap.beatmap_id,
      });
    }
  }

  if (jobs.length === 0) {
    showMessage("All newly ranked beatmaps already have FCs.");
    return;
  }

  processBeatmapJobs(jobs);
  sortBeatmapData();

  const skippedCount = newBeatmaps.length - addedCount;
  let addedMessage = `Added ${addedCount} newly ranked beatmap(s) to the spreadsheet.`;
  if (jobs.length > 0) {
    addedMessage += "\n\nNewly added beatmaps:";
    for (const job of jobs) {
      const beatmapURL = `https://osu.ppy.sh/beatmapsets/${job.beatmapData.beatmapset_id}#osu/${job.beatmapData.beatmap_id}`;
      addedMessage += `\n${beatmapURL}`;
    }
  }
  showMessage(addedMessage);

  let skippedMessage = `Skipped ${skippedCount} beatmap(s) with FCs.`;
  if (skippedBeatmapIDs.length > 0) {
    skippedMessage += "\n\nSkipped beatmaps:";
    for (const beatmapData of skippedBeatmapIDs) {
      const beatmapURL = `https://osu.ppy.sh/beatmapsets/${beatmapData.beatmapsetID}#osu/${beatmapData.beatmapID}`;
      skippedMessage += `\n${beatmapURL}`;
    }
  }
  showMessage(skippedMessage);

  updateLastUpdatedTimestamp();
}

/**
 * Checks all beatmaps in the Data sheet for FCs. Moves FCs that are 30+ days old to History
 * (if they have valid score dates), or deletes FCs that are less than 30 days old.
 */
function moveFCsToHistory() {
  const lastRow = DATA_SHEET.getLastRow();
  const beatmapsToMoveToHistory = [];
  const beatmapsToDelete = [];

  const rowCount = lastRow - OUTPUT_ROW_NUM + 1;
  const allData = DATA_SHEET.getRange(
    OUTPUT_ROW_NUM,
    OUTPUT_COL_NUM,
    rowCount,
    NUM_OUTPUT_COLS
  ).getValues();

  for (let i = 0; i < allData.length; i++) {
    const rowData = allData[i];
    const row = OUTPUT_ROW_NUM + i;

    if (
      rowData.every(
        (cell) => cell === "" || cell === null || cell === undefined
      )
    ) {
      continue;
    }

    const daysRanked = parseInt(rowData[13]); // Column N (days ranked)
    const scoreDate = rowData[15]; // Column P (score date)
    const rank = rowData[16]; // Column Q (rank)
    const currentMaxCombo = parseInt(rowData[18]); // Column S (current max combo)
    const maxCombo = parseInt(rowData[19]); // Column T (max combo)

    if (isNaN(daysRanked) || isNaN(currentMaxCombo) || isNaN(maxCombo))
      continue;

    // Create mock score object to use with existing isFC method
    // Mods are already validated when added to sheet, so we can use NM (0)
    const mockScore = {
      rank: rank,
      maxcombo: currentMaxCombo,
      enabled_mods: 0, // 0 = NM
    };
    const hasFC = isFC(mockScore, maxCombo);

    if (hasFC) {
      const beatmapsetId = rowData[11]; // Column L (beatmapset ID)
      const beatmapId = rowData[10]; // Column K (beatmap ID)

      if (daysRanked >= 30) {
        if (scoreDate && scoreDate !== "" && scoreDate !== null) {
          const parsedScoreDate = new Date(scoreDate);
          if (!isNaN(parsedScoreDate.getTime())) {
            beatmapsToMoveToHistory.push({
              row: row,
              beatmapsetID: beatmapsetId,
              beatmapID: beatmapId,
            });
          }
        }
      } else {
        beatmapsToDelete.push({
          row: row,
          beatmapsetID: beatmapsetId,
          beatmapID: beatmapId,
        });
      }
    }
  }

  if (beatmapsToMoveToHistory.length === 0 && beatmapsToDelete.length === 0)
    return;

  // Process deletions and moves in reverse order to avoid row shifting issues
  const allRowsToProcess = [
    ...beatmapsToMoveToHistory.map((item) => ({ ...item, action: "move" })),
    ...beatmapsToDelete.map((item) => ({ ...item, action: "delete" })),
  ].sort((a, b) => b.row - a.row);

  let movedCount = 0;
  let deletedCount = 0;

  for (const item of allRowsToProcess) {
    if (item.action === "move") {
      moveRowToHistory(item.row);
      movedCount++;
    } else if (item.action === "delete") {
      DATA_SHEET.deleteRow(item.row);
      deletedCount++;
    }
  }

  if (movedCount > 0) {
    sortHistory();
  }

  let movedMessage = `Moved ${movedCount} beatmap(s) with FCs to History sheet (30+ days old).`;
  if (beatmapsToMoveToHistory.length > 0) {
    movedMessage += "\n\nBeatmaps moved to History:";
    for (const beatmapData of beatmapsToMoveToHistory) {
      const beatmapURL = `https://osu.ppy.sh/beatmapsets/${beatmapData.beatmapsetID}#osu/${beatmapData.beatmapID}`;
      movedMessage += `\n${beatmapURL}`;
    }
  }
  showMessage(movedMessage.trim());

  let deletedMessage = `Deleted ${deletedCount} beatmap(s) with FCs (less than 30 days old).`;
  if (beatmapsToDelete.length > 0) {
    deletedMessage += "\n\nDeleted beatmaps:";
    for (const beatmapData of beatmapsToDelete) {
      const beatmapURL = `https://osu.ppy.sh/beatmapsets/${beatmapData.beatmapsetID}#osu/${beatmapData.beatmapID}`;
      deletedMessage += `\n${beatmapURL}`;
    }
  }
  showMessage(deletedMessage);
}

/**
 * Moves a specified row from Data sheet to History sheet by row number
 * @param {number} rowNumber - Row number to move
 * @returns {boolean} True if successful, false if failed
 */
function moveRowToHistory(rowNumber) {
  const lastRow = DATA_SHEET.getLastRow();
  if (isNaN(rowNumber)) {
    showMessage(`Error: Row ${rowNumber} is not a valid number.`);
    return false;
  }

  if (rowNumber < OUTPUT_ROW_NUM) {
    showMessage(
      `Error: Row ${rowNumber} is not a valid data row. Data starts at row ${OUTPUT_ROW_NUM}.`
    );
    return false;
  }

  if (rowNumber > lastRow) {
    showMessage(
      `Error: Row ${rowNumber} does not exist. Last row is ${lastRow}.`
    );
    return false;
  }

  const rowData = DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM,
    1,
    NUM_OUTPUT_COLS
  ).getValues()[0];

  const columnsToMove = NUM_OUTPUT_COLS - 1;

  const formulas = DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM,
    1,
    columnsToMove
  ).getFormulas()[0];
  const values = DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM,
    1,
    columnsToMove
  ).getValues()[0];

  const dataToMove = formulas.map((formula, index) => {
    return formula || values[index];
  });

  const rankedDate = dataToMove[12]; // Column M (ranked date)
  const scoreDate = dataToMove[15]; // Column P (score date)
  dataToMove[13] = calculateDaysToFC(rankedDate, scoreDate); // Column N (days to FC)
  const historyLastRow = HISTORY_SHEET.getLastRow();
  const targetRow = historyLastRow + 1;

  HISTORY_SHEET.getRange(targetRow, 1, 1, dataToMove.length).setValues([
    dataToMove,
  ]);
  applyHistoryRowFormatting(targetRow);
  DATA_SHEET.deleteRow(rowNumber);
  sortHistory();
  
  return true;
}

/**
 * Prompts user to select a row number to move to History sheet
 */
function moveRowToHistoryManual() {
  const ui = SpreadsheetApp.getUi();

  const response = ui.prompt(
    "Move Row to History",
    "Enter the row number to move to History sheet:",
    ui.ButtonSet.OK_CANCEL
  );

  if (response.getSelectedButton() !== ui.Button.OK) {
    return;
  }

  const inputText = response.getResponseText().trim();
  const rowNumber = parseInt(inputText);

  const success = moveRowToHistory(rowNumber);
  if (success) {
    showMessage(`Successfully moved row ${rowNumber} to History sheet.`);
  }
}

/**
 * Updates the "Last Updated" timestamp in the About sheet
 */
function updateLastUpdatedTimestamp() {
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayString = formatDate(yesterday);

  const mergedRange = ABOUT_SHEET.getRange(LAST_UPDATED_RANGE);
  mergedRange.setValue(`Last Updated: ${yesterdayString}`);
}

/**
 * Processes beatmap jobs in batches of 15 with 3-second pauses between batches for rate limiting
 * @param {Array} jobs - Array of job objects with {row, id, beatmapData?, addInputURL?}
 */
function processBeatmapJobs(jobs) {
  const BATCH_SIZE = 15;
  const PAUSE_MS = 3000;

  // Collect all processed data for bulk operations
  const allRowData = [];
  const allInputURLs = [];
  const rowNumbers = [];

  const beatmapApiTemplate = `https://osu.ppy.sh/api/get_beatmaps?k=${OSU_API_KEY}&b=`;
  const scoresApiTemplate = `https://osu.ppy.sh/api/get_scores?k=${OSU_API_KEY}&b=`;

  for (let offset = 0; offset < jobs.length; offset += BATCH_SIZE) {
    const batch = jobs.slice(offset, offset + BATCH_SIZE);

    const jobsNeedingBeatmapData = [];
    const jobsWithBeatmapData = [];

    for (const job of batch) {
      if (job.beatmapData) {
        jobsWithBeatmapData.push(job);
      } else {
        jobsNeedingBeatmapData.push(job);
      }
    }

    const bmCalls = jobsNeedingBeatmapData.map((job) => ({
      url: beatmapApiTemplate + job.id,
    }));

    const scCalls = batch.map((job) => ({
      url: scoresApiTemplate + job.id,
    }));

    const bmRes = bmCalls.length > 0 ? UrlFetchApp.fetchAll(bmCalls) : [];
    const scRes = UrlFetchApp.fetchAll(scCalls);

    let bmIndex = 0;
    batch.forEach((job, i) => {
      const result = processBeatmapJobForBulk(job, bmRes, scRes, bmIndex, i);
      if (result) {
        allRowData.push(result.rowData);
        rowNumbers.push(job.row);
        if (result.inputURL) {
          allInputURLs.push({ row: job.row, url: result.inputURL });
        }
      }
      if (!job.beatmapData) bmIndex++;
    });

    Utilities.sleep(PAUSE_MS);
  }

  // Bulk write all collected data
  if (allRowData.length > 0) {
    setBulkRowData(rowNumbers, allRowData);
  }

  // Bulk set input URLs
  if (allInputURLs.length > 0) {
    setBulkInputURLs(allInputURLs);
  }
}

/**
 * Processes a single beatmap job: fetches data, creates row, and optionally adds beatmap URL
 * @param {Object} job - Job object with {row, id, beatmapData?, scores?, addInputURL?}
 * @param {Array} bmRes - Beatmap API responses
 * @param {Array} scRes - Scores API responses
 * @param {number} bmIndex - Index for beatmap response
 * @param {number} scIndex - Index for scores response
 */
function processSingleBeatmapJob(job, bmRes, scRes, bmIndex, scIndex) {
  let beatmapData = job.beatmapData;
  let scores = job.scores || [];

  if (!beatmapData) {
    try {
      beatmapData = JSON.parse(bmRes[bmIndex].getContentText("UTF-8"))[0];
    } catch (e) {
      setRowData(job.row, createErrorRow());
      return;
    }

    if (!beatmapData) {
      setRowData(job.row, createErrorRow("Invalid beatmap ID"));
      return;
    }
  }

  if (!job.scores) {
    try {
      scores = JSON.parse(scRes[scIndex].getContentText("UTF-8")) || [];
    } catch (error) {
      console.log("Could not fetch scores for beatmap " + job.id);
    }
  }

  const rowData = createBeatmapRow(beatmapData, scores);
  setRowData(job.row, [rowData]);

  if (job.addInputURL && beatmapData) {
    const beatmapURL = `https://osu.ppy.sh/beatmapsets/${beatmapData.beatmapset_id}#osu/${beatmapData.beatmap_id}`;
    DATA_SHEET.getRange(job.row, INPUT_COL_NUM, 1, 1).setValue(beatmapURL);
  }
}

/**
 * Processes a single beatmap job for bulk operations: returns data instead of immediately writing
 * @param {Object} job - Job object with {row, id, beatmapData?, scores?, addInputURL?}
 * @param {Array} bmRes - Beatmap API responses
 * @param {Array} scRes - Scores API responses
 * @param {number} bmIndex - Index for beatmap response
 * @param {number} scIndex - Index for scores response
 * @returns {Object|null} Result object with rowData and optional inputURL
 */
function processBeatmapJobForBulk(job, bmRes, scRes, bmIndex, scIndex) {
  let beatmapData = job.beatmapData;
  let scores = job.scores || [];

  if (!beatmapData) {
    try {
      beatmapData = JSON.parse(bmRes[bmIndex].getContentText("UTF-8"))[0];
    } catch (e) {
      return { rowData: createErrorRow()[0] };
    }

    if (!beatmapData) {
      return { rowData: createErrorRow("Invalid beatmap ID")[0] };
    }
  }

  if (!job.scores) {
    try {
      scores = JSON.parse(scRes[scIndex].getContentText("UTF-8")) || [];
    } catch (error) {
      console.log("Could not fetch scores for beatmap " + job.id);
    }
  }

  const rowData = createBeatmapRow(beatmapData, scores);
  const result = { rowData };

  if (job.addInputURL && beatmapData) {
    result.inputURL = `https://osu.ppy.sh/beatmapsets/${beatmapData.beatmapset_id}#osu/${beatmapData.beatmap_id}`;
  }

  return result;
}

/**
 * Updates a single row in the spreadsheet with beatmap data, or deletes the row if beatmap link is cleared
 * @param {number} rowNumber - Row number to update
 */
function updateSpreadsheetRow(rowNumber) {
  const inputValue = DATA_SHEET.getRange(rowNumber, INPUT_COL_NUM).getValue();
  const beatmapIDMatch = String(inputValue).match(/\d+$/);
  const beatmapID = beatmapIDMatch ? beatmapIDMatch[0] : "";
  const targetRange = DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM,
    1,
    NUM_OUTPUT_COLS
  );

  if (!beatmapID) {
    // Check if input value is empty/cleared (not just missing beatmap ID)
    const inputString = String(inputValue).trim();
    if (
      inputString === "" ||
      inputString === "null" ||
      inputString === "undefined"
    ) {
      // Clear content first, then delete the row if it's not a header row
      targetRange.clearContent();
      if (rowNumber >= OUTPUT_ROW_NUM) {
        DATA_SHEET.deleteRow(rowNumber);
      }
    }
    return;
  }

  targetRange.setValues(fetchBeatmapData(beatmapID));
  applyRowFormatting(rowNumber);
}

/**
 * Makes a request to a URL with rate limiting
 * @param {string} url - URL to fetch
 * @returns {string} Response content
 */
function requestContent(url) {
  try {
    const response = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
    });

    const responseCode = response.getResponseCode();
    if (responseCode !== 200) {
      throw new Error(`HTTP ${responseCode}: ${response.getContentText()}`);
    }

    const content = response.getContentText("UTF-8");
    Utilities.sleep(RATE_LIMIT_DELAY);
    return content;
  } catch (error) {
    console.error(`API request failed for ${url}: ${error.message}`);
    throw error;
  }
}

/**
 * Fetches data from osu! API
 * @param {string} beatmapID - Beatmap ID
 * @param {string} endpoint - API endpoint ('beatmaps' or 'scores')
 * @returns {string} JSON response from API
 */
function fetchFromAPI(beatmapID, endpoint) {
  const endpointMap = {
    beatmaps: `get_beatmaps?k=${OSU_API_KEY}&b=${beatmapID}`,
    scores: `get_scores?k=${OSU_API_KEY}&b=${beatmapID}`,
  };
  const url = `https://osu.ppy.sh/api/${endpointMap[endpoint]}`;
  return requestContent(url);
}

/**
 * Fetches beatmap data from API and formats it for spreadsheet
 * @param {string} beatmapID - Beatmap ID
 * @returns {Array} 2D array for spreadsheet
 */
function fetchBeatmapData(beatmapID) {
  try {
    const beatmapResponse = JSON.parse(fetchFromAPI(beatmapID, "beatmaps"));
    const beatmapData = beatmapResponse && beatmapResponse[0];

    if (!beatmapData) {
      return createErrorRow("Invalid beatmap ID");
    }

    let scores = [];
    try {
      scores = JSON.parse(fetchFromAPI(beatmapData.beatmap_id, "scores")) || [];
    } catch (error) {
      console.log("Could not fetch scores:", error);
    }

    const rowData = createBeatmapRow(beatmapData, scores);
    return [rowData];
  } catch (error) {
    console.error("Error in fetchBeatmapData:", error);
    return createErrorRow("API Error: " + error.message);
  }
}

/**
 * Finds the best score from the first 50 scores with allowed mods
 * Priority: 1) Any FC (exits immediately), 2) Highest combo, 3) Best rank when combo tied
 * @param {Array} scores - Array of score objects
 * @param {number} maxCombo - Maximum combo for the beatmap
 * @returns {Object} Best score data with highest combo and best rank, including percentFC
 */
function findBestScore(scores, maxCombo) {
  let bestUserID = 0;
  let bestUsername = "";
  let bestModString = "";
  let bestCombo = 0;
  let bestRank = "";
  let bestDate = "";

  const scoreLimit = Math.min(scores.length, 50);

  for (let i = 0; i < scoreLimit; i++) {
    const score = scores[i];
    const combo = parseInt(score.maxcombo);
    const modsEnum = parseInt(score.enabled_mods);

    if (isModAllowed(modsEnum)) {
      if (isFC(score, maxCombo)) {
        bestUserID = parseInt(score.user_id);
        bestUsername = score.username;
        bestModString = getModString(modsEnum);
        bestCombo = combo;
        bestRank = score.rank;
        bestDate = score.date;
        break;
      }

      const currentRankValue = getRankValue(score.rank);
      const bestRankValue = getRankValue(bestRank);

      // Update if: higher combo, or same combo but better rank
      if (
        combo > bestCombo ||
        (combo === bestCombo && currentRankValue > bestRankValue)
      ) {
        bestUserID = parseInt(score.user_id);
        bestUsername = score.username;
        bestModString = getModString(modsEnum);
        bestCombo = combo;
        bestRank = score.rank;
        bestDate = score.date;
      }
    }
  }

  const percentFC = (bestCombo / maxCombo) * 100;
  return {
    userID: bestUserID,
    player: bestUserID ? createPlayerHyperlink(bestUserID, bestUsername) : "",
    modString: bestModString,
    currentMaxCombo: bestCombo,
    rank: bestRank,
    scoreDate: bestDate ? formatDate(bestDate) : "",
    percentFC: percentFC,
  };
}

/**
 * Gets existing beatmap IDs from the spreadsheet to avoid duplicates
 * @returns {Array} Array of existing beatmap IDs
 */
function getExistingBeatmapIds() {
  const lastRow = DATA_SHEET.getLastRow();
  const rowCount = lastRow - OUTPUT_ROW_NUM + 1;
  const beatmapIdCol = OUTPUT_COL_NUM + 10; // Column K (beatmap ID column)

  const beatmapIds = DATA_SHEET.getRange(
    OUTPUT_ROW_NUM,
    beatmapIdCol,
    rowCount,
    1
  )
    .getValues()
    .flat()
    .map(String)
    .filter((id) => id && id !== "");

  return beatmapIds;
}

/**
 * Gets the numeric value of a rank for comparison purposes
 * @param {string} rank - Rank string (D, C, B, A, S, SH, X, XH)
 * @returns {number} Numeric value for comparison (higher = better)
 */
function getRankValue(rank) {
  return RANK_VALUE_MAP.get(rank) || 0;
}

/**
 * Checks if mod combination is allowed (no forbidden mods)
 * @param {number} modsEnum - Bitwise mod flags
 * @returns {boolean} True if mod combination is allowed
 */
function isModAllowed(modsEnum) {
  return (modsEnum & ALLOWED_MODS.FORBIDDEN) === 0;
}

/**
 * Checks if a score qualifies as an FC
 * @param {Object} score - Score object from API (with rank, maxcombo, enabled_mods)
 * @param {number} maxCombo - Maximum combo for the beatmap
 * @returns {boolean} True if the score is an FC
 */
function isFC(score, maxCombo) {
  if (!score) return false;

  const rank = score.rank;
  const combo = parseInt(score.maxcombo);
  const modsEnum = parseInt(score.enabled_mods);

  const hasValidRank =
    rank === "S" || rank === "SH" || rank === "X" || rank === "XH";
  const hasHighCombo = combo >= maxCombo - 1; // maxcombo - 1 is an fc unless a sliderbreak occurs on the first note which must be a slider (extremely unlikely)
  const hasAllowedMods = isModAllowed(modsEnum);

  return hasValidRank && hasHighCombo && hasAllowedMods;
}

/**
 * Creates a row out of beatmap and score data for the spreadsheet
 * @param {Object} beatmapData - Beatmap data from API
 * @param {Array} scores - Scores data from API
 * @returns {Array} Row data array
 */
function createBeatmapRow(beatmapData, scores) {
  const bg = `=IMAGE("https://assets.ppy.sh/beatmaps/${beatmapData.beatmapset_id}/covers/cover.jpg", 2)`;
  const beatmapName = createBeatmapNameHyperlink(beatmapData);
  const starRating = parseFloat(beatmapData.difficultyrating);
  const length = formatLength(parseInt(beatmapData.total_length));
  const bpm = parseFloat(beatmapData.bpm);
  const cs = parseFloat(beatmapData.diff_size);
  const ar = parseFloat(beatmapData.diff_approach);
  const od = parseFloat(beatmapData.diff_overall);
  const hp = parseFloat(beatmapData.diff_drain);
  const maxCombo = parseInt(beatmapData.max_combo);
  const mapper = createPlayerHyperlink(
    beatmapData.creator_id,
    beatmapData.creator
  );
  const beatmapID = beatmapData.beatmap_id;
  const beatmapsetID = beatmapData.beatmapset_id;
  const rankedDate = formatDate(beatmapData.approved_date);
  const daysRanked = calculateDaysRanked(beatmapData.approved_date);
  const bestScore = findBestScore(scores, maxCombo);

  return [
    bg,
    beatmapName,
    starRating,
    length,
    bpm,
    cs,
    ar,
    od,
    hp,
    mapper,
    beatmapID,
    beatmapsetID,
    rankedDate,
    daysRanked,
    bestScore.player,
    bestScore.scoreDate,
    bestScore.rank,
    bestScore.modString,
    bestScore.currentMaxCombo,
    maxCombo,
    bestScore.percentFC,
  ];
}

/**
 * Creates a hyperlink formula for Google Sheets
 * @param {string} url - URL to link to
 * @param {string} text - Display text
 * @returns {string} Google Sheets formula for hyperlink
 */
function createHyperlink(url, text) {
  return `=HYPERLINK("${url}","${text}")`;
}

/**
 * Creates a hyperlinked beatmap name with artist, title, and difficulty
 * @param {Object} beatmapData - Beatmap data object
 * @returns {string} Google Sheets formula for hyperlinked name
 */
function createBeatmapNameHyperlink(beatmapData) {
  const url = `https://osu.ppy.sh/beatmapsets/${beatmapData.beatmapset_id}#osu/${beatmapData.beatmap_id}`;
  const displayText = `${sanitize(beatmapData.artist)}\n${sanitize(
    beatmapData.title
  )}\n[${sanitize(beatmapData.version)}]`;
  return createHyperlink(url, displayText);
}

/**
 * Creates a hyperlinked player name
 * @param {number} userID - User ID
 * @param {string} username - Username
 * @returns {string} Google Sheets formula for hyperlinked player name
 */
function createPlayerHyperlink(userID, username) {
  return createHyperlink(`https://osu.ppy.sh/users/${userID}/osu`, username);
}

/**
 * Creates an error row with custom message for spreadsheet display
 * @param {string} message - Error message to display (defaults to "API Error")
 * @returns {Array} 2D array with error message in first cell, rest empty
 */
function createErrorRow(message = "API Error") {
  return [[message].concat(new Array(NUM_OUTPUT_COLS - 1))];
}

/**
 * Sets row data in the Data sheet and applies formatting (handles both 1D and 2D arrays)
 * @param {number} row - Row number to update
 * @param {Array} data - Row data array or 2D array
 */
function setRowData(row, data) {
  // Handle both single row array and 2D array formats
  const isArray2D = Array.isArray(data[0]);
  if (isArray2D) {
    DATA_SHEET.getRange(
      row,
      OUTPUT_COL_NUM,
      data.length,
      data[0].length
    ).setValues(data);
  } else {
    DATA_SHEET.getRange(row, OUTPUT_COL_NUM, 1, data.length).setValues([data]);
  }
  applyRowFormatting(row);
}

/**
 * Applies formatting to a row in the Data sheet
 * @param {number} rowNumber - Row number to format
 */
function applyRowFormatting(rowNumber) {
  DATA_SHEET.setRowHeightsForced(rowNumber, 1, 21);

  const formatOffsets = {
    starRating: 2,
    length: 3,
    bpm: 4,
    cs: 5,
    ar: 6,
    od: 7,
    hp: 8,
    percentFC: 20,
  };

  DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM + formatOffsets.starRating
  ).setNumberFormat("0.00");
  DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM + formatOffsets.length
  ).setNumberFormat("@");
  DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM + formatOffsets.bpm
  ).setNumberFormat("0.##");
  DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM + formatOffsets.cs
  ).setNumberFormat("0.#");
  DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM + formatOffsets.ar
  ).setNumberFormat("0.#");
  DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM + formatOffsets.od
  ).setNumberFormat("0.#");
  DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM + formatOffsets.hp
  ).setNumberFormat("0.#");
  DATA_SHEET.getRange(
    rowNumber,
    OUTPUT_COL_NUM + formatOffsets.percentFC
  ).setNumberFormat("0.00");
}

/**
 * Applies formatting to a row in the History sheet
 * @param {number} rowNumber - Row number to format
 */
function applyHistoryRowFormatting(rowNumber) {
  HISTORY_SHEET.setRowHeightsForced(rowNumber, 1, 21);
}

/**
 * Sorts beatmap data by star rating (ascending)
 */
function sortBeatmapData() {
  const lastRow = DATA_SHEET.getLastRow();
  const sortRange = DATA_SHEET.getRange(
    OUTPUT_ROW_NUM,
    OUTPUT_COL_NUM,
    lastRow - OUTPUT_ROW_NUM + 1,
    NUM_OUTPUT_COLS + 1
  );

  sortRange.sort({
    column: OUTPUT_COL_NUM + 2, // Column C (star rating)
    ascending: true,
  });
}

/**
 * Sorts History sheet data by score date (when the play happened), then by star rating to break ties (both ascending)
 */
function sortHistory() {
  const lastRow = HISTORY_SHEET.getLastRow();
  const sortRange = HISTORY_SHEET.getRange(
    2, // Start from row 2 (assuming row 1 is header)
    1, // Start from column 1
    lastRow - 1, // Number of rows to include
    NUM_OUTPUT_COLS - 1 // Number of columns (excluding the last column we don't move)
  );

  sortRange.sort([
    { column: 16, ascending: true }, // First sort by score date (column P) - when the play happened
    { column: 3, ascending: true }, // Then by star rating (column C) to break ties
  ]);
}

/**
 * Sorts History sheet by score date, then by star rating to break ties, and shows confirmation message
 */
function sortHistoryManual() {
  const lastRow = HISTORY_SHEET.getLastRow();
  sortHistory();
  showMessage(
    "History sheet has been sorted by score date, then by star rating (both oldest/lowest to newest/highest)."
  );
}

/**
 * Bulk sets multiple rows of data and applies formatting efficiently
 * @param {Array} rowNumbers - Array of row numbers to update
 * @param {Array} allRowData - Array of row data arrays
 */
function setBulkRowData(rowNumbers, allRowData) {
  if (rowNumbers.length === 0 || allRowData.length === 0) return;

  // For now, write each row individually but without the sleep delays
  // This still provides performance benefits by avoiding individual API calls during processing
  for (let i = 0; i < rowNumbers.length; i++) {
    const row = rowNumbers[i];
    const data = allRowData[i];

    // Set the row data
    DATA_SHEET.getRange(row, OUTPUT_COL_NUM, 1, data.length).setValues([data]);

    // Apply formatting
    applyRowFormatting(row);
  }
}

/**
 * Bulk sets input URLs for multiple rows
 * @param {Array} inputURLs - Array of {row, url} objects
 */
function setBulkInputURLs(inputURLs) {
  if (inputURLs.length === 0) return;

  // Set each URL individually for now
  inputURLs.forEach((item) => {
    DATA_SHEET.getRange(item.row, INPUT_COL_NUM, 1, 1).setValue(item.url);
  });
}
