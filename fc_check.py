#!/usr/bin/env python3
"""Verify whether an osu! play is a true FC by simulating it in danser.

A play is an FC iff combo never broke. We detect this by running danser's
knockout2 mode and checking if final current-combo equals max-combo.

Usage: fc_check.py <beatmap_id> <user_id> <mods>
Reads OSU_API_KEY from env. Outputs JSON to stdout.
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

REPO_DIR = Path(__file__).resolve().parent
DANSER_DIR = REPO_DIR / 'danser'
SONGS_DIR = DANSER_DIR / 'songs' / 'maps'
REPLAYS_DIR = DANSER_DIR / 'replays-tmp'


def main():
    if len(sys.argv) < 4:
        print(json.dumps({"error": "usage: fc_check.py <beatmap_id> <user_id> <mods>"}))
        sys.exit(1)

    beatmap_id = int(sys.argv[1])
    user_id = int(sys.argv[2])
    mods = int(sys.argv[3])

    api_key = os.environ.get("OSU_API_KEY")
    if not api_key:
        print(json.dumps({"error": "OSU_API_KEY not set"}))
        sys.exit(1)

    SONGS_DIR.mkdir(parents=True, exist_ok=True)
    REPLAYS_DIR.mkdir(parents=True, exist_ok=True)

    # 1. Ensure beatmap is downloaded
    beatmap_path = SONGS_DIR / f'{beatmap_id}.osu'
    if not beatmap_path.exists():
        try:
            urllib.request.urlretrieve(f'https://osu.ppy.sh/osu/{beatmap_id}', beatmap_path)
        except Exception as e:
            print(json.dumps({"error": f"beatmap download failed: {e}"}))
            sys.exit(1)

    beatmap_md5 = hashlib.md5(beatmap_path.read_bytes()).hexdigest()

    # 2. Build full .osr file from circleguard's loaded replay
    replay_path = REPLAYS_DIR / f'{beatmap_id}_{user_id}_{mods}.osr'
    if not replay_path.exists():
        try:
            from circleguard import Circleguard, ReplayMap, Mod
            from osrparse import Replay as OsrReplay, GameMode, Mod as OsrMod

            cg = Circleguard(api_key)
            r = ReplayMap(beatmap_id, user_id, mods=Mod(mods))
            cg.load(r)

            osr = OsrReplay(
                mode=GameMode.STD,
                game_version=int(r.game_version) if r.game_version else 20241212,
                beatmap_hash=beatmap_md5,
                username=r.username or '',
                replay_hash=r.replay_hash or '',
                count_300=int(r.count_300),
                count_100=int(r.count_100),
                count_50=int(r.count_50),
                count_geki=int(r.count_geki),
                count_katu=int(r.count_katu),
                count_miss=int(r.count_miss),
                score=int(r.score),
                max_combo=int(r.max_combo),
                perfect=bool(r.is_perfect_combo),
                mods=OsrMod(int(mods)),
                life_bar_graph=r.life_bar_graph or [],
                timestamp=r.timestamp,
                replay_data=r.replay_data,
                replay_id=int(r.replay_id) if r.replay_id else 0,
                rng_seed=r.rng_seed,
            )
            osr.write_path(str(replay_path))
        except Exception as e:
            print(json.dumps({"error": f"replay build failed: {type(e).__name__}: {e}"}))
            sys.exit(1)

    # 3. Run danser headlessly to simulate
    try:
        env = {**os.environ, 'DISPLAY': os.environ.get('DISPLAY', ':0')}
        proc = subprocess.run(
            [
                str(DANSER_DIR / 'danser-cli'),
                '-id', str(beatmap_id),
                '-knockout2', json.dumps([str(replay_path)]),
                '-record',
                '-out', '/tmp/_fc_check.mp4',
                '-skip',
            ],
            cwd=str(DANSER_DIR),
            capture_output=True,
            text=True,
            env=env,
            timeout=300,
        )
    except subprocess.TimeoutExpired:
        print(json.dumps({"error": "danser timeout"}))
        sys.exit(1)

    # 4. Parse final summary table for combo / max_combo
    pattern = re.compile(
        r'\|\s*1\s*\|.*?\|\s*[\d,]+\s*\|\s*[\d.]+\s*\|\s*\w+\s*\|'
        r'\s*[\d,]+\s*\|\s*[\d,]+\s*\|\s*[\d,]+\s*\|\s*[\d,]+\s*\|'
        r'\s*([\d,]+)\s*\|\s*([\d,]+)\s*\|'
    )
    for line in proc.stdout.split('\n'):
        m = pattern.search(line)
        if m:
            current_combo = int(m.group(1).replace(',', ''))
            max_combo = int(m.group(2).replace(',', ''))
            print(json.dumps({
                "is_fc": current_combo == max_combo,
                "current_combo": current_combo,
                "max_combo": max_combo,
            }))
            return

    print(json.dumps({"error": "could not parse danser output", "stdout_tail": proc.stdout[-500:]}))
    sys.exit(1)


if __name__ == '__main__':
    main()
