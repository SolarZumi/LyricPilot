#!/usr/bin/env python3
"""Create a portable, unpacked Chrome extension bundle using only stdlib."""
import json
import subprocess
from pathlib import Path
from zipfile import ZipFile, ZIP_DEFLATED

root = Path(__file__).resolve().parents[1]
subprocess.run(['node', 'scripts/check.cjs'], cwd=root, check=True)
version = json.loads((root / 'extension' / 'manifest.json').read_text())['version']
target = root / 'dist' / f'LyricPilot-Chrome-{version}.zip'
target.parent.mkdir(exist_ok=True)
with ZipFile(target, 'w', ZIP_DEFLATED) as out:
    for folder in ['extension', 'examples']:
        for file in sorted((root / folder).rglob('*')):
            if file.is_file() and file.name != '.DS_Store':
                out.write(file, Path('LyricPilot') / file.relative_to(root))
    out.write(root / 'README.md', 'LyricPilot/README.md')
print(target)
