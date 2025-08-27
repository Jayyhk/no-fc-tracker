# osu!standard No FC Tracker

This is a Google Apps Script that tracks all osu!standard beatmaps without a Full Combo (FC). It automatically fetches beatmap data and manages a database of unFC'd maps. The public sheet that displays the results can be found [here](https://docs.google.com/spreadsheets/d/1zaTkQJug5aPn-39Zk6vjhZsRs-cF8dPgfixILvXV6xs/edit?usp=sharing).

> [!NOTE]
> **osu!stable only** - this does not track osu!lazer scores.
>
> **Allowed mods:** NM, NF, HD, HR, SD, DT, NC, FL, PF
>
> **Forbidden mods:** EZ, HT, TD, SO

> [!CAUTION]
> Scores that do not obtain a combo `>= max_combo - 1` will not be removed, as a sliderbreak may have occurred. Even though these scores may be FCs, we assume the worst case scenario to prevent false positives. These scores must be manually reviewed and/or removed.
