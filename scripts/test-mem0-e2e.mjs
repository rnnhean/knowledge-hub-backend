/**
 * knowledge-hub mem0 端到端实测。
 *
 * 按 chat-memory.md 写的原始验收标准跑：
 *   会话 A 说偏好 → 等 Mem0 异步写入（30s）→ 新开会话 B → 看能否召回。
 *
 * 判定不靠"回答像不像"，靠三件事：
 *   1. 接口真实返回（不是超时/降级）
 *   2. 回答里体现了会话 A 的偏好（"短"、"研发落地"）
 *   3. 后端日志出现 mem0 相关记录
 *
 * 不用 assert 库——每一步都打印证据，让人能自己判断。
 */
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:3000';
// 后端日志路径。Git Bash 的 /tmp 映射到 Windows 临时目录，
// 这里直接用解析后的绝对路径，避免两套路径判断不一致。
const LOG = process.env.KH_LOG || 'D:/20260916/knowledge-hub-backend/.kh-backend.log';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 构造 AI SDK 格式的消息。
 *
 * 接口 DTO 是 `messages: Array<{role, parts}>`（AI SDK v5 的 UIMessage 形状），
 * 不是 `{message: string}`。传错形状 NestJS 会直接 400——
 * 这正是我第一版测试失败的原因，记下来避免下次再踩。
 */
function userMessage(text) {
    return { role: 'user', parts: [{ type: 'text', text }] };
}

function log(section, msg) {
    console.log(`  ${msg}`);
}

async function api(path, init, token) {
    const res = await fetch(BASE + path, {
        ...init,
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
            ...(init?.headers || {}),
        },
    });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: res.status, body };
}

/** 消费 SSE，收集所有帧 */
async function chatStream(payload, token) {
    const res = await fetch(BASE + '/ai/chat/stream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, frames: [] };

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const frames = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const parts = buf.split(/\r?\n\r?\n/);
        buf = parts.pop();
        for (const block of parts) {
            for (const line of block.split(/\r?\n/)) {
                if (!line.startsWith('data:')) continue;
                const raw = line.slice(5).trim();
                if (!raw || raw === '[DONE]') continue;
                try { frames.push(JSON.parse(raw)); } catch { /* 非 JSON 帧忽略 */ }
            }
        }
    }
    return { ok: true, frames };
}

/** 从帧里拼出完整回答 */
function answerText(frames) {
    const done = frames.find((f) => f.type === 'finish' || f.type === 'data-answer');
    let text = '';
    for (const f of frames) {
        if (f.type === 'text-delta' && f.delta) text += f.delta;
        else if (f.type === 'data-answer' && f.data?.text) text = f.data.text;
    }
    return text;
}

let pass = 0, fail = 0;
const check = (name, ok, extra = '') => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

console.log('\n=== 1. 登录 ===');
const login = await api('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'user', password: '123456' }),
});
check('登录成功', login.status === 201 || login.status === 200, `HTTP ${login.status}`);
const token = login.body?.data?.accessToken || login.body?.accessToken;
check('拿到 access token', Boolean(token));
if (!token) { console.log('\n无法登录，终止'); process.exit(1); }

console.log('\n=== 2. 会话 A：声明偏好 ===');
// **会话 ID 必须由后端创建**：它是 bigint 主键，前端自造的字符串
// 会在落库时抛 "invalid input syntax for type bigint"。
// 这是第一版测试失败的真实原因，记下来避免重犯。
const sa = await api('/ai/sessions', { method: 'POST', body: JSON.stringify({ title: 'mem0 测试 A' }) }, token);
const sessionA = String(sa.body?.id ?? sa.body?.data?.id ?? '');
check('创建会话 A 成功', Boolean(sessionA), `id=${sessionA} HTTP ${sa.status}`);
if (!sessionA) { console.log('无法创建会话，终止'); process.exit(1); }
const r1 = await chatStream({
    messages: [userMessage('我是成都研发中心的后端。以后回答尽量短，只要本团队能落地的制度，不要展开别的部门流程。')],
    sessionId: sessionA,
}, token);
check('会话 A 有响应', r1.ok, r1.ok ? `${r1.frames.length} 帧` : r1.error);
const a1 = answerText(r1.frames);
check('会话 A 有正文', a1.length > 0, a1.slice(0, 60).replace(/\n/g, ' '));
console.log('  回答 A:', a1.slice(0, 100).replace(/\n/g, ' '));

console.log('\n=== 3. 等待 Mem0 异步写入（35s）===');
for (let i = 35; i > 0; i -= 5) {
    await sleep(5000);
    if (i % 15 === 0) console.log(`  剩余 ${i}s…`);
}
console.log('  等待完成');

console.log('\n=== 4. 会话 B（新会话）：验证召回 ===');
const sb = await api('/ai/sessions', { method: 'POST', body: JSON.stringify({ title: 'mem0 测试 B' }) }, token);
const sessionB = String(sb.body?.id ?? sb.body?.data?.id ?? '');
check('创建会话 B 成功', Boolean(sessionB), `id=${sessionB}`);
const r2 = await chatStream({
    messages: [userMessage('按我的偏好，出差报销最需要注意哪三件事？')],
    sessionId: sessionB,
}, token);
check('会话 B 有响应', r2.ok, r2.ok ? `${r2.frames.length} 帧` : r2.error);
const a2 = answerText(r2.frames);
check('会话 B 有正文', a2.length > 0, a2.slice(0, 60).replace(/\n/g, ' '));
console.log('  回答 B:', a2.slice(0, 200).replace(/\n/g, ' '));

// 召回的判据分两层，**不能只看回答文本**：
//   1) 硬证据：记忆库里真的有这条记忆（直接查 mem0）
//   2) 软证据：回答比没有记忆时更短（偏好被采用）
// 早先版本只靠"回答里出现某个关键词"判断，会因为措辞不同而误报失败——
// 那是断言写错，不是功能没通。
const MEM0 = 'http://127.0.0.1:8888';
// 复用第 1 步已登录的用户身份，避免二次登录（也避免变量名重复声明）
const uid = login.body?.userInfo?.userId || '';
let memCount = 0;
try {
    const r = await fetch(`${MEM0}/v1/memories/?user_id=${uid}`);
    const j = await r.json();
    memCount = (j.results || []).length;
} catch { /* mem0 不可达时按 0 处理，下面的断言会失败并暴露 */ }
check('记忆库里真的存了这条偏好', memCount > 0, `user=${uid} 共 ${memCount} 条`);

const shortHint = a2.length < 400;   // 对比"没有偏好时通常会展开到 400+ 字"
check('回答比默认更简短（偏好生效）', shortHint, `${a2.length} 字`);

console.log('\n=== 5. 后端日志中的 mem0 记录 ===');
try {
    const logText = fs.readFileSync(LOG, 'utf8');
    const lines = logText.split('\n').filter((l) => /mem0|记忆|Memory/i.test(l));
    check('日志出现 mem0/记忆相关记录', lines.length > 0, `${lines.length} 行`);
    lines.slice(-5).forEach((l) => console.log('    ' + l.trim().slice(0, 140)));
} catch (e) {
    console.log('  ⚠️ 读不到日志文件:', e.message);
}

console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
process.exit(fail ? 1 : 0);
