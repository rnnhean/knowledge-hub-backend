/**
 * knowledge-hub RAG 问答深度验证（有头浏览器）。
 *
 * 前面的 flow-headed.mjs 只验证了「能进页面」——那是导航测试，不是功能测试。
 * 这个脚本验证真正值钱的东西：
 *   1. 提问后真的走到 RAG 链路（检索 → 重排 → 生成）
 *   2. 回答里带引用标记 [n]
 *   3. 显示了召回的资料列表
 *   4. 会话能保存并回看
 *
 * 任何一步失败就截图，不假装通过。
 */
import { chromium } from 'file:///D:/20260916/.e2e-tools/node_modules/playwright/index.mjs';

const WEB = 'http://localhost:5173';
const SHOTS = 'D:/20260916/knowledge-hub-backend/docs/shots';

let pass = 0, fail = 0;
const check = (n, ok, extra = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '✅' : '❌'} ${n}${extra ? ' — ' + extra : ''}`); };

const browser = await chromium.launch({ headless: false, args: ['--window-size=1440,960'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

try {
    console.log('\n=== 1. 登录 ===');
    await page.goto(WEB, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1500);
    const inputs = page.locator('input');
    await inputs.nth(0).fill('user');
    await inputs.nth(1).fill('123456');
    const btn = page.locator('button').filter({ hasText: /登\s*录/ }).first();
    if (await btn.count()) await btn.click(); else await inputs.nth(1).press('Enter');
    await page.waitForTimeout(5000);
    check('登录成功', (await page.locator('body').innerText()).includes('首页大盘'));

    console.log('\n=== 2. 进入 AI 智能问答 ===');
    await page.locator('.ant-menu-item, aside a, nav a').filter({ hasText: 'AI智能问答' }).first().click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `${SHOTS}/rag-1-问答页.png` });
    const qaText = await page.locator('body').innerText();
    check('问答页已打开', /问答|对话|提问/.test(qaText), qaText.slice(0, 60).replace(/\n/g, ' '));

    console.log('\n=== 3. 提出一个知识库问题 ===');
    // 实际是 AntD 的 <input type="text">（不是 textarea）。
    // 用 placeholder 定位最稳：它直接对应「这是提问框」这个语义。
    const input = page.getByPlaceholder(/例如：|输入问题|请输入/).first();
    const hasInput = await input.count() > 0;
    check('找到输入框', hasInput);
    if (!hasInput) throw new Error('问答页没有输入框');

    await input.click();
    // 问一个**知识库里确实有**的问题。之前用「出差费用超过五千需要谁加签」，
    // 库里没有这条制度，模型正确地拒答「没有相关规定」，测试却把「没引用」判成失败
    // ——那是测试问错了问题，不是产品有问题。
    await input.fill('加签流程是什么？需要哪些人审批？');
    await page.screenshot({ path: `${SHOTS}/rag-2-已输入.png` });
    await input.press('Enter');
    console.log('  已提问，等待 RAG 回答（真实检索 + 生成，可能 30-60 秒）…');

    // 等回答。
    //
    // 别用「body 文本超过 800 字」当判据：左侧会话列表有 19 条时，
    // 页面框架本身就已经 800+ 字，条件会立刻满足，拿到的是**回答还没到**的状态
    // （2026-11-27 实测：数据库里答案带着 [1]，UI 上却断言「没有引用」）。
    // 只盯对话区，并且要求它连续 4 秒不再增长，才算流式结束。
    let answered = false;
    let lastLen = 0;
    let stable = 0;
    let logText = '';
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2000);
        logText = await page.evaluate(() => {
            const el = document.querySelector('.kh-chat-log') || document.body;
            return el.innerText || '';
        });
        if (logText.length > 150 && logText.length === lastLen) {
            if (++stable >= 2) {
                answered = true;
                break;
            }
        } else {
            stable = 0;
            lastLen = logText.length;
        }
        if (i % 5 === 0) console.log(`    等待中… ${(i + 1) * 2}s（对话区 ${logText.length} 字）`);
    }

    const finalText = await page.locator('body').innerText();
    check('收到回答', answered, `对话区 ${logText.length} 字`);
    await page.screenshot({ path: `${SHOTS}/rag-3-回答.png` });

    console.log('\n=== 4. 回答质量检查 ===');
    // 引用在 UI 上渲染成角标元素（.kh-cite-inline），innerText 里没有中括号，
    // 只查文本会误判成「没标引用」——数据库里的答案本身是带 [1] 的。
    const citeCount = await page.evaluate(
        () => document.querySelectorAll('.kh-cite-inline').length,
    );
    check('回答带引用角标', citeCount > 0 || /\[\d\]/.test(finalText), `角标 ${citeCount} 个`);
    check('显示了参考资料', /资料|来源|引用|参考/.test(finalText) || citeCount > 0);
    check('回答与问题相关', /加签|五千|5000|总监|审批/.test(finalText),
        (finalText.match(/加签[^\n]{0,30}/) || [''])[0]);

    console.log('\n=== 5. 会话管理 ===');
    // 会话列表在左侧栏（.kh-chat-session-item），文本里不一定出现「会话/历史」字样
    const sessionCount = await page.evaluate(
        () => document.querySelectorAll('.kh-chat-session-item').length,
    );
    check('出现会话列表', sessionCount > 0, `${sessionCount} 条`);

    // ── 第二步：问一个库里没有的问题，验证「不编造」──
    // 这比「答对」更能说明系统可靠：检索判不足时，模型必须明说没有，
    // 而不是拿常识编一条制度出来。
    console.log('\n=== 6. 防幻觉：问一个知识库里不存在的问题 ===');
    const input2 = page.getByPlaceholder(/例如：|输入问题|请输入/).first();
    await input2.fill('公司年会在几月举办？有哪些活动？');
    await input2.press('Enter');

    let halluText = '';
    let lastH = 0;
    let stableH = 0;
    for (let i = 0; i < 30; i++) {
        await page.waitForTimeout(2000);
        halluText = await page.evaluate(() => {
            const el = document.querySelector('.kh-chat-log') || document.body;
            return el.innerText || '';
        });
        if (halluText.length > lastH + 20) {
            stableH = 0;
        } else if (++stableH >= 2) {
            break;
        }
        lastH = halluText.length;
    }
    await page.screenshot({ path: `${SHOTS}/rag-4-防幻觉.png` });

    const admitsMissing = /没有|未找到|未提及|不包含|无法|暂无/.test(halluText);
    const fabricated = /年会.{0,20}(月|举办|活动|安排).{0,10}([0-9]{1,2}月|举行|开展)/.test(halluText);
    check('无资料时明确说不掌握', admitsMissing && !fabricated, halluText.slice(-80).replace(/\n/g, ' '));

    console.log('\n=== 7. JS 错误 ===');
    const real = errors.filter((e) => !/favicon|ResizeObserver/i.test(e));
    check('无致命 JS 错误', real.length === 0, real.slice(0, 2).join(' | '));
} catch (e) {
    check('流程执行', false, e.message);
    await page.screenshot({ path: `${SHOTS}/rag-error.png` }).catch(() => {});
} finally {
    console.log(`\n===== 结果: ${pass} 通过 / ${fail} 失败 =====`);
    console.log('截图: docs/shots/rag-*.png');
    await browser.close();
    process.exit(fail ? 1 : 0);
}
