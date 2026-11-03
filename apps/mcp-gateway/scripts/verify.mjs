import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const cwd=fileURLToPath(new URL('..',import.meta.url));
const run=args=>{const r=spawnSync(process.execPath,args,{cwd,stdio:'inherit'});if(r.error)throw r.error;if(r.status!==0)process.exit(r.status??1);};
run(['node_modules/typescript/bin/tsc','--noEmit','--pretty','false']);
const suites=['cloud','discovery','records','bilibili-diagnostics','extensions'];
run(['node_modules/esbuild/bin/esbuild',...suites.map(s=>'test/'+s+'.test.ts'),'--bundle','--platform=node','--format=esm','--packages=external','--outdir=outputs/tests']);
run(['--test',...suites.map(s=>'outputs/tests/'+s+'.test.js')]);
