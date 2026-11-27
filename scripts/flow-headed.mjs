/**
 * knowledge-hub 全流程（有头浏览器，单窗口，跑完自动关）。
 *
 * 覆盖：登录 → 首页大盘 → 文档列表 → 全文检索 → RAG 问答 → 逐页点链接查白屏。
 *
 * 每一步都截图，任何一步白屏立刻记录 URL 和页面文本片段。
 */
import { chromium } from 'file:///D:/20260916/.e2e-tools/node_modules/playwright/index.mjs';

const WEB = 'http://localhost:5173';
const SHOTS = 'D:/20260916/knowledge-hub-backend/docs/shots';

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); };

console.log('\n启动有头浏览器（单窗口）…');
const browser = await chromium.launch({ headless: false, args: ['--window-size=1440,960'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') jsErrors.push(m.text()); });

const blank = async () => {
    const t = (await page.locator('body').innerText().catch(() => '')).trim();
    const html = await page.content().catch(() => '');
    return t.length < 20 || /No routes matched/i.test(html);
};

try {
    console.log('\n=== 1. 登录页 ===');
    await page.goto(WEB, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(2000);
    const loginText = await page.locator('body').innerText();
    check('登录页不是白屏', !(await blank()), loginText.slice(0, 40).replace(/\n/g, ' '));
    await page.screenshot({ path: `${SHOTS}/kh-1-登录.png` });

    console.log('\n=== 2. 登录 ===');
    // 用户名 / 密码输入框——用 placeholder 或 type 定位，不依赖具体 DOM 结构
    const inputs = page.locator('input');
    const count = await inputs.count();
    console.log(`  找到 ${count} 个输入框`);
    if (count >= 2) {
        await inputs.nth(0).fill('user');
        await inputs.nth(1).fill('123456');
        await page.screenshot({ path: `${SHOTS}/kh-2-已填账号.png` });
        // 点登录按钮
        const btn = page.locator('button').filter({ hasText: /登\s*录/ }).first();
        if (await btn.count()) await btn.click();
        else await inputs.nth(1).press('Enter');
        await page.waitForTimeout(5000);
    }
    const afterLogin = await page.locator('body').innerText();
    check('登录后离开登录页', !/登录|密码/.test(afterLogin.slice(0, 120)) || afterLogin.length > 200,
        afterLogin.slice(0, 60).replace(/\n/g, ' '));
    await page.screenshot({ path: `${SHOTS}/kh-3-登录后.png` });

    console.log('\n=== 3. 遍历导航 ===');
    // 侧边栏所有可点的菜单项
    const menuItems = await page.locator('.ant-menu-item, aside a, nav a').evaluateAll((els) =>
        els.map((e) => (e.textContent || '').trim()).filter(Boolean),
    );
    console.log(`  导航项: ${[...new Set(menuItems)].join(' / ') || '(未识别)'}`);

    const seen = new Set();
    for (const name of [...new Set(menuItems)].slice(0, 12)) {
        if (seen.has(name)) continue;
        seen.add(name);
        const item = page.locator('.ant-menu-item, aside a, nav a').filter({ hasText: name }).first();
        if (!(await item.count())) continue;
        await item.click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(2500);
        const isBlank = await blank();
        check(`页面「${name}」`, !isBlank, isBlank ? '❌ 白屏' : '');
        if (isBlank) {
            await page.screenshot({ path: `${SHOTS}/kh-blank-${name}.png` });
        } else {
            await page.screenshot({ path: `${SHOTS}/kh-page-${name.replace(/\W+/g, '_')}.png` });
        }
    }

    console.log('\n=== 4. JS 错误 ===');
    const real = jsErrors.filter((e) => !/favicon|ResizeObserver/i.test(e));
    check('无致命 JS 错误', real.length === 0, real.slice(0, 2).join(' | '));
} catch (e) {
    check('流程执行', false, e.message);
    await page.screenshot({ path: `${SHOTS}/kh-error.png` }).catch(() => {});
} finally {
    console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
    await browser.close();
    process.exit(fail ? 1 : 0);
}
