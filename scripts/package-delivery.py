"""Build a local review/deployment package from explicit public-code allowlists."""
from pathlib import Path
import hashlib
import json
import os
import zipfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'outputs' / 'PersonalMediaAssistant-sites-0.7.1.zip'
DENY = {'.git', 'node_modules', '.local', '.wrangler', '.sites-runtime', '.vinext', '.next', 'outputs', 'dist', 'bin', 'obj', '__pycache__', 'evidence'}
def allowed(path):
    relative = path.relative_to(ROOT)
    return not any(part in DENY for part in relative.parts) and not path.name.startswith(('.env', '.dev.vars')) and not path.name.endswith(('.tsbuildinfo', '.pdb', '.dpapi', '.sqlite', '.litedb', '.db', '.log')) and not path.is_symlink()

files = []
for name in ['README.md', 'LICENSE', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', '.gitignore', '.env.example', 'package.json', 'package-lock.json', 'tsconfig.json']:
    files.append(ROOT / name)
for name in ['docs', 'src', 'test', 'vendor', 'collectors', 'scripts', 'apps/mcp-gateway']:
    for directory, children, names in os.walk(ROOT / name, followlinks=False):
        children[:] = [child for child in children if child not in DENY and not (Path(directory) / child).is_symlink()]
        files.extend(path for item in names if (path := Path(directory) / item).is_file() and allowed(path))
OUTPUT.parent.mkdir(parents=True, exist_ok=True)
manifest = []
temporary = OUTPUT.with_suffix('.zip.tmp')
with zipfile.ZipFile(temporary, 'w', zipfile.ZIP_DEFLATED, strict_timestamps=False) as archive:
    for path in sorted(set(files)):
        name = 'PersonalMediaAssistant/' + path.relative_to(ROOT).as_posix()
        archive.write(path, name)
        manifest.append({'file': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    for binary_dir in ['dandanplay-collector', 'platform-login', 'bilibili-collector']:
        for path in (ROOT / 'outputs' / binary_dir).glob('*'):
            if path.is_file() and path.suffix in {'.dll', '.exe', '.json', '.mjs'}:
                name = 'PersonalMediaAssistant/outputs/' + binary_dir + '/' + path.name
                archive.write(path, name)
                manifest.append({'file': name, 'sha256': hashlib.sha256(path.read_bytes()).hexdigest()})
    archive.writestr('MANIFEST.json', json.dumps({'schema_version':'1.0','credentials_included':False,'private_records_included':False,'files':manifest}, ensure_ascii=False, indent=2))
temporary.replace(OUTPUT)
digest = hashlib.sha256(OUTPUT.read_bytes()).hexdigest()
OUTPUT.with_suffix('.zip.sha256').write_text(digest + '  ' + OUTPUT.name + '\n', encoding='utf-8')
print(json.dumps({'archive':str(OUTPUT),'files':len(manifest),'bytes':OUTPUT.stat().st_size,'sha256':digest,'credentials_included':False,'private_records_included':False}))
