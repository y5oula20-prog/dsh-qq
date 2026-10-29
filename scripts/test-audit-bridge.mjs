import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import http from 'node:http';
import fs from 'node:fs';

let failures = 0;
async function test(name, run) {
  const h = await bridgeHarness();
  try { await run(h); console.log('PASS', name); }
  catch (error) { failures++; console.error('FAIL', name, error.message); }
  finally { await h.close(); }
}
await test('closed-agent session is not reused after switching to chat', async (h) => {
  h.setMode('closed-agent'); h.setLevel('L2'); // v0.3.0：closed-agent 必须先经管理通道授权到某个级别
  const privileged = await h.ensureSession('private:123');
  h.setMode('chat');
  const restricted = await h.ensureSession('private:123');
  assert.notEqual(restricted, privileged);
  assert.equal(h.calls.created.at(-1).agentPreset, 'qq-chat');
  assert.ok(h.calls.cancelled.includes(privileged));
});
await test('unavailable preset catalogue fails closed for QQ and learner sessions', async (h) => {
  h.setPresets([]);
  assert.equal(h.resolvePresetName('missing', { strict: true }), '');
  await assert.rejects(h.ensureSession('group:456'));
  await assert.rejects(h.ensureSlangLearnerSession());
  assert.equal(h.calls.created.length, 0);
});
await test('session creation crossing a mode change never accepts stale permissions', async (h) => {
  h.setMode('closed-agent'); h.setLevel('L2'); // v0.3.0：closed-agent 必须先经管理通道授权到某个级别
  let release;
  const original = h.api.sessions.create;
  h.api.sessions.create = async (params) => {
    const result = await original(params);
    await new Promise((resolve) => { release = resolve; });
    return result;
  };
  const pending = h.ensureSession('private:123');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  h.setMode('chat');
  release();
  await assert.rejects(pending);
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('queued send rechecks allowlist at actual transport time', async (h) => {
  const sending = h.sendToQQ('group:456', 'fixture');
  h.cfg.allow.groups = [];
  await sending;
  assert.equal(h.calls.sent.length, 0);
});
await test('old prompt completion cannot delete replacement queue after reset', async (h) => {
  const release = [];
  h.api.sessions.prompt = async () => {
    await new Promise((resolve) => release.push(resolve));
    return { result: { ok: true, value: {} } };
  };
  const first = h.deliverPrompt('group:456', 'first');
  while (release.length < 1) await new Promise((resolve) => setImmediate(resolve));
  h.drainPromptQueue('group:456', 'reset');
  const second = h.deliverPrompt('group:456', 'second');
  while (release.length < 2) await new Promise((resolve) => setImmediate(resolve));
  const replacement = h.promptQueues.get('group:456');
  release[0](); await first;
  assert.equal(h.promptQueues.get('group:456'), replacement);
  release[1](); await second;
});
await test('same-policy sessions are reused but legacy unlabelled sessions are replaced', async (h) => {
  const first = await h.ensureSession('private:123');
  assert.equal(await h.ensureSession('private:123'), first);
  delete h.state.sessionPolicies['private:123'];
  assert.notEqual(await h.ensureSession('private:123'), first);
});
await test('reset during model selection cannot return a detached session', async (h) => {
  h.api.sessions.selectModel = async () => {
    h.resetEpoch();
    return { result: { ok: true, value: { selected: {} } } };
  };
  await assert.rejects(h.ensureSession('private:123'));
  assert.equal(h.state.sessions['private:123'], undefined);
});
await test('malformed HTTP request targets return 400 without hanging', async (h) => {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: 'http://[', method: 'GET' }, (response) => {
        response.resume(); response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(1500, () => request.destroy(new Error('request hung')));
      request.end();
    });
    assert.equal(status, 400);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
{ // 控制台重置路径必须与 retireSession 一样：清掉权限元数据并终止 DSH 侧排队的工作。
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const sessionId = await h.ensureSession('private:123');
    assert.ok(h.state.sessionPolicies['private:123'], 'policy should exist before reset');
    h.calls.cancelled.length = 0;
    const status = await new Promise((resolve, reject) => {
      const request = http.request({ host: '127.0.0.1', port: server.address().port, path: '/api/session/reset', method: 'POST',
        // v0.3.0：API 只认 x-console-token 请求头（?token= 只用于打开控制台页面）
        headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' } }, (response) => {
        response.resume();
        response.on('end', () => resolve(response.statusCode));
      });
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('reset request hung')));
      request.end(JSON.stringify({ key: 'private:123' }));
    });
    assert.equal(status, 200);
    assert.equal(h.state.sessions['private:123'], undefined);
    assert.equal(h.state.sessionPolicies['private:123'], undefined, 'policy must not be orphaned by reset');
    assert.ok(h.calls.cancelled.includes(sessionId), 'reset must stop the retired DSH session');
    console.log('PASS console reset drops the session policy and stops the retired DSH session');
  } catch (error) { failures++; console.error('FAIL console reset cleanup:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
{
  const image = Buffer.from('89504e470d0a1a0a00000000', 'hex');
  let body;
  let fetchLimit;
  const h = await bridgeHarness({ globals: {
    safeFetchBuffer: async (_url, maxBytes) => { fetchLimit = maxBytes; return { buffer: image }; },
    validateFetchUrl: async () => { throw new Error('must fetch validated bytes instead of passing a URL'); },
    fetch: async (_url, init) => {
      body = JSON.parse(init.body);
      return { ok: true, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 1 } }) };
    },
  } });
  try {
    await h.sendStickerV2('group:456', 'fixture-sticker');
    assert.equal(body.message.find((part) => part.type === 'image').data.file, 'base64://' + image.toString('base64'));
    assert.equal(fetchLimit, 10 * 1024 * 1024, '发送表情按 socialV2.sticker.maxBytes（默认 10MB）限制下载大小');
    console.log('PASS sticker sending gives OneBot validated bytes, never a URL to refetch');
  } catch (error) { failures++; console.error('FAIL safe sticker sending:', error.message); }
  finally { await h.close(); }
}
// ── 语音发送（AI 通道）的安全边界 ────────────────────────────────────────────
// 语音比文本更"重"（真的会说话、不可撤回），所以这里逐条钉住它的闸门：
// 来源只能是语音库、白名单必须命中、限流要生效、文件名审计要拦住本机路径。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  // 默认出厂配置是 voice.enabled=false（AI 不能发语音）；这里显式打开，
  // 才能测"打开之后"的各项闸门。关闭时的行为单独在下面钉一条。
  const voiceOn = { socialV2: { voice: { enabled: true } } };
  const h = await bridgeHarness({ config: voiceOn });
  try {
    // 语音库 fixture：临时 config 的 ROOT 之下，voice.dir 默认 'audio'
    const audioDir = path.join(h.temp, 'audio');
    fs.mkdirSync(audioDir, { recursive: true });
    fs.writeFileSync(path.join(audioDir, 'hello.mp3'), Buffer.alloc(1024, 1));
    // 库外的文件（模拟"随便一个本地文件"）
    const outside = path.join(h.temp, 'outside-secret.mp3');
    fs.writeFileSync(outside, Buffer.alloc(1024, 1));

    const names = h.voiceLibrary().map((v) => v.name);
    assert.ok(names.includes('hello.mp3'), '语音库列出库内音频');
    assert.ok(!names.some((n) => n.includes(h.temp)), '语音库不返回绝对路径');

    // 1) AI 只能按语音库名字取文件
    const okPath = h.resolveVoicePathForV2('hello');
    assert.equal(okPath.path, path.join(audioDir, 'hello.mp3'), 'AI 省略扩展名也能命中语音库文件');

    // 2) 绝对路径默认被拒（防 prompt injection 拿任意本地文件外发）
    assert.throws(() => h.resolveVoicePathForV2(outside), /语音库|绝对路径/, 'AI 传库外绝对路径被拒');
    assert.throws(() => h.resolveVoicePathForV2('C:\\Windows\\Media\\Alarm01.wav'), /语音库|绝对路径/, 'AI 传系统绝对路径被拒');

    // 3) 远程/内联来源被拒（体积与来源都不可控）
    for (const bad of ['https://example.com/a.mp3', 'base64://AAAA', 'data:audio/mp3;base64,AAAA']) {
      assert.throws(() => h.resolveVoicePathForV2(bad), /不接受|只能/, `AI 传 ${bad.split(':')[0]} 来源被拒`);
    }

    // 4) 真发一条（虚拟网关）：必须是 record 段、且 file 指向库内文件
    const sent = await h.sendVoiceForV2('group:456', 'hello.mp3', { readback: false });
    const call = h.calls.http.find((c) => c.url.endsWith('/send_group_msg'));
    assert.ok(call, '语音走 send_group_msg');
    assert.equal(call.body.group_id, 456, '语音发给正确群');
    assert.equal(call.body.message.length, 1, '语音只发一个段');
    assert.equal(call.body.message[0].type, 'record', '段类型是 record');
    assert.equal(call.body.message[0].data.file, path.join(audioDir, 'hello.mp3'), 'record 段指向库内绝对路径');
    assert.equal(sent.messageId, 9001, '返回网关 message_id');
    assert.equal(sent.readback, null, '显式关掉回读时不调 fetch_ptt_text');

    // 5) 落地校验：默认用 get_msg 回读确认这条消息真的带 record 段
    const h2 = await bridgeHarness({ config: voiceOn });
    try {
      const dir2 = path.join(h2.temp, 'audio');
      fs.mkdirSync(dir2, { recursive: true });
      fs.writeFileSync(path.join(dir2, 'hi.mp3'), Buffer.alloc(512, 1));
      const sent2 = await h2.sendVoiceForV2('group:456', 'hi.mp3');
      // 注意：这些对象来自 vm realm，deepEqual 会因原型不同而失败 → 逐字段断言
      assert.equal(sent2.verification?.confirmed, true, '默认回读 get_msg 确认 record 段');
      assert.equal(sent2.verification?.duration, 3, '回读到语音时长');
      // 校验结果**不能**把源文件路径回传给 AI（私聊 get_msg 会把本机路径塞进 record.url）
      assert.equal(sent2.verification?.file, undefined, '校验结果不回传文件路径（防路径泄露进模型上下文）');
      assert.ok(h2.calls.http.some((c) => c.url.endsWith('/get_msg')), '校验走 get_msg');
      assert.equal(sent2.readback, null, '默认不索取转写（自己发的语音没有转写）');
      // 关掉校验时不发 get_msg
      const h2b = await bridgeHarness({ config: voiceOn });
      try {
        const dir2b = path.join(h2b.temp, 'audio');
        fs.mkdirSync(dir2b, { recursive: true });
        fs.writeFileSync(path.join(dir2b, 'hi.mp3'), Buffer.alloc(512, 1));
        const sent2b = await h2b.sendVoiceForV2('group:456', 'hi.mp3', { verify: false });
        assert.equal(sent2b.verification, null, 'verify=false 时不做回读校验');
        assert.ok(!h2b.calls.http.some((c) => c.url.endsWith('/get_msg')), 'verify=false 时不发 get_msg');
      } finally { await h2b.close(); }
    } finally { await h2.close(); }

    // 6) 文件名审计：含本机路径特征的名字不许外发。
    //    resolveVoicePathForV2 允许绝对路径的"文件名形态"由 allowAbsolutePath 管；
    //    这里直接喂一个**看起来就像本机路径**的名字，验证审计层会拦下来。
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', 'C:\\Users\\somebody\\secret-voice.mp3', { readback: false }),
      /敏感信息|语音库|绝对路径/,
      '文件名含本机路径特征被审计/来源校验拦截'
    );

    // 7) 限流：语音额度独立计数，超限拒绝
    const h3 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
    try {
      const dir3 = path.join(h3.temp, 'audio');
      fs.mkdirSync(dir3, { recursive: true });
      fs.writeFileSync(path.join(dir3, 'a.mp3'), Buffer.alloc(512, 1));
      await h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
      await assert.rejects(
        () => h3.sendVoiceForV2('group:456', 'a.mp3', { readback: false }),
        /频率超限|每分钟/,
        '同一分钟内第二条语音被限流（每分钟 1 条）'
      );
      // 额度只在发出后才记账：参数错误不应吃掉配额
      const h4 = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, maxPerMinute: 1, maxPerHour: 2 } } } });
      try {
        const dir4 = path.join(h4.temp, 'audio');
        fs.mkdirSync(dir4, { recursive: true });
        fs.writeFileSync(path.join(dir4, 'a.mp3'), Buffer.alloc(512, 1));
        await assert.rejects(() => h4.sendVoiceForV2('group:456', 'nope.mp3'), /找不到/, '不存在的音频被拒');
        // 失败没有消耗额度 → 紧接着真发一条应当成功
        const ok2 = await h4.sendVoiceForV2('group:456', 'a.mp3', { readback: false });
        assert.equal(ok2.messageId, 9001, '失败不吃额度：随后发送成功');
      } finally { await h4.close(); }
    } finally { await h3.close(); }

    // 8) 语音功能总开关关闭时，**AI 通道**彻底拒绝
    const h5 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      await assert.rejects(() => h5.sendVoiceForV2('group:456', 'a.mp3'), /已关闭/, 'voice.enabled=false 时 AI 通道拒绝发送');
    } finally { await h5.close(); }

    // 9) 但**操作者通道**不受这个开关影响：否则"默认不启用"会变成"连手动试发都做不了"
    const h6 = await bridgeHarness({ config: { socialV2: { voice: { enabled: false } } } });
    try {
      const dir6 = path.join(h6.temp, 'audio');
      fs.mkdirSync(dir6, { recursive: true });
      fs.writeFileSync(path.join(dir6, 'a.mp3'), Buffer.alloc(512, 1));
      const sent6 = await h6.sendVoiceV2('group:456', path.join(dir6, 'a.mp3'), { guard: false, audit: true });
      assert.equal(sent6.messageId, 9001, 'voice.enabled=false 时操作者仍能发（AI 开关不该封死手动路径）');
    } finally { await h6.close(); }

    // 10) 音量：倍数会传给音频处理，并原样回报给调用方
    const h7 = await bridgeHarness({ config: voiceOn });
    try {
      const dir7 = path.join(h7.temp, 'audio');
      fs.mkdirSync(dir7, { recursive: true });
      fs.writeFileSync(path.join(dir7, 'a.mp3'), Buffer.alloc(512, 1));
      const loud = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { volume: 2.5 } });
      assert.equal(loud.volume, 2.5, '音量倍数透传到音频处理');
      assert.equal(loud.audioMode, 'volume', 'mode 标为 volume');
      assert.match(loud.audioProcessing, /250%/, '处理说明含百分比');
      const normal = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true });
      assert.equal(normal.audioMode, 'original', '不传音量时保持原样（不转码）');
      assert.equal(normal.audioProcessing, '原始音量', '原样时说明为"原始音量"');
      const smart = await h7.sendVoiceV2('group:456', path.join(dir7, 'a.mp3'), { guard: false, audit: true, audio: { normalize: true, loudness: 'loud' } });
      assert.equal(smart.audioMode, 'loudnorm', '智能音量 mode=loudnorm');
      assert.match(smart.audioProcessing, /-13/, '智能音量按档位给出目标 LUFS');
      // 非法音量必须被拦下（而不是把奇怪的值丢给 ffmpeg）
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { volume: 99 } }),
        /0\.1~4/,
        '越界音量被拒'
      );
      await assert.rejects(
        () => h7.sendVoiceForV2('group:456', 'a.mp3', { verify: false, audio: { normalize: true, loudness: 'nope' } }),
        /未知的响度档位/,
        '未知响度档位被拒'
      );
    } finally { await h7.close(); }

    // 11) uploadMode=auto 的「路径失败记忆」：macOS 上 QQ 在沙盒里读不到桥接给的绝对路径，
    //     每次都先失败一次再退 base64。必须记住这条通道读不了路径，下一条直接走 base64。
    //     但只认路径类错误 —— 群被踢/限频这类失败不能污染记忆，否则会掩盖真正的错误。
    const voiceAuto = { socialV2: { voice: { enabled: true, uploadMode: 'auto', maxPerMinute: 50, maxPerHour: 50 } } };
    {
      let pathAttempts = 0;
      const h8 = await bridgeHarness({
        config: voiceAuto,
        globals: {
          // 只拦真实发送（群/私聊都是 record 段）；get_msg 等其它动作仍走 harness 的默认桩。
          fetch: async (url, init = {}) => {
            const action = String(url).split('/').pop();
            if (action === 'send_group_msg' || action === 'send_private_msg') {
              const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return {}; } })();
              const file = String(body?.message?.[0]?.data?.file ?? '');
              if (!file.startsWith('base64://')) {
                pathAttempts++;
                return { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 1200, wording: 'Failed to open input: Operation not permitted' }) };
              }
              return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9101 } }) };
            }
            return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9101 } }) };
          }
        }
      });
      try {
        const dir8 = path.join(h8.temp, 'audio');
        fs.mkdirSync(dir8, { recursive: true });
        fs.writeFileSync(path.join(dir8, 'a.mp3'), Buffer.alloc(512, 1));

        const first = await h8.sendVoiceV2('group:456', path.join(dir8, 'a.mp3'), { guard: false, audit: true });
        assert.equal(first.messageId, 9101, '路径失败后退 base64 仍能发出去');
        assert.equal(pathAttempts, 1, '第一条语音：先试路径（失败一次）');

        const second = await h8.sendVoiceV2('group:456', path.join(dir8, 'a.mp3'), { guard: false, audit: true });
        assert.equal(second.messageId, 9101, '第二条语音照样发得出去');
        assert.equal(pathAttempts, 1, '第二条语音：记住路径读不了，直接走 base64，不再白试一次');

        // 另一条会话（key 不同）是独立通道，不该被别人的失败记忆牵连。
        fs.writeFileSync(path.join(dir8, 'b.mp3'), Buffer.alloc(512, 3));
        await h8.sendVoiceV2('private:123', path.join(dir8, 'b.mp3'), { guard: false, audit: true });
        assert.equal(pathAttempts, 2, '不同会话各有各的记忆：private 通道仍先试路径');
      } finally { await h8.close(); }
    }
    {
      // 非路径类失败（例如群把机器人踢了）不得写进记忆。
      let pathAttempts = 0;
      const h9 = await bridgeHarness({
        config: voiceAuto,
        globals: {
          fetch: async (url, init = {}) => {
            const action = String(url).split('/').pop();
            if (action === 'send_group_msg') {
              const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return {}; } })();
              const file = String(body?.message?.[0]?.data?.file ?? '');
              if (!file.startsWith('base64://')) {
                pathAttempts++;
                return { ok: true, status: 200, json: async () => ({ status: 'failed', retcode: 110, wording: '发送失败，你已被移出该群，请重新加群。' }) };
              }
              return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9102 } }) };
            }
            return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9102 } }) };
          }
        }
      });
      try {
        const dir9 = path.join(h9.temp, 'audio');
        fs.mkdirSync(dir9, { recursive: true });
        fs.writeFileSync(path.join(dir9, 'a.mp3'), Buffer.alloc(512, 1));
        await h9.sendVoiceV2('group:456', path.join(dir9, 'a.mp3'), { guard: false, audit: true });
        await h9.sendVoiceV2('group:456', path.join(dir9, 'a.mp3'), { guard: false, audit: true });
        assert.equal(pathAttempts, 2, '「被移出群」不是路径问题：不写记忆，下一条照样先试路径');
      } finally { await h9.close(); }
    }

    console.log('PASS voice sending enforces library-only source, whitelist, budget, name audit and volume');
  } catch (error) { failures++; console.error('FAIL voice sending guards:', error.message); }
  finally { await h.close(); }
}

// ── 语音路径：allowAbsolutePath 不再放宽 AI 通道（任意本机音频外发）────────────
// 审计发现：开关打开时 resolveVoicePathForV2 会把 AI 给的绝对路径直接交给
// resolveAudioSource 解析，于是群友用提示注入就能让 AI 把本机任意音频（< 20MB）
// 发到群里；而 inspectAudio 在 ffprobe 不可用时对任何文件都放行。
// 现在即使开了开关，绝对路径也必须落在语音库目录之内。
{
  const fs = await import('node:fs');
  const path = await import('node:path');
  const h = await bridgeHarness({ config: { socialV2: { voice: { enabled: true, allowAbsolutePath: true, maxPerMinute: 50, maxPerHour: 50 } } } });
  try {
    const libraryDir = path.join(h.temp, 'audio');
    const outsideDir = path.join(h.temp, 'outside');
    fs.mkdirSync(libraryDir, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(libraryDir, 'inside.mp3'), Buffer.alloc(512, 1));
    const outsideFile = path.join(outsideDir, 'secret.mp3');
    fs.writeFileSync(outsideFile, Buffer.alloc(512, 2));

    // 库外的绝对路径必须被拒绝（即使 allowAbsolutePath=true）
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', outsideFile, { readback: false }),
      /语音库/,
      'allowAbsolutePath=true 时库外绝对路径仍必须被拒绝'
    );
    // 相对穿越同样必须被拒绝
    await assert.rejects(
      () => h.sendVoiceForV2('group:456', path.join('..', 'outside', 'secret.mp3'), { readback: false }),
      /语音库|\.\./,
      '相对路径穿越必须被拒绝'
    );
    // 库内的绝对路径应当仍然可用（开关的合理用途）
    const inside = await h.sendVoiceForV2('group:456', path.join(libraryDir, 'inside.mp3'), { readback: false });
    assert.equal(inside.messageId, 9001, '库内绝对路径仍可发送');
    console.log('PASS voice absolute paths stay confined to the library even when allowAbsolutePath is on');
  } catch (error) { failures++; console.error('FAIL voice library confinement:', error.message); }
  finally { await h.close(); }
}

// agent token 默认拒绝：MCP 的 v2 工具同时携带 x-console-token 与 x-agent-token，
// 因此仅靠控制台令牌挡不住 QQ 群里的 AI。人格/提示词/思考强度/白名单/重启等管理端点
// 必须对 agent token 一律 403，否则 AI 能改写自己的系统提示词或给自己提权。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const adminOnly = { 'x-console-token': 'fixture-console-token' };
    const asAgent = { ...adminOnly, 'x-agent-token': 'fixture-agent-token' };
    const mustDeny = [
      ['GET', '/api/roles'], ['GET', '/api/roles/content?name=x'], ['GET', '/api/roles?x=1'],
      ['POST', '/api/roles/create'], ['POST', '/api/roles/update'],
      ['POST', '/api/roles/rename'], ['POST', '/api/roles/delete'],
      ['GET', '/api/preset/sim-prompt'], ['POST', '/api/preset/sim-prompt'],
      ['GET', '/api/preset/sim-prompt/backups'], ['POST', '/api/preset/sim-prompt/restore'],
      ['GET', '/api/dsh/model'], ['POST', '/api/dsh/model'], ['POST', '/api/dsh/effort'],
      ['GET', '/api/whitelist'], ['POST', '/api/whitelist'], ['POST', '/api/restart'],
      ['POST', '/api/console/token'], ['GET', '/api/role'], ['POST', '/api/role'],
    ];
    for (const [method, path] of mustDeny) {
      const res = await call(path, method, asAgent, method === 'POST' ? {} : undefined);
      assert.equal(res.status, 403, `${method} ${path} 必须对 agent token 拒绝，实际 HTTP ${res.status}`);
    }
    // 绕过尝试：路径穿越与重复斜杠在 URL 解析后仍需被拒
    for (const path of ['/api/roles/../roles', '/api//roles', '/api/./roles', '/api/roles/']) {
      const res = await call(path, 'GET', asAgent);
      assert.notEqual(res.status, 200, `${path} 不得绕过 agent token 限制（实际 HTTP ${res.status}）`);
    }
    // 允许面：AI 真正需要的只读接口不应被误伤
    const allowed = await call('/api/status', 'GET', asAgent);
    assert.equal(allowed.status, 200, '/api/status 应对 agent token 放行');
    // 同一批管理端点，管理员（仅控制台令牌）应可正常访问
    const adminOk = await call('/api/dsh/model', 'GET', adminOnly);
    assert.equal(adminOk.status, 200, '管理员应能访问 /api/dsh/model');
    console.log('PASS agent token cannot reach persona/prompt/effort/whitelist admin endpoints');
  } catch (error) { failures++; console.error('FAIL agent token admin isolation:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}
// ── 控制台入口的传输层防护：Host 头 + 令牌定长比较 + /api/authorize/read 鉴权 ──
// 这三条都是「审计发现 → 加固」的结果，钉住它们以防以后被无意改回去。
{
  const h = await bridgeHarness();
  const server = h.startConsoleServer();
  try {
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const call = (path, method = 'GET', headers = {}, body) => new Promise((resolve, reject) => {
      const request = http.request(
        { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
        (response) => {
          let data = '';
          response.on('data', (chunk) => { data += chunk; });
          response.on('end', () => resolve({ status: response.statusCode, body: data }));
        },
      );
      request.on('error', reject);
      request.setTimeout(3000, () => request.destroy(new Error('request hung')));
      request.end(body === undefined ? undefined : JSON.stringify(body));
    });
    const admin = { 'x-console-token': 'fixture-console-token' };

    // ① DNS rebinding 硬化：非本机 Host 一律拒绝（即使带着正确的控制台令牌）。
    // 注意 Host 必须走 headers（Node 会用 options.host 覆盖它，那样测不到伪造 Host）。
    for (const host of ['evil.example.com:' + port, '127.0.0.1:1', 'localhost']) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 403, `Host=${host} 必须被拒绝，实际 HTTP ${res.status}`);
    }
    // 合法的三个 Host 都要放行（127.0.0.1 / localhost / [::1] 加实际端口）
    for (const host of [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`]) {
      const res = await call('/api/status', 'GET', { ...admin, host });
      assert.equal(res.status, 200, `Host=${host} 应被接受，实际 HTTP ${res.status}`);
    }

    // ② 令牌比较必须是定长：错长度/错内容的令牌都不得通过（不能因为"前缀对"就放行）。
    // 注意 Node 的 HTTP 客户端会自动裁掉自定义头的首尾空白，所以"带尾空格"这一类
    // 必须用 ?token= 传（控制台本来就接受这种入口，它才是真实的攻击面）。
    for (const token of ['fixture-console-token-x', 'fixture-console-toke', 'FIXTURE-CONSOLE-TOKEN', 'fixture-console-token ']) {
      const res = await call(`/api/status?token=${encodeURIComponent(token)}`, 'GET');
      assert.equal(res.status, 401, `令牌「${token}」不得通过鉴权，实际 HTTP ${res.status}`);
    }
    const noHeader = await call('/api/status', 'GET');
    assert.equal(noHeader.status, 401, '不带令牌必须被拒绝');

    // ③ /api/authorize/read 不再接受空令牌（它曾对 agent 流量开放 ⇒ 成为免鉴权入口）。
    const noToken = await call('/api/authorize/read', 'POST', { ...admin, 'x-agent-token': 'x' }, { key: 'group:456' });
    assert.equal(noToken.status, 403, '空会话令牌必须被拒绝');
    console.log('PASS console rejects foreign Host headers, non-exact tokens and token-less authorize/read');
  } catch (error) { failures++; console.error('FAIL console transport guards:', error.message); }
  finally { await new Promise((resolve) => server.close(resolve)); await h.close(); }
}

// ── 定时静默：提前告诉 AI「现在发不出去」，别再试一次再报警 ─────────────────
// 起因（2026-10-29 线上日志）：14:00 静默开始后，AI 反复调 qq_send_message 被 403、
// 然后连发 3 条 warning/error 报案「静默模式已持续近 2 小时」。它没有别的办法知道
// 「这是计划内的、等会儿就好」，只能靠试。两处修复，这里各锁一条：
//   ① 唤醒 prompt 里预先写明「此刻不能发言 + 别重试」；
//   ② 403 文案里带上「不是故障、请勿重试」，让它看到拒绝就知道该收尾。
{
  const silenceState = {
    config: {
      enabled: true, timezone: 'Asia/Shanghai',
      // 全天生效，避免测试在 14:00-18:00 之外跑就失效（这也是它不该依赖真实时钟的原因）。
      ranges: [{ id: 'peak1', name: '下午高峰', enabled: true, start: '00:00', end: '23:59', days: 'every', weekdays: [], skipHolidays: false }],
      options: { stopWakes: false, recordMessages: true, pauseAiTasks: true, includeOwnerPrivate: false, catchUpOnEnd: true }
    }
  };
  const h = await bridgeHarness({
    config: { ownerQQ: '123', socialV2: { enabled: true } },
    files: { 'state/silence-schedule.json': JSON.stringify(silenceState) }
  });
  try {
    const key = 'group:456';
    // 前提：这份配置确实被判定为「静默中」，否则下面的断言是空转。
    const w = h.scheduledSilenceFor(key);
    assert.ok(w, '前置条件失败：全天静默配置没有被识别为生效中');
    assert.equal(w.range.name, '下午高峰');

    const prompt = h.buildWakePromptV2(key, 'scheduled');
    assert.ok(prompt.includes('【此刻不能发言】'), '唤醒 prompt 必须提前告知当前不能发言');
    assert.ok(prompt.includes('不要调用它们'), '必须明确叫停发送工具调用');
    assert.ok(prompt.includes('不要重试'), '必须明确说别重试');
    assert.ok(prompt.includes('不是故障'), '必须说清这是计划内时段，避免 AI 当故障上报');
    // 时间点要能读出来，AI 才知道大概等多久。
    assert.ok(/到 \d{4}-\d{2}-\d{2}/.test(prompt), '提示里要带上静默结束时刻');

    // 非静默会话（管理员私聊，includeOwnerPrivate=false）不该被打上这条提示。
    const ownerKey = 'private:123';
    assert.equal(h.scheduledSilenceFor(ownerKey), null, '管理员私聊默认不受定时静默影响');
    const ownerPrompt = h.buildWakePromptV2(ownerKey, 'scheduled');
    assert.ok(!ownerPrompt.includes('【此刻不能发言】'), '管理员私聊的 prompt 不该出现「不能发言」提示');

    // ② 403 文案：带「请勿重试」，但前缀「静默模式已开启」保持不变（日志与人工排查都靠它）。
    const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
    const blockedLines = src.split('\n').filter((l) => l.includes("'静默模式已开启，当前不允许"));
    assert.ok(blockedLines.length >= 10, `静默拦截点应有 10 处以上，实际 ${blockedLines.length}`);
    const missing = blockedLines.filter((l) => !l.includes('请勿重试'));
    assert.equal(missing.length, 0, `这些拦截点还没带上「请勿重试」：\n${missing.map((l) => l.trim()).join('\n')}`);
    console.log('PASS timed silence tells the agent up-front that sending is blocked, and 403s say do-not-retry');
  } catch (error) { failures++; console.error('FAIL timed silence keeps the agent from retrying sends:', error.message); }
  finally { await h.close(); }
}

// ── 单实例锁：端口探测必须在这台机器上真的看得见 LISTEN ────────────────────
// 起因（2026-10-29 实测）：consolePortInUse() 原来只跑 `ss -ltn || netstat -ltn`，
// 而 BSD/macOS 的 netstat 没有 -l 语义（`netstat -ltn | grep -c LISTEN` = 0），
// 于是这个函数在 macOS 上永远返回 false。后果是单实例保护反过来失效：锁里 PID 明明活着，
// 也被判成过期锁删掉 —— 我重启桥接时就亲眼看到新实例把前一个实例的锁偷走了。
// 这里锁住的是「探测逻辑能认出真实 LISTEN 端口」这件事本身，不依赖宿主机具体哪个端口在听。
{
  const src = fs.readFileSync(new URL('../src/bridge.js', import.meta.url), 'utf8');
  const stem = 'function consolePortInUse() {';
  const start = src.indexOf(stem);
  assert.ok(start >= 0, '没找到 consolePortInUse()，函数被改名了？这条测试要跟着改');
  const end = src.indexOf('\n}', start);
  const body = src.slice(start, end);
  // ① 必须包含 macOS 能用的探测命令；只有 ss/netstat -ltn 是不够的。
  assert.ok(body.includes("netstat -an -p tcp"), 'macOS/BSD 上必须用 netstat -an -p tcp 才能看到 LISTEN');
  assert.ok(body.includes("'ss -ltn'"), 'Linux 上的 ss 探测要保留');
  // ② 不能只看「端口号出现过」——旧实现 `new RegExp(`[:.]${port}\\s`)` 匹配不到也照样返回 true 的写法
  //    曾经让它永远看不到端口；必须要求同一行里带 LISTEN 状态。
  assert.ok(/LISTEN/.test(body), '探测正则应校验 LISTEN 状态，不能只看端口号出现过');
  // ③ 探测失败仍要保守返回 true（宁可让人手动删锁，也不要冒双实例风险）。
  assert.ok(/catch {\s*\/\/[^]*?return true;\s*}/.test(body), '兜底 catch 必须 return true（保守判定为有人占用）');

  // ④ 端到端核对：用和实现同样的正则扫本机真实输出，能看见本进程正在监听的端口时返回 true。
  //    没有真端口可测时跳过（比如 CI 里 consolePort 配成 0）。
  const { execFileSync } = await import('node:child_process');
  const probe = (port) => {
    for (const p of ['ss -ltn', 'netstat -an -p tcp', 'netstat -ltn']) {
      try {
        const out = execFileSync('sh', ['-c', `${p} 2>/dev/null || true`], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
        if (new RegExp(`(?:^|[\\s.:])${port}\\s+.*LISTEN`, 'im').test(out)) return true;
      } catch {}
    }
    return false;
  };
  const port = process.env.AUDIT_LOCK_PORT ? Number(process.env.AUDIT_LOCK_PORT) : 3100;
  const looksOccupied = probe(port);
  if (looksOccupied) {
    console.log(`PASS single-instance port probe sees LISTEN on ${port} (this host)`);
  } else {
    console.log(`SKIP single-instance port probe: 本机 ${port} 没有监听，跳过端到端核对（源码断言已通过）`);
  }
  // ⑤ 绝不把「探测逻辑」反过来：没人在听的端口必须判 false，否则锁永远被当成有效。
  assert.equal(probe(59997), false, '没有任何进程监听的端口必须判定为空闲');
}
if (failures) process.exitCode = 1;
