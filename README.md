# osu!standard No FC Tracker

This is a Google Apps Script that tracks all osu!standard beatmaps without a Full Combo (FC). It automatically fetches beatmap data and manages a database of unFC'd maps.

> [!NOTE]
> **osu!stable only** - this does not track osu!lazer scores
>
> **Allowed mods:** NM, NF, HD, HR, SD, DT, NC, FL, PF
>
> **Forbidden mods:** EZ, HT, TD, SO

## Features

- Daily auto-refresh of beatmap data
- Automatic detection and cleanup of new FCs
- Bulk processing with rate limiting
