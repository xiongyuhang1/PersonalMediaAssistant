import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) { console.log('已有 .env，保持现有凭据不变。'); process.exit(0); }
let text = readFileSync('.env.example', 'utf8');
for (const key of ['PMA_SERVICE_TOKEN', 'PMA_COLLECTOR_TOKEN', 'PMA_CURSOR_SECRET']) text = text.replace(new RegExp(`^${key}=$`, 'm'), `${key}=${randomBytes(32).toString('base64url')}`);
writeFileSync('.env', text, { mode: 0o600, flag: 'wx' });
console.log('已在本地创建被 Git 忽略的 .env，并生成独立凭据；未显示令牌。平台登录态尚未配置。');
