"""Bind a clean public template to a user-owned Sites project; never accepts secrets."""
import argparse,json,re
from pathlib import Path
from urllib.parse import urlsplit

def configure(root,project,origin):
    if not re.fullmatch(r'appgprj_[A-Za-z0-9]+',project) or project.endswith('REPLACE_ME'):
        raise ValueError('Use the exact project_id returned by your own Sites project')
    url=urlsplit(origin)
    if url.scheme!='https' or not url.hostname or not url.hostname.endswith('.chatgpt.site') or url.username or url.password or url.port or url.path not in ('','/') or url.query or url.fragment:
        raise ValueError('Expected an HTTPS origin on chatgpt.site, without a path or credentials')
    origin='https://'+url.hostname
    local=root/'deployment.local.json'
    old=json.loads(local.read_text(encoding='utf8')) if local.exists() else {'project_id':'appgprj_REPLACE_ME','site_origin':'https://your-site.example.invalid'}
    files=[]
    for folder in ('apps/mcp-gateway/lib','scripts','collectors'):
        for p in (root/folder).rglob('*'):
            if p.is_file() and p.suffix in {'.ts','.ps1','.cs'} and not any(part in {'node_modules','bin','obj','.git','outputs'} for part in p.relative_to(root).parts):
                source=p.read_text(encoding='utf8')
                updated=source.replace(old['site_origin'],origin).replace(urlsplit(old['site_origin']).hostname,url.hostname).replace(old['project_id'],project)
                if updated!=source: files.append((p,updated))
    for p,value in files:p.write_text(value,encoding='utf8')
    manifest=root/'apps/mcp-gateway/.openai/hosting.json'
    data=json.loads(manifest.read_text(encoding='utf8'));data['project_id']=project
    manifest.write_text(json.dumps(data,indent=2)+'\n',encoding='utf8')
    local.write_text(json.dumps({'project_id':project,'site_origin':origin},indent=2)+'\n',encoding='utf8')
    return len(files)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project-id',required=True);parser.add_argument('--site-origin',required=True)
    args=parser.parse_args()
    try:count=configure(Path(__file__).resolve().parents[1],args.project_id,args.site_origin)
    except ValueError as e:parser.error(str(e))
    print(json.dumps({'configured':True,'source_files_updated':count,'credentials_read':False}))
