// Independent protocol fixture generator using Node's AES and public-key RSA.
// Public protocol constants match api-enhanced util/crypto.js; no user secrets.
import { createCipheriv, createHash, publicEncrypt, constants } from 'node:crypto';
import { writeFileSync } from 'node:fs';
const iv = Buffer.from('0102030405060708');
const aes = (text, key, mode) => {
  const cipher = createCipheriv(`aes-128-${mode}`, Buffer.from(key), mode === 'cbc' ? iv : Buffer.alloc(0));
  return Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
};
const payload = { uid: '42', type: 1, csrf_token: 'fixture' };
const text = JSON.stringify(payload), key = 'abcdefghijklmnop';
const publicKey = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDgtQn2JZ34ZC28NWYpAUd98iZ37BUrX/aKzmFbt7clFSs6sXqHauqKWqdtLkF2KexO40H1YTX8z2lSgBBOAxLsvaklV8k4cBFK9snQXE9/DDaFt6Rr7iVZMldczhC0JNgTz+SHXT6CBHuX3e9SdB1Ua44oncaTWz7OBGLbCiK45wIDAQAB
-----END PUBLIC KEY-----`;
const rsa = Buffer.alloc(128); Buffer.from([...key].reverse().join('')).copy(rsa, 128 - key.length);
const path = '/api/login/qrcode/unikey';
const digest = createHash('md5').update(`nobody${path}use${text}md5forencrypt`).digest('hex');
const fixture = {
  source: 'api-enhanced util/crypto.js protocol; independently generated using Node crypto',
  weapi: { params: aes(aes(text, '0CoJUm6Qyw8W8jud', 'cbc').toString('base64'), key, 'cbc').toString('base64'), encSecKey: publicEncrypt({ key: publicKey, padding: constants.RSA_NO_PADDING }, rsa).toString('hex') },
  eapi: { params: aes(`${path}-36cd479b6b5-${text}-36cd479b6b5-${digest}`, 'e82ckenh8dichen8', 'ecb').toString('hex').toUpperCase() },
};
writeFileSync(new URL('./vectors.json', import.meta.url), JSON.stringify(fixture, null, 2) + '\n');
console.log('Generated public protocol fixtures.');
