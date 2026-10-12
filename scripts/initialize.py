#!/usr/bin/env python3
"""One-time setup. Secrets are written only to root-readable files, never stdout."""
import hashlib
import json
import os
from pathlib import Path
import pwd
import secrets
import shutil
import sqlite3
import subprocess
import time

PROJECT = Path(__file__).resolve().parents[1]
CONFIG = Path('/etc/menu')
DATA = Path('/var/lib/menu')


def main():
    if os.geteuid() != 0:
        raise SystemExit('Run as root')
    try:
        account = pwd.getpwnam('menu')
    except KeyError:
        subprocess.run(['useradd', '--system', '--home-dir', str(DATA), '--shell', '/usr/sbin/nologin', 'menu'], check=True)
        account = pwd.getpwnam('menu')
    CONFIG.mkdir(exist_ok=True)
    os.chmod(CONFIG, 0o750)
    os.chown(CONFIG, 0, account.pw_gid)
    DATA.mkdir(exist_ok=True)
    os.chmod(DATA, 0o700)
    os.chown(DATA, account.pw_uid, account.pw_gid)
    path = CONFIG / 'config.json'
    if not path.exists():
        username = os.environ.get('MENU_ADMIN_USERNAME', 'admin')
        friend = os.environ.get('MENU_FRIEND_USERNAME', 'friend')
        code = secrets.token_urlsafe(24)
        password = secrets.token_urlsafe(24)
        config = {'database': str(DATA / 'menu.sqlite'), 'images': str(DATA / 'images'),
                  'origin': 'https://zhangjian.dev', 'bind': '127.0.0.1:8079',
                  'image_python': '/opt/menu/venv/bin/python',
                  'image_processor': '/opt/menu/current/image_process.py',
                  'invitations': [{'username': friend, 'code': code}]}
        # Files created with restrictive permissions before any content is written.
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o640)
        with os.fdopen(fd, 'w') as out:
            json.dump(config, out, ensure_ascii=False, indent=2)
        os.chown(path, 0, account.pw_gid)
        credentials = CONFIG / 'bootstrap-credentials.json'
        fd = os.open(credentials, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        with os.fdopen(fd, 'w') as out:
            json.dump({'url': 'https://zhangjian.dev/menu/', 'username': username,
                       'password': password, 'friend_username': friend, 'friend_invite_code': code}, out, indent=2)
    else:
        config = json.loads(path.read_text())
        credentials = CONFIG / 'bootstrap-credentials.json'
        if not credentials.exists():
            raise SystemExit('Configuration exists without bootstrap file. Provision administrator manually; refusing to overwrite.')
        bootstrap = json.loads(credentials.read_text())
        username = bootstrap['username']
        password = bootstrap['password']
    exists = False
    if Path(config['database']).exists():
        with sqlite3.connect(config['database']) as db:
            exists = db.execute('SELECT EXISTS(SELECT 1 FROM users WHERE username=?)', (username,)).fetchone()[0]
    if not exists:
        binary = Path('/opt/menu/bootstrap/menu-api')
        binary.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(PROJECT / 'backend/target/release/menu-backend', binary)
        binary.chmod(0o755)
        subprocess.run(['runuser', '-u', 'menu', '--', str(binary), 'bootstrap'], check=True,
                       env=dict(os.environ, MENU_CONFIG=str(path), MENU_ADMIN_PASSWORD=password, MENU_ADMIN_USERNAME=username))
    image_directory = Path(config['images'])
    image_directory.mkdir(exist_ok=True)
    marker = DATA / 'examples.seeded'
    if not marker.exists():
        examples = [
            ('tomato-eggs', '番茄炒蛋', '家常菜', 'vegetable', '鸡蛋 3 个、番茄 2 个、葱花少许、盐适量、食用油适量。', '番茄先炒软出汁，再加入炒好的鸡蛋。'),
            ('braised-chicken', '土豆烧鸡', '肉菜', 'meat', '鸡腿肉 300 g、土豆 2 个、青椒 1 个、姜片、生抽、老抽、盐适量。', '土豆切块，和鸡肉一起焖至熟透。'),
            ('pork-pepper', '青椒肉丝', '肉菜', 'meat', '猪肉 200 g、青椒 3 个、蒜 2 瓣、生抽、淀粉、盐适量。', '肉丝先腌制，快炒保持嫩滑。'),
            ('garlic-broccoli', '蒜蓉西兰花', '蔬菜', 'vegetable', '西兰花 1 颗、蒜 4 瓣、盐、食用油适量。', '洗净焯水，蒜末炒香后翻炒。'),
            ('wintermelon-soup', '冬瓜清汤', '汤羹', 'vegetable', '冬瓜 300 g、清水 600 ml、葱花、盐、香油适量。', '清爽素汤，可按口味调整。'),
            ('egg-fried-rice', '蛋炒饭', '主食', 'other', '米饭 1 碗、鸡蛋 2 个、胡萝卜少许、葱花、盐、食用油适量。', '米饭充分打散后翻炒。'),
        ]
        with sqlite3.connect(config['database']) as db:
            uid = db.execute('SELECT id FROM users WHERE username=?', (username,)).fetchone()[0]
            for slug, name, category, kind, ingredients, notes in examples:
                source = PROJECT / 'assets/examples' / f'{slug}.webp'
                filename = hashlib.sha256(source.read_bytes()).hexdigest() + '.webp'
                dest = image_directory / filename
                shutil.copy2(source, dest)
                os.chown(dest, account.pw_uid, account.pw_gid)
                dest.chmod(0o600)
                url = '/menu/api/images/' + filename
                db.execute('INSERT OR IGNORE INTO images(url,owner_id,created) VALUES(?,?,?)', (url, uid, int(time.time())))
                if not db.execute('SELECT id FROM dishes WHERE owner_id=? AND image_url=?', (uid,url)).fetchone():
                    db.execute('INSERT INTO dishes(owner_id,name,category,kind,image_url,ingredients,notes,is_example) VALUES(?,?,?,?,?,?,?,1)',
                               (uid, name, category, kind, url, ingredients, notes))
        marker.touch(mode=0o600)
        os.chown(marker, account.pw_uid, account.pw_gid)
    for item in DATA.iterdir():
        if item.is_file() or item.is_dir() and item.name == 'images':
            os.chown(item, account.pw_uid, account.pw_gid)
    print('Initialized administrator, friend invitation and six example dishes. Credentials: /etc/menu/bootstrap-credentials.json (root only).')


if __name__ == '__main__':
    main()
