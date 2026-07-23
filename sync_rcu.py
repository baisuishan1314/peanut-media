#!/usr/bin/env python3
"""RCU 数据同步脚本 — 供 GitHub Actions 定时调用
从 RCU 官网拉取数据，计算 PT，更新 data.json 和 index.html 内联 fallback。
不包含 GitHub API 上传逻辑 — Actions runner 直接 git commit。
"""
import urllib.request, json, os, sys, re, time

RCU_BASE = 'http://rcu-league.com/data'
RP = 30000
RK = [50, 10, -10, -30]
BASE_DIR = os.path.dirname(os.path.abspath(__file__))


def fetch_json(url):
    try:
        req = urllib.request.Request(url, headers={'User-Agent': 'PeanutMedia/2.0'})
        resp = urllib.request.urlopen(req, timeout=15)
        return json.loads(resp.read().decode('utf-8'))
    except Exception as e:
        print(f'  [RCU] Fetch failed: {url} -> {e}')
        return None


def calc_pt(score, rank):
    return round(((score - RP) / 1000 + RK[rank]) * 10) / 10


def compute_rcu_data():
    """Fetch RCU data and compute team stats. Returns dict or None."""
    print('  [RCU] Fetching live data...')
    results = fetch_json(f'{RCU_BASE}/results.json')
    players = fetch_json(f'{RCU_BASE}/players.json')
    teams = fetch_json(f'{RCU_BASE}/teams.json')
    schedule = fetch_json(f'{RCU_BASE}/schedule.json')
    if not all([results, players, teams, schedule]):
        print('  [RCU] Incomplete data, aborting')
        return None

    team_names = {}
    for t in teams.get('teams', []):
        team_names[t['id']] = t.get('name', f'Team {t["id"]}')

    t4_players = {}
    for team in players.get('teams', []):
        if team.get('team_id') == 4:
            for p in team.get('players', []):
                t4_players[p['player_id']] = {
                    'name': p.get('name', ''),
                    'bio': p.get('bio', ''),
                    'photo': p.get('photo', '')
                }

    ps = {}
    for pid in t4_players:
        ps[pid] = {'games': 0, 'totalPt': 0, 'wins': 0, 's2': 0, 's3': 0, 's4': 0}

    all_results = []
    team_total_pt = 0

    completed = [r for r in results.get('results', [])
                 if r.get('first_half', {}).get('east', {}).get('score') is not None]

    for r in completed:
        for hk in ['first_half', 'second_half']:
            half = r.get(hk)
            if not half:
                continue
            entries = []
            for pos in ['east', 'south', 'west', 'north']:
                t = half.get(pos, {})
                if t.get('score') is not None:
                    entries.append({
                        'team_id': t.get('team_id'),
                        'score': t['score'],
                        'player_id': t.get('player_id', '')
                    })
            entries.sort(key=lambda x: x['score'], reverse=True)

            for rank, e in enumerate(entries):
                if e['team_id'] == 4:
                    pid = e['player_id']
                    pt = calc_pt(e['score'], rank)
                    team_total_pt += pt
                    if pid and pid in ps:
                        ps[pid]['games'] += 1
                        ps[pid]['totalPt'] += pt
                        if rank == 0:
                            ps[pid]['wins'] += 1
                        elif rank == 1:
                            ps[pid]['s2'] += 1
                        elif rank == 2:
                            ps[pid]['s3'] += 1
                        else:
                            ps[pid]['s4'] += 1
                    pn = t4_players.get(pid, {}).get('name', f'Player {pid}')
                    round_num = re.sub(r'\D', '', str(r.get('round', '')))
                    all_results.append({
                        'date': r.get('date', ''),
                        'round': f"\u7b2c{round_num}\u8f6e" if round_num else f"\u7b2c{r['round']}\u8f6e",
                        'half': 'H1' if hk == 'first_half' else 'H2',
                        'player': pn, 'playerId': pid,
                        'score': e['score'], 'rank': rank + 1, 'pt': pt
                    })
                    break

    all_results.sort(key=lambda x: (int(re.sub(r'\D', '', x['round'])), x['half']))

    plist = []
    for pid, info in t4_players.items():
        s = ps[pid]
        plist.append({
            'id': pid, 'name': info['name'], 'bio': info['bio'],
            'photo': f"images/players/{pid}.jpg",
            'games': s['games'], 'totalPt': round(s['totalPt'] * 10) / 10,
            'wins': s['wins'], 's2': s['s2'], 's3': s['s3'], 's4': s['s4']
        })
    plist.sort(key=lambda x: x['totalPt'], reverse=True)

    done_rounds = {int(re.sub(r'\D', '', str(r.get('round', '')))) for r in completed}

    upcoming = []
    for s in schedule.get('schedule', []):
        sr = s.get('round', '')
        sn = int(re.sub(r'\D', '', str(sr))) if sr else 0
        if sn in done_rounds:
            continue

        involved = False
        opponents = []
        for t in s.get('teams', []) or []:
            if t.get('team_id') == 4:
                involved = True
            else:
                opponents.append(team_names.get(t['team_id'], f'Team {t["team_id"]}'))
        if 'second_match' in s:
            for t in s['second_match'].get('teams', []) or []:
                if t.get('team_id') == 4:
                    involved = True
                else:
                    opponents.append(team_names.get(t['team_id'], f'Team {t["team_id"]}'))
        if not involved:
            continue

        seen = {}
        uops = []
        for o in opponents:
            if o not in seen:
                seen[o] = 1
                uops.append(o)

        dd = s.get('date_display') or s.get('date', '')
        now = time.strftime('%Y-%m-%d')
        is_today = s.get('date', '') == now

        upcoming.append({
            'round': str(sr) if sr else f'\u7b2c{sn}\u8f6e',
            'date': dd, 'time': s.get('time', '19:00'),
            'weekday': s.get('weekday', ''), 'today': is_today,
            'opponents': uops
        })

    total_games = sum(p['games'] for p in plist)
    total_wins = sum(p['wins'] for p in plist)
    bp = plist[0] if plist else None

    print(f'  [RCU] OK: {len(completed)} rounds, {total_games} games, PT={team_total_pt:.1f} ({len(upcoming)} upcoming)')

    return {
        'lastUpdated': time.strftime('%Y-%m-%d %H:%M', time.localtime()),
        'teamTotalPt': round(team_total_pt * 10) / 10,
        'players': plist, 'results': all_results, 'upcoming': upcoming,
        'stats': {
            'totalGames': total_games, 'totalWins': total_wins,
            'completedRounds': len(completed),
            'bestPlayer': bp, 'playerCount': len(plist)
        }
    }


def update_inline_fallback(html, data_json_str):
    """Replace content inside <script type="application/json" id="fallback-data"> tag."""
    marker_start = '<script type="application/json" id="fallback-data">'
    marker_end = '</script>'
    pos_start = html.find(marker_start)
    if pos_start < 0:
        raise ValueError('fallback-data script tag not found in index.html')
    pos_content_start = pos_start + len(marker_start)
    pos_end = html.find(marker_end, pos_content_start)
    if pos_end < 0:
        raise ValueError('fallback-data script closing tag not found')
    return html[:pos_content_start] + '\n' + data_json_str + '\n' + html[pos_end:]


def main():
    print('[Sync] Starting RCU data sync...')

    # Fetch fresh RCU data
    fresh_data = compute_rcu_data()
    if not fresh_data:
        print('[Sync] RCU unavailable, keeping existing data')
        sys.exit(1)

    data_json_str = json.dumps(fresh_data, ensure_ascii=False, separators=(',', ':'))

    # Write data.json
    data_path = os.path.join(BASE_DIR, 'data.json')
    with open(data_path, 'w', encoding='utf-8') as f:
        f.write(data_json_str)
    print(f'  [WRITE] data.json ({len(data_json_str)} chars)')

    # Update index.html inline fallback + version
    html_path = os.path.join(BASE_DIR, 'index.html')
    with open(html_path, 'r', encoding='utf-8-sig') as f:
        html = f.read()

    version = time.strftime('%Y%m%d%H%M%S')
    html = re.sub(r'<meta name="app-version" content="[^"]*"',
                  f'<meta name="app-version" content="{version}"', html)
    html = update_inline_fallback(html, data_json_str)

    with open(html_path, 'w', encoding='utf-8') as f:
        f.write(html)
    print(f'  [WRITE] index.html (version={version})')

    print(f'[Sync] Done: PT={fresh_data["teamTotalPt"]}, '
          f'{len(fresh_data["players"])} players, '
          f'{len(fresh_data["results"])} results, '
          f'{len(fresh_data["upcoming"])} upcoming')


if __name__ == '__main__':
    main()
