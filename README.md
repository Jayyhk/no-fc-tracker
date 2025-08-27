# osu! No FC Tracker

This is a Google Apps Script that tracks osu!standard beatmaps without Full Combo (FC) scores. It automatically fetches beatmap data and manages a database of unFC'd maps.

> [!NOTE] > **osu!stable only** - this does not track lazer scores.

> [!TIP] > **Allowed mods:** NM, NF, HD, HR, SD, DT, NC, FL, PF

> [!CAUTION] > **Forbidden mods:** EZ, HT, TD, SO

## Features

- Daily auto-refresh of beatmap data
- Automatic detection and cleanup of new FCs
- Bulk processing with rate limiting
