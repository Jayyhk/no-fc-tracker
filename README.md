# osu!standard No FC Tracker

A Node.js script that tracks all osu!standard ranked beatmaps without a Full Combo (FC). It automatically fetches beatmap data, verifies FC status, and manages a Google Sheet of unFC'd maps. The public sheet can be found [here](https://docs.google.com/spreadsheets/d/1zaTkQJug5aPn-39Zk6vjhZsRs-cF8dPgfixILvXV6xs/edit?usp=sharing).

> [!NOTE]
> **osu!stable only** - this does not track osu!lazer scores.
>
> **Valid mods:** NM, NF, HD, HR, SD, DT, NC, FL, PF
>
> **Invalid mods:** EZ, TD, HT, SO

## How FC detection works

A score is considered an FC if:
- Its rank is S/SH/X/XH
- It used SD or PF (forced FC mods), or
- Its combo is `>= max_combo - 1`

For **ambiguous scores** — where `combo + count_100 + count_50 >= max_combo` but the combo heuristic alone can't confirm an FC — the script downloads the replay and runs it through [danser-go](https://github.com/Wieku/danser-go) headlessly to simulate the play and verify whether combo was ever broken.

## Commands

```
node no-fc-tracker.js refresh [startRow] [endRow]  Re-fetch beatmaps and move FCs to History
node no-fc-tracker.js add-new                      Fetch newly ranked beatmaps from the past day
node no-fc-tracker.js move-fcs                     Check for FCs and move/delete them
node no-fc-tracker.js move-to-history <row>        Move a specific row to History
node no-fc-tracker.js sort                         Sort Data sheet by star rating
node no-fc-tracker.js backfill <since> <until>     Add ranked maps in date range (YYYY-MM-DD)
```

## Setup

### Requirements
- Node.js
- [danser-go](https://github.com/Wieku/danser-go) binary in `danser/`
- Google Sheets API credentials (`credentials.json`)
- `.env` file with `SPREADSHEET_ID` and `OSU_API_KEY`

### Google Sheets API
1. Create a project in [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the Google Sheets API
3. Create OAuth 2.0 credentials and download as `credentials.json`
4. Run any command — you'll be prompted to authorize on first run
