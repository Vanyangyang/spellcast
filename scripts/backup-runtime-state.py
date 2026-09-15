import hashlib
import json
import pathlib
import sqlite3
import sys
import time
from datetime import datetime, timezone

requested_source = pathlib.Path(sys.argv[1]).absolute()
source = requested_source.resolve(strict=True)
assert str(source).casefold() == str(requested_source).casefold(), f'Source was redirected: {requested_source} -> {source}'
directory = pathlib.Path(sys.argv[2]).resolve()
directory.mkdir(parents=True, exist_ok=False)
destination = directory / 'spellcast.sqlite3'
with sqlite3.connect(source.as_uri() + '?mode=ro', uri=True) as original:
    with sqlite3.connect(destination) as snapshot:
        started = time.monotonic()
        def progress(status, remaining, total):
            if time.monotonic() - started > 10:
                raise TimeoutError('Database backup is blocked; close the owning app normally first.')
        original.backup(snapshot, pages=128, progress=progress, sleep=0.1)
        integrity = snapshot.execute('PRAGMA quick_check').fetchone()[0]
        assert integrity == 'ok', integrity
report = {
    'source': str(source), 'snapshot': str(destination),
    'createdAt': datetime.now(timezone.utc).isoformat(),
    'quickCheck': integrity,
    'sourceSha256': hashlib.sha256(source.read_bytes()).hexdigest(),
    'snapshotSha256': hashlib.sha256(destination.read_bytes()).hexdigest(),
    'method': 'SQLite online backup from a read-only source connection',
}
(directory / 'backup.json').write_text(json.dumps(report, indent=2), encoding='utf-8')
print(json.dumps(report))
