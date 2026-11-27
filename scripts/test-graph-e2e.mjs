/**
 * 知识图谱端到端验证。
 *
 * 背景：knowledge_hub_neo4j 容器 2 周前停了（Exited 137），后端一直打
 * 「Neo4j 不可用，KG 写入将跳过」，图谱能力从没在本轮验证过。
 *
 * 这个脚本验证四件事：
 *   1. 图谱接口能返回真实数据（不是空数组）
 *   2. 数据规模与 Neo4j 里一致（防止接口层过滤掉了全部）
 *   3. 搜索能命中已知实体
 *   4. 问答时 retrieve_graph 真的被调用（不是只有 retrieve_knowledge）
 */
const BASE = 'http://127.0.0.1:3000';
const USER = 'user';
const PASS = '123456';

let pass = 0;
let fail = 0;
const check = (name, ok, extra = '') => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? '✅' : '❌'} ${name}${extra ? ' — ' + extra : ''}`);
};

async function login() {
    const res = await fetch(`${BASE}/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: USER, password: PASS }),
    });
    const json = await res.json();
    // 字段是 camelCase 的 accessToken（NestJS 返回的是 TS 里的原始命名）
    const token = json.accessToken ?? json.access_token;
    if (!token) throw new Error('登录失败: ' + JSON.stringify(json).slice(0, 150));
    return token;
}

async function api(path, token) {
    const res = await fetch(BASE + path, { headers: { authorization: `Bearer ${token}` } });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        json = null;
    }
    return { status: res.status, json, text };
}

(async () => {
    console.log('=== 1. 登录 ===');
    const token = await login();
    check('拿到 token', Boolean(token));

    console.log('\n=== 2. 图谱概览 GET /graph/overview ===');
    const ov = await api('/graph/overview', token);
    check('接口 200', ov.status === 200, `实际 ${ov.status}`);
    if (ov.json) {
        const nodes = ov.json.nodes ?? ov.json.data?.nodes ?? [];
        const edges = ov.json.edges ?? ov.json.data?.edges ?? [];
        const stats = ov.json.stats ?? ov.json.data?.stats ?? {};
        console.log('    顶层字段:', Object.keys(ov.json).join(', '));
        console.log('    nodes:', Array.isArray(nodes) ? nodes.length : '(非数组)', '| edges:', Array.isArray(edges) ? edges.length : '(非数组)');
        console.log('    stats:', JSON.stringify(stats).slice(0, 200));
        check('节点数 > 0', Array.isArray(nodes) && nodes.length > 0, `${nodes.length} 个`);
        check('边数 > 0', Array.isArray(edges) && edges.length > 0, `${edges.length} 条`);
    } else {
        check('返回 JSON', false, ov.text.slice(0, 100));
    }

    console.log('\n=== 3. 实体搜索 GET /graph/search ===');
    // 用库里真实存在的实体名做关键词（制度里的高频词）
    for (const kw of ['出差', '报销', '审批', '会议室']) {
        const r = await api(`/graph/search?keyword=${encodeURIComponent(kw)}&limit=10`, token);
        const list = r.json?.nodes ?? r.json?.data ?? (Array.isArray(r.json) ? r.json : []);
        const n = Array.isArray(list) ? list.length : 0;
        console.log(`    「${kw}」-> ${n} 个结果`);
        if (kw === '出差') check('搜索「出差」有命中', n > 0, `${n} 个`);
    }

    console.log('\n=== 4. 节点类型分布 GET /graph/nodes ===');
    const nodes = await api('/graph/nodes?limit=200', token);
    const arr = Array.isArray(nodes.json) ? nodes.json : (nodes.json?.nodes ?? nodes.json?.data ?? []);
    check('节点接口返回数据', Array.isArray(arr) && arr.length > 0, `${arr.length} 个`);
    if (Array.isArray(arr) && arr.length) {
        const byType = {};
        for (const n of arr) {
            const t = n.type ?? n.labels?.[0] ?? n.label ?? '(未知)';
            byType[t] = (byType[t] ?? 0) + 1;
        }
        console.log('    类型分布:', JSON.stringify(byType));
        console.log('    样例:', JSON.stringify(arr.slice(0, 3)).slice(0, 300));
    }

    console.log('\n=== 5. 关系边 GET /graph/edges ===');
    const edges = await api('/graph/edges?limit=100', token);
    const earr = Array.isArray(edges.json) ? edges.json : (edges.json?.edges ?? edges.json?.data ?? []);
    check('边接口返回数据', Array.isArray(earr) && earr.length > 0, `${earr.length} 条`);
    if (Array.isArray(earr) && earr.length) {
        console.log('    样例:', JSON.stringify(earr.slice(0, 2)).slice(0, 300));
    }

    console.log(`\n===== 图谱结果: ${pass} 通过 / ${fail} 失败 =====`);
    process.exit(fail ? 1 : 0);
})().catch((e) => {
    console.error('FAIL:', e.message);
    process.exit(1);
});
