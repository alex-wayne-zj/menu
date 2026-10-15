#!/usr/bin/env python3
"""Import a local illustrated menu for one account, without touching other users.

Run a consistent project backup before --apply. Existing image files and history
are retained, so copied dishes and record snapshots remain usable.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import pwd
import sqlite3
import time


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--config', type=Path, default=Path('/etc/menu/config.json'))
    parser.add_argument('--username', required=True)
    parser.add_argument('--manifest', type=Path, required=True)
    parser.add_argument('--replace', action='store_true', help='Replace only this account’s dishes')
    parser.add_argument('--apply', action='store_true', help='Default is a read-only preview')
    args = parser.parse_args()
    config = json.loads(args.config.read_text())
    dishes = json.loads(args.manifest.read_text())
    if not isinstance(dishes, list) or not dishes:
        raise ValueError('Manifest must be a nonempty list')
    prepared = []
    for dish in dishes:
        for key, limit in [('name', 40), ('category', 20), ('ingredients', 5000), ('notes', 2000)]:
            value = dish[key]
            if not isinstance(value, str) or not value.strip() or len(value) > limit:
                raise ValueError(f'Invalid {key}')
        if dish['kind'] not in ('meat', 'vegetable', 'other'):
            raise ValueError('Invalid dish kind')
        source = args.manifest.parent / (dish['slug'] + '.webp')
        if source.resolve().parent != args.manifest.parent.resolve():
            raise ValueError('Image must be next to manifest')
        image = source.read_bytes()
        if not (0 < len(image) < 100_000):
            raise ValueError(f'{source.name} must be below 100 KB')
        if image[:4] != b'RIFF' or image[8:12] != b'WEBP':
            raise ValueError(f'{source.name} is not WebP')
        filename = hashlib.sha256(image).hexdigest() + '.webp'
        prepared.append((dish, image, filename, '/menu/api/images/' + filename))
    if len({d['name'] for d in dishes}) != len(dishes):
        raise ValueError('Duplicate dish names')
    with sqlite3.connect('file:' + config['database'] + '?mode=ro', uri=True) as db:
        owner = db.execute('SELECT id FROM users WHERE username=?', (args.username,)).fetchone()
        if owner is None:
            raise ValueError('Account does not exist')
        uid = owner[0]
        existing = db.execute('SELECT count(*) FROM dishes WHERE owner_id=?', (uid,)).fetchone()[0]
    print(f'{len(prepared)} dishes validated; existing: {existing}; replace: {args.replace}')
    if not args.apply:
        print('Preview only; no changes written')
        return
    account = pwd.getpwnam('menu')
    directory = Path(config['images'])
    for _, image, filename, _ in prepared:
        destination = directory / filename
        try:
            fd = os.open(destination, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError:
            if destination.read_bytes() != image:
                raise ValueError('Existing image content does not match filename')
        else:
            with os.fdopen(fd, 'wb') as stream:
                stream.write(image)
            os.chown(destination, account.pw_uid, account.pw_gid)
    with sqlite3.connect(config['database'], timeout=10) as db:
        db.execute('PRAGMA foreign_keys=ON')
        db.execute('BEGIN IMMEDIATE')
        if args.replace:
            db.execute('DELETE FROM dishes WHERE owner_id=?', (uid,))
        for dish, _, _, url in prepared:
            if db.execute('SELECT 1 FROM dishes WHERE owner_id=? AND name=? AND image_url=?',
                          (uid, dish['name'], url)).fetchone():
                continue
            db.execute('INSERT OR IGNORE INTO images(url,owner_id,created) VALUES(?,?,?)',
                       (url, uid, int(time.time())))
            db.execute('INSERT INTO dishes(owner_id,name,category,kind,image_url,ingredients,notes,is_example) '
                       'VALUES(?,?,?,?,?,?,?,?)',
                       (uid, dish['name'], dish['category'], dish['kind'], url,
                        dish['ingredients'], dish['notes'], True))
    print('Import committed; other accounts and history retained')


if __name__ == '__main__':
    main()
