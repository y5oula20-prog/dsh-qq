#!/usr/bin/env node
// 桥自愈循环（配合 ~/Library/LaunchAgents/com.yaobao.qq-bridge-autostart.plist，KeepAlive 常驻）：
// 每 30 秒巡检一次：
//   1. 桥控制台端口（config.json consolePort，默认 3100）通不通 —— 通 = 桥活着（无论谁拉起的），不动；
//   2. 不通 且 控制中心(3099)就绪 → POST /api/bridge/start 拉起桥；
//   3. 控制中心没就绪就等下一轮（launchd 的 KeepAlive 会把它拉起来）。
// 幂等：以「桥端口是否真的在听」为准，不信任控制中心的内存状态，孤儿/双开都不会发生。
// NapCat 不归它管：主人手动启动（可能要快登/扫码）；NapCat 一起来，桥的看门狗几十秒内自动接上。
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LOG = path.join(ROOT, 'state', 'autostart.log');
const log = (m) => { try { fs.appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

function ccPort() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'control-center.json'), 'utf8'))?.port) || 3099; }
  catch { return 3099; }
}
function bridgePort() {
  try { return Number(JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'))?.consolePort) || 3100; }
  catch { return 3100; }
}
function readToken() {
  try { return fs.readFileSync(path.join(ROOT, 'state', 'control-center-token'), 'utf8').trim(); } catch { return ''; }
}
function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port, timeout: 1500 });
    s.on('connect', () => { s.destroy(); resolve(true); });
    s.on('error', () => resolve(false));
    s.on('timeout', () => { s.destroy(); resolve(false); });
  });
}
function request(port, apiPath, { method = 'GET', token } = {}) {
  return new Promise((resolve, reject) => {
    const body = method === 'POST' ? '{}' : null;
    const req = http.request({
      host: '127.0.0.1', port, path: apiPath, method,
      headers: { 'x-control-token': token ?? '', 'content-type': 'application/json', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) },
      timeout: 5000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => { try { resolve({ status: res.statusCode, json: JSON.parse(data) }); } catch { resolve({ status: res.statusCode, json: null }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
    if (body) req.write(body);
    req.end();
  });
}

const CC = ccPort();
const BRIDGE = bridgePort();
log(`自愈循环启动：控制中心 :${CC}，桥控制台 :${BRIDGE}，巡检间隔 30 秒`);

let busy = false;
for (;;) {
  if (!busy) {
    busy = true;
    (async () => {
      try {
        if (await portOpen(BRIDGE)) return; // 桥活着，什么都不做
        if (!(await portOpen(CC))) return;  // 控制中心没起来，等 launchd 拉它，下一轮再说
        const token = readToken();
        if (!token) { log('没有 state/control-center-token，无法调控制中心 API'); return; }
        const r = await request(CC, '/api/bridge/start', { method: 'POST', token });
        log(`桥端口 ${BRIDGE} 不通 → POST /api/bridge/start → ${r.status} ${JSON.stringify(r.json)}`);
      } catch (e) {
        log(`巡检出错（下一轮继续）：${e.message}`);
      } finally {
        busy = false;
      }
    })();
  }
  await new Promise((r) => setTimeout(r, 30_000));
}
