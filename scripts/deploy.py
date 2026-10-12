#!/usr/bin/env python3
"""Deploy only this project's files, with data backup and automatic binary rollback."""
import argparse
import datetime
import json
import os
from pathlib import Path
import pwd
import shutil
import sqlite3
import subprocess
import tarfile
import time
import urllib.request

PROJECT = Path(__file__).resolve().parents[1]
ROOT = Path('/opt/menu')
DATA = Path('/var/lib/menu')
CONFIG = Path('/etc/menu')
WEB = Path('/var/www/menu')


def run(*args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def link(target, path):
    temporary = path.with_name(path.name + '.next')
    temporary.unlink(missing_ok=True)
    temporary.symlink_to(target)
    temporary.replace(path)


def healthy():
    for _ in range(20):
        try:
            with urllib.request.urlopen('http://127.0.0.1:8079/api/health', timeout=2) as response:
                if json.load(response).get('ok') is True:
                    return
        except (OSError, ValueError):
            pass
        time.sleep(.5)
    raise RuntimeError('menu API health check failed')


def backup():
    if not (DATA / 'menu.sqlite').exists():
        return
    directory = DATA / 'backups'
    directory.mkdir(mode=0o700, exist_ok=True)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    snapshot = directory / f'{stamp}.sqlite'
    with sqlite3.connect(DATA / 'menu.sqlite') as source, sqlite3.connect(snapshot) as target:
        source.backup(target)
    with tarfile.open(directory / f'{stamp}.tar.gz', 'w:gz') as archive:
        archive.add(snapshot, arcname='menu.sqlite')
        if (DATA / 'images').exists():
            archive.add(DATA / 'images', arcname='images')
    snapshot.unlink()
    for obsolete in sorted(directory.glob('*.tar.gz'))[:-5]:
        obsolete.unlink()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--skip-build', action='store_true')
    parser.add_argument('--rollback', action='store_true')
    parser.add_argument('--backup', action='store_true')
    args = parser.parse_args()
    if os.geteuid() != 0:
        raise SystemExit('Deployment requires root for project systemd/Nginx files')
    if args.backup:
        run('systemctl', 'stop', 'menu')
        try:
            backup()
        finally:
            run('systemctl', 'start', 'menu')
        healthy()
        print('Consistent database and image backup saved; service healthy')
        return
    if args.rollback:
        previous = ROOT / 'previous'
        if not previous.exists():
            raise SystemExit('No previous compatible release')
        current = (ROOT / 'current').resolve()
        target = previous.resolve()
        link(target, ROOT / 'current')
        link(target / 'frontend', WEB / 'current')
        run('systemctl', 'restart', 'menu')
        try:
            healthy()
        except Exception:
            link(current, ROOT / 'current')
            link(current / 'frontend', WEB / 'current')
            run('systemctl', 'restart', 'menu')
            raise
        link(current, previous)
        print('Rolled back; current database retained; API healthy')
        return
    if not args.skip_build:
        env = dict(os.environ, CARGO_BUILD_JOBS='1')
        run('/root/.cargo/bin/cargo', 'build', '--release', '--locked', '-j', '1', cwd=PROJECT / 'backend', env=env)
        run('npm', 'ci', cwd=PROJECT / 'frontend')
        run('npm', 'run', 'build', cwd=PROJECT / 'frontend')
    try:
        account = pwd.getpwnam('menu')
    except KeyError:
        run('useradd', '--system', '--home-dir', str(DATA), '--shell', '/usr/sbin/nologin', 'menu')
        account = pwd.getpwnam('menu')
    for path in (ROOT / 'releases', DATA, CONFIG, WEB):
        path.mkdir(parents=True, exist_ok=True)
    os.chmod(DATA, 0o700)
    os.chown(DATA, account.pw_uid, account.pw_gid)
    os.chmod(CONFIG, 0o750)
    os.chown(CONFIG, 0, account.pw_gid)
    if not (CONFIG / 'config.json').exists():
        raise SystemExit('Create /etc/menu/config.json first; see README')
    if not (ROOT / 'venv/bin/python').exists():
        run('python3', '-m', 'venv', str(ROOT / 'venv'))
        run(str(ROOT / 'venv/bin/pip'), 'install', 'Pillow==11.3.0')
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S%fZ')
    release = ROOT / 'releases' / stamp
    release.mkdir()
    shutil.copy2(PROJECT / 'backend/target/release/menu-backend', release / 'menu-api')
    shutil.copy2(PROJECT / 'backend/image_process.py', release / 'image_process.py')
    shutil.copytree(PROJECT / 'frontend/dist', release / 'frontend')
    for path in release.rglob('*'):
        os.chmod(path, 0o755 if path.is_dir() or path.name == 'menu-api' else 0o644)
    os.chmod(release, 0o755)
    old = (ROOT / 'current').resolve() if (ROOT / 'current').exists() else None
    touched = [Path('/etc/nginx/snippets/menu.conf'), Path('/etc/nginx/snippets/menu-proxy.conf'),
               Path('/etc/nginx/conf.d/menu-limits.conf'), Path('/etc/nginx/sites-available/default'),
               Path('/etc/systemd/system/menu.service'), CONFIG / 'menu.env']
    saved_files = {}
    for path in touched:
        if path.exists():
            stat = path.stat()
            saved_files[path] = (path.read_bytes(), stat.st_mode & 0o777, stat.st_uid, stat.st_gid)
        else:
            saved_files[path] = None
    # Stop writes while backing up database and corresponding files.
    if old:
        run('systemctl', 'stop', 'menu')
    try:
        backup()
        link(release, ROOT / 'current')
        link(release / 'frontend', WEB / 'current')
        for name in ('menu.conf', 'menu-proxy.conf'):
            shutil.copy2(PROJECT / 'deploy' / name, Path('/etc/nginx/snippets') / name)
        shutil.copy2(PROJECT / 'deploy/menu-limits.conf', '/etc/nginx/conf.d/menu-limits.conf')
        site = Path('/etc/nginx/sites-available/default')
        text = site.read_text()
        marker = 'include /etc/nginx/snippets/travel.conf;'
        include = 'include /etc/nginx/snippets/menu.conf;'
        if include not in text:
            if text.count(marker) != 2:
                raise RuntimeError('Expected existing two HTTPS hosts; refusing to guess Nginx placement')
            saved = CONFIG / 'nginx-default.before-menu'
            if not saved.exists():
                shutil.copy2(site, saved)
            site.write_text(text.replace(marker, marker + '\n        ' + include))
        run('nginx', '-t')
        shutil.copy2(PROJECT / 'deploy/menu.service', '/etc/systemd/system/menu.service')
        (CONFIG / 'menu.env').write_text('MENU_CONFIG=/etc/menu/config.json\n')
        os.chmod(CONFIG / 'menu.env', 0o640)
        os.chown(CONFIG / 'menu.env', 0, account.pw_gid)
        run('systemctl', 'daemon-reload')
        run('systemctl', 'enable', '--now', 'menu')
        healthy()
        run('systemctl', 'reload', 'nginx')
    except Exception:
        if not old:
            subprocess.run(['systemctl', 'disable', '--now', 'menu'], check=False)
        for path, saved in saved_files.items():
            if saved is None:
                path.unlink(missing_ok=True)
            else:
                payload, mode, uid, gid = saved
                path.write_bytes(payload)
                os.chmod(path, mode)
                os.chown(path, uid, gid)
        run('systemctl', 'daemon-reload')
        if old:
            link(old, ROOT / 'current')
            link(old / 'frontend', WEB / 'current')
            run('systemctl', 'restart', 'menu')
        else:
            (ROOT / 'current').unlink(missing_ok=True)
            (WEB / 'current').unlink(missing_ok=True)
        run('nginx', '-t')
        run('systemctl', 'reload', 'nginx')
        raise
    if old:
        link(old, ROOT / 'previous')
    retained = {release, old}
    if (ROOT / 'previous').exists():
        retained.add((ROOT / 'previous').resolve())
    candidates = sorted((ROOT / 'releases').iterdir())
    retained.update(candidates[-3:])
    for path in candidates:
        if path not in retained and path.is_dir():
            shutil.rmtree(path)
    print('Deployed https://zhangjian.dev/menu/; local API healthy')


if __name__ == '__main__':
    main()
