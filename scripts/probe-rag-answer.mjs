/**
 * 取 RAG 回答的原始文本 + 会话列表，用于核实「引用标记」和「会话列表」两项断言。
 *
 * 前一个脚本（flow-rag-deep）用 innerText 全文正则判断，容易误判：
 *   - 引用标记可能是上标样式（1 而不是 [1]），innerText 里丢了中括号；
 *   - 会话列表可能是图标 + 悬浮才出现文字，innerText 拿不到。
 * 这里把 DOM 结构和 markdown 渲染后的内容都打出来看。
 */
import { chromium } from 'file:///D:/20260916/.e2e-tools/node_modules/playwright/index.mjs';

const WEB = 'http://localhost:5173';
const browser = await chromium.launch({ headless: false, args: ['--window-size=1440,960'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

try {
    await page.goto(WEB, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1500);
    const inputs = page.locator('input');
    await inputs.nth(0).fill('user');
    await inputs.nth(1).fill('123456');
    const btn = page.locator('button').filter({ hasText: /登\s*录/ }).first();
    if (await btn.count()) await btn.click();
    else await inputs.nth(1).press('Enter');
    await page.waitForTimeout(5000);

    await page
        .locator('.ant-menu-item, aside a, nav a')
        .filter({ hasText: 'AI智能问答' })
        .first()
        .click();
    await page.waitForTimeout(3000);

    const ta = page.getByPlaceholder(/例如：|输入问题|请输入/).first();
    await ta.fill('加签流程是什么？需要哪些人审批？');
    await page.waitForTimeout(500);
    await ta.press('Enter');

    // 等回答稳定：最多 90 秒
    let lastLen = 0;
    let stable = 0;
    for (let i = 0; i < 90; i++) {
        await page.waitForTimeout(1000);
        const len = (await page.locator('body').innerText()).length;
        if (len === lastLen) {
            if (++stable >= 4) break;
        } else {
            stable = 0;
            lastLen = len;
        }
    }

    // 1) 回答区域
    const answerHtml = await page.evaluate(() => {
        // 找含「参考资料」或引用角标的最长块
        const all = [...document.querySelectorAll('div,article,section')];
        const cands = all
            .filter((el) => el.innerText && el.innerText.length > 200)
            .sort((a, b) => b.innerText.length - a.innerText.length);
        return cands[0]
            ? { text: cands[0].innerText.slice(0, 1500), html: cands[0].innerHTML.slice(0, 2500) }
            : null;
    });
    console.log('=== 回答文本前 800 字 ===');
    console.log(answerHtml?.text?.slice(0, 800) ?? '(无)');

    console.log('\n=== 引用相关元素 ===');
    const cite = await page.evaluate(() => {
        const out = [];
        for (const el of document.querySelectorAll('*')) {
            const t = (el.textContent || '').trim();
            if (/^\[?\d{1,2}\]?$/.test(t) && el.children.length === 0) {
                out.push({ tag: el.tagName, cls: el.className, text: t });
            }
        }
        return out.slice(0, 12);
    });
    console.log(JSON.stringify(cite, null, 1));

    console.log('\n=== 会话列表项 ===');
    const sessions = await page.evaluate(() => {
        const out = [];
        const items = document.querySelectorAll(
            '[class*=session], [class*=conversation], [class*=history], aside li, .ant-list-item',
        );
        for (const el of items) {
            const t = (el.innerText || '').trim().slice(0, 50);
            if (t) out.push({ cls: String(el.className).slice(0, 50), text: t });
        }
        return out.slice(0, 15);
    });
    console.log(JSON.stringify(sessions, null, 1));

    await page.screenshot({ path: 'D:/20260916/knowledge-hub-backend/docs/shots/rag-probe.png' });
    console.log('\n截图: docs/shots/rag-probe.png');
} catch (e) {
    console.error('FAIL:', e.message);
} finally {
    await browser.close();
}
