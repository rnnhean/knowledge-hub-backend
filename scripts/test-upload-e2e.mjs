/**
 * 文档上传全流程端到端验证。
 *
 * 这是这一轮唯一没跑过的链路：上传 → 解析 → 草稿 → 发布 → 审核 → 索引 → 可检索。
 * 之前只验证了「库里已有文档时能问答」，等于跳过了整个入库过程。
 *
 * 全流程要用到两个角色，因为 DOCUMENT_REQUIRE_APPROVAL=true：
 *   admin 上传 + 发布（进待审）→ reviewer 审核通过 → 后端异步切分/向量化/建图谱。
 *
 * 每一步都断言，失败就截图状态，不假装通过。
 */
const BASE = 'http://127.0.0.1:3000';
const ES = 'http://127.0.0.1:9200';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function login(username, password) {
    const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username, password }),
    });
    const json = await res.json();
    const token = json.accessToken ?? json.access_token;
    if (!token) throw new Error(`${username} 登录失败: ${JSON.stringify(json).slice(0, 120)}`);
    return token;
}

async function api(path, { token, method = 'GET', body, form } = {}) {
    const headers = { authorization: `Bearer ${token}` };
    let payload;
    if (form) {
        payload = form;
    } else if (body !== undefined) {
        headers['content-type'] = 'application/json';
        payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + path, { method, headers, body: payload });
    const text = await res.text();
    let json = null;
    try {
        json = JSON.parse(text);
    } catch {
        /* 非 JSON */
    }
    return { status: res.status, json, text };
}

/** 造一个内容独特的 markdown：标题/正文都带随机标记，便于在 ES/图谱里定位。 */
function buildMarkdown(marker) {
    return `# 宠物寄养与出差托管管理办法（${marker}）

## 适用范围
本制度适用于星澜科技全体正式员工的宠物寄养与出差期间托管安排。

## 报销标准
员工因公出差期间宠物寄养费用，每人每天最高补贴 88 元，需提供寄养机构发票。
单次出差累计不超过 15 天。

## 审批流程
1. 直属主管审批出差申请时同步勾选「宠物托管」；
2. 费用报销时需附寄养合同与发票；
3. 超过 5 天的托管需部门负责人加签。

## 特殊说明
本制度自 2026 年 12 月 1 日起施行，与《差旅费用报销管理办法》冲突时以本办法为准。
`;
}

(async () => {
    const marker = `E2E${Date.now()}`;
    console.log(`=== 0. 准备（标记 ${marker}）===`);

    console.log('\n=== 1. 登录（admin + reviewer）===');
    const adminToken = await login('admin', '123456');
    check('admin 登录', Boolean(adminToken));
    let reviewerToken = null;
    try {
        reviewerToken = await login('reviewer', '123456');
        check('reviewer 登录', true);
    } catch (e) {
        check('reviewer 登录', false, e.message);
    }

    console.log('\n=== 2. 上传并解析 POST /documents/upload/parse ===');
    const md = buildMarkdown(marker);
    const form = new FormData();
    form.append('file', new Blob([md], { type: 'text/markdown' }), `${marker}.md`);
    // UploadParseDto 是闭集：只接受 categoryId / teamId / tags / remark / isPublic。
    // 标题不在这里传 —— 它从文件内容（第一个 H1）解析出来，
    // 传 title 会被 forbidNonWhitelisted 直接 400。
    form.append('isPublic', 'true');
    form.append('remark', `e2e 自动上传 ${marker}`);
    const up = await api('/documents/upload/parse', { token: adminToken, method: 'POST', form });
    check('上传接口 200/201', up.status === 200 || up.status === 201, `实际 ${up.status}`);
    if (up.status >= 400) {
        console.log('    响应:', up.text.slice(0, 300));
        throw new Error('上传失败，后续步骤无法继续');
    }
    // 响应字段是 documentId（不是 id）
    const docId = up.json?.documentId ?? up.json?.id ?? up.json?.data?.id;
    const upStatus = up.json?.status ?? up.json?.data?.status;
    check('拿到 documentId', Boolean(docId), `id=${docId}`);
    check('初始状态是草稿(0)', Number(upStatus) === 0, `status=${upStatus}`);

    console.log('\n=== 3. 发布 PUT /documents/:id/publish ===');
    const pub = await api(`/documents/${docId}/publish`, { token: adminToken, method: 'PUT' });
    check('发布接口成功', pub.status === 200, `实际 ${pub.status}`);
    const pubStatus = pub.json?.status ?? pub.json?.data?.status;
    console.log('    发布后状态:', pubStatus, '(3=待审核，1=直接发布)');

    console.log('\n=== 4. 审核（需 DOCUMENT_REQUIRE_APPROVAL=true）===');
    const tasks = await api('/documents/reviews/tasks', { token: reviewerToken ?? adminToken });
    const list = tasks.json?.items ?? tasks.json?.data ?? (Array.isArray(tasks.json) ? tasks.json : []);
    const mine = list.find?.((t) => String(t.documentId ?? t.document_id ?? '') === String(docId));
    check('审核待办里能找到该文档', Boolean(mine), `共 ${list.length} 条待办`);
    if (mine) {
        const taskId = mine.id ?? mine.taskId;
        const ap = await api(`/documents/reviews/tasks/${taskId}/approve`, {
            token: reviewerToken ?? adminToken,
            method: 'POST',
            // 字段是 reviewComment（ReviewDecisionDto 是闭集，传 comment 会 400）
            body: { reviewComment: 'e2e 自动审核通过' },
        });
        check('审核通过接口成功', ap.status === 200 || ap.status === 201, `实际 ${ap.status}`);
        if (ap.status >= 400) console.log('    响应:', ap.text.slice(0, 200));
    }

    console.log('\n=== 5. 等待异步索引（切分 → 向量化 → ES → 图谱）===');
    let indexed = false;
    let chunkCount = 0;
    let finalStatus;
    for (let i = 0; i < 24; i++) {
        await sleep(5000);
        const r = await fetch(`${ES}/kh_chunk/_count?q=${encodeURIComponent(marker)}`);
        if (r.ok) {
            const j = await r.json();
            chunkCount = j.count ?? 0;
        }
        const doc = await api(`/documents/${docId}`, { token: adminToken });
        finalStatus = doc.json?.status ?? doc.json?.data?.status;
        if (i % 3 === 0) console.log(`    ${(i + 1) * 5}s: status=${finalStatus} chunks=${chunkCount}`);
        if (chunkCount > 0 && Number(finalStatus) === 1) {
            indexed = true;
            break;
        }
    }
    check('文档已发布(status=1)', Number(finalStatus) === 1, `实际 ${finalStatus}`);
    check('ES 里有新文档的 chunk', chunkCount > 0, `${chunkCount} 个块`);

    console.log('\n=== 6. 图谱里是否建了节点（异步，需轮询）===');
    // KG 建图比 RAG 慢一个量级：要先调 LLM 抽实体关系。
    // 实测同一篇文档 RAG 5 秒完成、KG 用了 21 秒 —— 只在 RAG 后面立刻查会误判成「没建」。
    const nodeQ = `MATCH (n) WHERE n.name CONTAINS '宠物' RETURN count(n) AS c;`;
    let graphCount = 0;
    for (let i = 0; i < 12; i++) {
        try {
            const { execSync } = await import('node:child_process');
            const out = execSync(
                `docker exec knowledge_hub_neo4j cypher-shell -u neo4j -p 12345678 "${nodeQ}"`,
                { encoding: 'utf8', timeout: 30000 },
            );
            const m = out.match(/\n(\d+)\n/);
            graphCount = m ? Number(m[1]) : 0;
        } catch (e) {
            console.log('    图谱查询失败:', String(e.message).slice(0, 80));
        }
        if (graphCount > 0) break;
        await sleep(5000);
        if (i % 2 === 0) console.log(`    ${(i + 1) * 5}s: 宠物相关节点 ${graphCount} 个`);
    }
    check('图谱里出现新实体', graphCount > 0, `${graphCount} 个节点`);

    console.log('\n=== 7. 问答能否检索到新文档 ===');
    const session = await api('/ai/sessions', { token: adminToken, method: 'POST', body: {} });
    const sessionId = session.json?.id ?? session.json?.data?.id;
    const ask = await api(`/ai/chat/stream`, {
        token: adminToken,
        method: 'POST',
        body: {
            sessionId,
            messages: [
                {
                    role: 'user',
                    parts: [{ type: 'text', text: `宠物寄养报销标准是多少？提到 ${marker} 这份文档吗` }],
                },
            ],
        },
    });
    const answer = ask.text ?? '';
    // 关键：必须命中本轮唯一标记，否则可能是上一轮残留的同内容文档在作答。
    const hitMarker = answer.includes(marker);
    const hitContent = answer.includes('88') || /宠物/.test(answer) || /寄养/.test(answer);
    check('回答命中新文档内容', hitContent, hitContent ? '提到了 88 元/宠物/寄养' : answer.slice(0, 150));
    check('引用的是本轮文档（唯一标记）', hitMarker, hitMarker ? marker : '回答里没有本轮标记，可能命中了旧文档');

    console.log(`\n===== 上传全流程结果: ${pass} 通过 / ${fail} 失败 =====`);
    console.log(`文档 ID: ${docId}`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
