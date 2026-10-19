// 错题本插件自测（node scripts/selftest.cjs）：
//   1. problems.ts 纯函数（HTML转文本/参数计数/case分组/文件生成）
//   2. 真实拉取 two-sum 题目详情（leetcode.cn 公开接口）
//   3. 生成题目文件（注入解法模拟"用户写完"）+ node.py 自举
//   4. python3 直跑驱动：3 个示例用例全部执行
//   5. DAP 全链路（真实 debugpy）：自然命中断点 → 逐步抓变量 → RESULTS 采集
//   6. 提交错误路径：cookie 失效时 submitCode 必须抛 COOKIE_EXPIRED
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const TESTDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lmt-selftest-'));

// ---- vscode stub：out/*.js 只用到这几个 API ----
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') { return path.join(__dirname, 'vscode-stub.cjs'); }
    return origResolve.call(this, request, ...args);
};
process.env.LMT_TEST_PROBLEMS_ROOT = TESTDIR;
const { fetchQuestionDetail, submitCode } = require(path.join(ROOT, 'out/leetcode.js'));
const probs = require(path.join(ROOT, 'out/problems.js'));
const { DRIVER_SOURCE, driverDoneLine } = require(path.join(ROOT, 'out/debug.js'));
const { findBodyLine } = require(path.join(ROOT, 'out/visualize.js'));

let failed = 0;
const ok = (cond, name, extra = '') => {
    console.log(`${cond ? '✅' : '❌'} ${name}${extra ? ' · ' + extra : ''}`);
    if (!cond) { failed++; }
};
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEBUGPY_LIBS = '/Users/liuqiang/.vscode/extensions/ms-python.debugpy-2026.6.0-darwin-arm64/bundled/libs';
// macOS：DAP 报告的路径带 /private 前缀（与插件 visualize.ts 的 norm 同理）
const norm = p => String(p || '').replace(/^\/private\//, '/');
const SOLUTION = `class Solution:
    def twoSum(self, nums: list[int], target: int) -> list[int]:
        v2i = {}
        for idx, num in enumerate(nums):
            pre = target - num
            if pre in v2i:
                return [v2i[pre], idx]
            v2i[num] = idx
        return [-1, -1]`;

// —— 极简 DAP 客户端（Content-Length 分帧；请求 10s 超时；先订阅事件再发请求）——
let dseq = 1;
const pending = new Map();
const eventHandlers = [];
let dbuf = Buffer.alloc(0);

function dapConnect(port) {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, '127.0.0.1', () => resolve(sock));
        sock.on('error', reject);
        sock.on('data', chunk => {
            dbuf = Buffer.concat([dbuf, chunk]);
            while (true) {
                const idx = dbuf.indexOf('\r\n\r\n');
                if (idx < 0) { break; }
                const m = dbuf.slice(0, idx).toString().match(/Content-Length:\s*(\d+)/i);
                if (!m) { throw new Error('bad DAP header'); }
                const len = Number(m[1]);
                if (dbuf.length < idx + 4 + len) { break; }
                const msg = JSON.parse(dbuf.slice(idx + 4, idx + 4 + len).toString());
                dbuf = dbuf.slice(idx + 4 + len);
                if (msg.type === 'response') {
                    const p = pending.get(msg.request_seq);
                    if (p) { pending.delete(msg.request_seq); msg.success ? p.resolve(msg) : p.reject(new Error(`${msg.command}: ${msg.message}`)); }
                } else if (msg.type === 'event') { eventHandlers.forEach(h => h(msg)); }
            }
        });
    });
}
function dapSend(sock, command, args = {}) {
    const s = dseq++;
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(s); reject(new Error(`${command} 无响应(10s)`)); }, 10_000);
        pending.set(s, { resolve: v => { clearTimeout(timer); resolve(v); }, reject: e => { clearTimeout(timer); reject(e); } });
        const body = JSON.stringify({ seq: s, type: 'request', command, arguments: args });
        sock.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
    });
}
function waitEvent(pred, timeoutMs) {
    return new Promise(resolve => {
        const timer = setTimeout(() => done(null), timeoutMs);
        const h = e => { if (pred(e)) { done(e); } };
        function done(v) { clearTimeout(timer); const i = eventHandlers.indexOf(h); if (i >= 0) { eventHandlers.splice(i, 1); } resolve(v); }
        eventHandlers.push(h);
    });
}

(async () => {
    /* ========== 1. 纯函数 ========== */
    ok(probs.htmlToText('<p>a&nbsp;&lt;b</p><ul><li>x</li></ul>').includes('a <b') && probs.htmlToText('<p>a&nbsp;&lt;b</p><ul><li>x</li></ul>').includes('• x'), 'htmlToText 基本转换');
    ok(probs.parseParamCount(SOLUTION) === 2, 'parseParamCount two-sum = 2', `实际 ${probs.parseParamCount(SOLUTION)}`);
    ok(probs.parseParamCount('class Solution:\n    def f(self, a: dict[str, int], b: list[int]) -> None:\n        pass') === 2, 'parseParamCount 嵌套逗号注解 = 2');
    ok(probs.parseParamCount('def addTwoNumbers(self, l1: Optional[ListNode], l2: Optional[ListNode]) -> Optional[ListNode]:') === 2, 'parseParamCount Optional[ListNode] = 2');

    /* ========== 2. 真实拉题 ========== */
    const qd = await fetchQuestionDetail('two-sum');
    ok(qd.questionId === '1' && qd.frontendId === '1', 'fetchQuestionDetail questionId', `qid=${qd.questionId}`);
    ok(qd.python3.includes('class Solution') && qd.python3.includes('twoSum'), 'python3 模板');
    ok(qd.exampleTestcases.includes('[2,7,11,15]'), 'exampleTestcases');

    /* ========== 3. 生成题目文件（注入解法） ========== */
    const cases = probs.casesOf(qd);
    ok(cases.length === 3, 'casesOf 分组 = 3 个用例', cases.join(' ; '));
    let content = probs.buildFileContent(qd);
    content = content.replace(qd.python3.trimEnd(), SOLUTION);
    const cn = probs.ensureDirs();
    const solPath = path.join(cn, '1.two-sum.py');
    fs.writeFileSync(solPath, content, 'utf8');
    ok(fs.existsSync(path.join(TESTDIR, 'leetcode', 'editor', 'common', 'node.py')), 'node.py 自举');
    ok(content.includes('# @lcpr case=start') && content.includes('# @lc code=start'), '文件格式 labuladong 兼容');
    const bpLine = findBodyLine(content);
    ok(bpLine > 0 && content.split('\n')[bpLine - 1].trim() === 'v2i = {}', 'findBodyLine 指向方法体首行',
        `line ${bpLine} = ${JSON.stringify(content.split('\n')[bpLine - 1])}`);

    /* ========== 4. 直跑驱动 ========== */
    const driver = path.join(TESTDIR, 'debug_driver.py');
    fs.writeFileSync(driver, DRIVER_SOURCE, 'utf8');
    const run = await new Promise(resolve => {
        const p = spawn('python3', [driver, solPath], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        p.on('close', code => resolve({ code, out }));
    });
    ok(run.code === 0 && run.out.includes('case 1:') && run.out.trim().split('\n').filter(l => l.startsWith('case')).length === 3,
        '驱动直跑 3 用例', run.out.replace(/\n/g, ' | ').slice(0, 160));
    // 指定 case 序号 → 只跑该用例（CodeLens 单用例回放的驱动侧行为）
    const runOne = await new Promise(resolve => {
        const p = spawn('python3', [driver, solPath, '2'], { stdio: ['ignore', 'pipe', 'pipe'] });
        let out = '';
        p.stdout.on('data', d => { out += d; });
        p.stderr.on('data', d => { out += d; });
        p.on('close', code => resolve({ code, out }));
    });
    const caseLines = runOne.out.trim().split('\n').filter(l => l.startsWith('case'));
    ok(runOne.code === 0 && caseLines.length === 1 && runOne.out.includes('case 2:'),
        '驱动指定 case=2 只跑该用例', runOne.out.replace(/\n/g, ' | ').slice(0, 160));

    /* ========== 5. DAP 全链路（复刻插件可视化录制） ========== */
    const port = 18000 + Math.floor(Math.random() * 4000);
    const proc = spawn('python3', ['-m', 'debugpy', '--listen', `127.0.0.1:${port}`, '--wait-for-client', driver, solPath],
        { env: { ...process.env, PYTHONPATH: DEBUGPY_LIBS }, stdio: ['ignore', 'pipe', 'pipe'] });
    const killTimer = setTimeout(() => { proc.kill('SIGKILL'); console.log('!! 总超时'); process.exit(1); }, 60_000);
    await sleep(800);
    let sock;
    for (let i = 0; i < 15; i++) { try { sock = await dapConnect(port); break; } catch { await sleep(500); } }
    if (!sock) { throw new Error('连不上 debugpy'); }

    const initialized = waitEvent(e => e.event === 'initialized', 10_000);
    await dapSend(sock, 'initialize', { adapterID: 'test', linesStartAt1: true });
    const attachP = dapSend(sock, 'attach', { justMyCode: true }).catch(() => undefined);
    if (!await initialized) { throw new Error('没等到 initialized'); }
    const bpResp = await dapSend(sock, 'setBreakpoints', { source: { path: solPath }, lines: [bpLine], breakpoints: [{ line: bpLine }] });
    ok(bpResp.body.breakpoints[0].verified === true, '断点 verified');
    await dapSend(sock, 'configurationDone', {});
    await attachP;

    const stopped1 = await waitEvent(e => e.event === 'stopped', 15_000);
    ok(!!stopped1 && stopped1.body.reason === 'breakpoint', '自然命中断点（不发 continue）', `reason=${stopped1?.body.reason}`);
    const th = await dapSend(sock, 'threads', {});
    const threadId = th.body.threads[0].id;

    let sawV2i = false; let steps = 0;
    for (let i = 0; i < 8; i++) {
        const st = await dapSend(sock, 'stackTrace', { threadId, startFrame: 0, levels: 30 });
        const top = st.body.stackFrames.find(f => norm(f.source.path) === norm(solPath));
        if (!top) { break; }
        const sc = await dapSend(sock, 'scopes', { frameId: top.id });
        const ls = sc.body.scopes.find(s => /local/i.test(s.name));
        const vars = await dapSend(sock, 'variables', { variablesReference: ls.variablesReference });
        const locals = vars.body.variables.map(v => `${v.name}=${v.value}`).join(' | ');
        if (locals.includes('v2i={')) { sawV2i = true; }
        steps++;
        const nx = waitEvent(e => e.event === 'stopped', 8000);
        await dapSend(sock, 'next', { threadId });
        if (!await nx) { break; }
    }
    ok(steps >= 5 && sawV2i, `逐步录制 ${steps} 步且抓到 v2i`);

    const rline = driverDoneLine();
    ok(rline > 0, 'driverDoneLine', `line=${rline}`);
    await dapSend(sock, 'setBreakpoints', { source: { path: driver }, lines: [rline], breakpoints: [{ line: rline }] });
    let lastResults = '';
    for (let round = 0; round < 6; round++) {
        const stop = waitEvent(e => e.event === 'stopped', 10_000);
        await dapSend(sock, 'continue', { threadId });
        if (!await stop) { break; }
        const st = await dapSend(sock, 'stackTrace', { threadId, startFrame: 0, levels: 5 });
        const top = st.body.stackFrames[0];
        if (norm(top.source.path) === norm(driver) && top.line === rline) {
            const ev = await dapSend(sock, 'evaluate', { expression: 'RESULTS', frameId: top.id });
            lastResults = ev.body.result;
            break;
        }
    }
    ok(lastResults.includes("'case': 3") || lastResults.includes("case': 3"), 'RESULTS 采集到第 3 个用例', lastResults.slice(0, 100));
    try { await dapSend(sock, 'disconnect', {}); } catch { /* ignore */ }
    clearTimeout(killTimer);
    proc.kill();

    /* ========== 6. 提交错误路径（cookie 服务端作废 → COOKIE_EXPIRED） ========== */
    const settingsPath = path.join(os.homedir(), 'Library/Application Support/Code/User/settings.json');
    const mm = /"lmt\.leetcodeCookie"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(fs.readFileSync(settingsPath, 'utf8'));
    if (mm) {
        const cookie = JSON.parse(`"${mm[1]}"`);
        // 先探登录态：cookie 有效就跳过（避免真实提交污染账号）；失效才验证 403→COOKIE_EXPIRED 映射
        let valid = false;
        try {
            const v = await fetch('https://leetcode.cn/graphql/', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Referer': 'https://leetcode.cn', 'Cookie': cookie, 'User-Agent': 'lmt-selftest' },
                body: JSON.stringify({ query: '{ user { username } }', variables: {} })
            });
            valid = !!(await v.json())?.data?.user?.username;
        } catch { /* 网络问题按失效处理 */ }
        if (valid) {
            console.log('⏭ cookie 当前有效，跳过失效路径（避免真实提交）');
        } else {
            let err = '';
            try { await submitCode('two-sum', '1', SOLUTION, 'python3', cookie); }
            catch (e) { err = e.message; }
            ok(err === 'COOKIE_EXPIRED', 'submitCode 失效 cookie → COOKIE_EXPIRED', `err=${err}`);
        }
    } else {
        console.log('⏭ 未配置 cookie，跳过提交错误路径');
    }

    /* ========== 6.5 判定详情提取（verdictDetail：RE 栈 / WA 用例三件套 / 仅状态文案） ========== */
    const vd = require(path.join(ROOT, 'out/leetcode.js')).verdictDetail;
    const re = vd({ status_msg: 'Runtime Error', full_runtime_error: 'Traceback (most recent call last):\n  File "solution.py", line 5, in maxArea\nValueError: invalid literal for int() with base 10: \'x\'' });
    ok(re.brief === "ValueError: invalid literal for int() with base 10: 'x'", 'verdictDetail RE 摘要=栈末行', re.brief);
    ok((re.failInfo ?? '').includes('Traceback') && (re.failInfo ?? '').includes('Runtime Error'), 'verdictDetail RE 全文含栈与状态', re.failInfo);
    const wa = vd({ status_msg: 'Wrong Answer', input: '[1,8,6,2,5,4,8,3,7]', code_answer: ['48'], expected_code_answer: ['49'], total_correct: 3 });
    ok((wa.brief ?? '').includes('第 4 个用例') && (wa.brief ?? '').includes('48') && (wa.brief ?? '').includes('49'), 'verdictDetail WA 摘要含用例序号与输出对比', wa.brief);
    ok((wa.failInfo ?? '').split('\n').length >= 6, 'verdictDetail WA 全文=输入/期望/实际三件套', wa.failInfo);
    const plain = vd({ status_msg: 'Time Limit Exceeded' });
    ok(plain.brief === 'Time Limit Exceeded' && plain.failInfo === 'Time Limit Exceeded', 'verdictDetail 无详情时退回状态文案', plain.brief);
    ok(Object.keys(vd({})).length === 0, 'verdictDetail AC/空响应 = 空对象');

    /* ========== 7. 题单：导入解析引擎 + 存储 + 统一题单树 ========== */
    const listsMod = require(path.join(ROOT, 'out/lists.js'));
    const { ProblemListsTree, rangesOf } = require(path.join(ROOT, 'out/treeView.js'));
    const { aiConfigured } = require(path.join(ROOT, 'out/ai.js'));

    /* ========== 6.5 AI 提示词：内置默认要素 + 自定义覆盖/回落 ========== */
    {
        const ai = require(path.join(ROOT, 'out/ai.js'));
        const def = ai.DEFAULT_AI_PROMPT;
        ok(def.includes('syntax') && def.includes('boundary') && def.includes('complexity') && def.includes('logic'), '默认提示词含五类错误类型');
        ok(def.includes('summary') && def.includes('fixHint') && def.includes('JSON'), '默认提示词约定 {type,summary,fixHint} JSON 输出');
        ok(def.includes('判定要点') && def.includes('后来通过的代码'), '默认提示词含反例代入与 diff 归因指引');
        ok(ai.systemPrompt() === def, '未配置 lmt.aiPrompt → 用内置默认');
        process.env.LMT_TEST_AI_PROMPT = '  自定义教练提示词  ';
        ok(ai.systemPrompt().startsWith('自定义教练提示词'), '配置 lmt.aiPrompt → 整体替换（trim 生效）');
        delete process.env.LMT_TEST_AI_PROMPT;
        ok(ai.systemPrompt() === def, '清空配置 → 回落内置默认');
    }

    // 迷你题库（与 allQuestions.json 缓存行结构一致；难度用真实缓存的大小写混合格式锁定 diffKey 归一）
    const MINI = [
        [1, 'two-sum', '两数之和', 'Easy'],
        [15, '3sum', '三数之和', 'Medium'],
        [20, 'valid-parentheses', '有效的括号', 'Easy'],
        [206, 'reverse-linked-list', '反转链表', 'EASY'],
        [42, 'trapping-rain-water', '接雨水', 'Hard']
    ];
    const metas = MINI.map(a => ({ qid: a[0], slug: a[1], title: a[2], difficulty: a[3] }));

    // 混合格式：markdown 列表 / 裸题号 / URL / 裸 slug / 英文题名 / 题号+题名 / 表格行 / 乱写行 / 注释与分隔线
    const text1 = [
        '# 高频题清单', '',
        '---',
        '- 1. 两数之和',
        '- 15',
        '- https://leetcode.cn/problems/valid-parentheses/description/',
        'two-sum',
        'Two Sum',
        '206. 反转链表',
        '这行是乱写的凑数',
        '| 42 | 接雨水 |'
    ].join('\n');
    const r1 = listsMod.parseListInput(text1, metas);
    ok(JSON.stringify(r1.slugs) === JSON.stringify(['two-sum', '3sum', 'valid-parentheses', 'reverse-linked-list', 'trapping-rain-water']),
        'parseListInput 混合格式（含去重/URL/英文题名/表格行）', `slugs=[${r1.slugs}] unresolved=[${r1.unresolved}]`);
    ok(r1.unresolved.length === 1 && r1.unresolved[0].includes('乱写'), '未识别行如实上报', r1.unresolved.join(','));

    // JSON 数组：数字 / 字符串 / {qid} / {title}
    const r2 = listsMod.parseListInput('[1, "valid-parentheses", {"qid": 15}, {"title": "接雨水"}]', metas);
    ok(JSON.stringify(r2.slugs) === JSON.stringify(['two-sum', 'valid-parentheses', '3sum', 'trapping-rain-water']),
        'parseListInput JSON 数组', r2.slugs.join(','));

    // 作者自编号（"2." 是序号不是题号）：题名必须优先于题号
    const r3 = listsMod.parseListInput('- 2. 接雨水\n- 9. 两数之和', metas);
    ok(JSON.stringify(r3.slugs) === JSON.stringify(['trapping-rain-water', 'two-sum']), '题名优先于作者序号', r3.slugs.join(','));

    // 一行连排（从聊天/PDF 复制丢了换行）：顿号 / 连写序号 / 空格分隔都要拆开识别
    const r4 = listsMod.parseListInput('两数之和、三数之和、有效的括号', metas);
    ok(JSON.stringify(r4.slugs) === JSON.stringify(['two-sum', '3sum', 'valid-parentheses']) && r4.unresolved.length === 0,
        '顿号连排一行拆开识别', `slugs=[${r4.slugs}] miss=[${r4.unresolved}]`);
    const r5 = listsMod.parseListInput('1. 两数之和 2. 接雨水', metas);
    ok(JSON.stringify(r5.slugs) === JSON.stringify(['two-sum', 'trapping-rain-water']),
        '连写序号一行（不能静默只导第 1 题）', r5.slugs.join(','));
    const r6 = listsMod.parseListInput('146 206 25', metas);
    ok(JSON.stringify(r6.slugs) === JSON.stringify(['reverse-linked-list']) && r6.unresolved.join() === '146,25',
        '空格连排题号一行', `slugs=[${r6.slugs}] miss=[${r6.unresolved}]`);
    ok(listsMod.parseListInput('热题 100 必刷清单', metas).unresolved.length === 1,
        '整行拆不出任何题 → 仍按 1 行报未识别');

    // 存储回环 + 空目录
    const listDir = path.join(TESTDIR, 'lists-dir');
    listsMod.saveLists(listDir, [
        { id: 'a', name: '高频', items: ['two-sum', '3sum'], createdAt: 1 },
        { id: 'b', name: '二刷', items: [], createdAt: 2 }
    ]);
    const loaded = listsMod.loadLists(listDir);
    ok(loaded.length === 2 && loaded[0].items.length === 2, 'saveLists/loadLists 回环');
    ok(listsMod.loadLists(path.join(TESTDIR, '不存在目录')).length === 0, 'loadLists 空目录 = []');

    // rangesOf 分块（须先按题号排序，size=2）
    const sorted5 = [...metas].sort((a, b) => a.qid - b.qid);
    ok(JSON.stringify(rangesOf(sorted5, 2)) === JSON.stringify([[1, 15], [20, 42], [206, 206]]), 'rangesOf 每 2 题一块');

    // 统一题单树：根 6 区块 → 我的题单（LeetCode 收藏夹）→ 收藏的题单 → 导入题单 → 热题 100 → 难度分类 → 全部题目
    const treeDir = path.join(TESTDIR, 'tree-dir');
    fs.mkdirSync(treeDir, { recursive: true });
    fs.writeFileSync(path.join(treeDir, 'allQuestions.json'), JSON.stringify(MINI));
    listsMod.saveLists(treeDir, [{ id: 'a', name: '高频', items: ['two-sum', 'trapping-rain-water', 'no-such-slug'], createdAt: 1 }]);
    // LeetCode 侧题单缓存（favorites.json / favItems.json，结构与 extension.ts 写入的一致）
    fs.writeFileSync(path.join(treeDir, 'favorites.json'), JSON.stringify({
        at: Date.now(),
        created: [
            { slug: 'NBuzkIaQ', name: '我的收藏', favoriteType: 'NORMAL', isPublic: false },
            { slug: 'fGdQf8Mp', name: 'zy的题库', favoriteType: 'SMART_LIST', isPublic: false }
        ],
        collected: [{ slug: 'shopee', name: 'Shopee', favoriteType: 'COMPANY_FAVORITE', isPublic: true }]
    }));
    fs.writeFileSync(path.join(treeDir, 'favItems.json'), JSON.stringify({
        NBuzkIaQ: {
            at: Date.now(),
            questions: [
                { qid: 1, slug: 'two-sum', title: '两数之和', difficulty: 'EASY', status: 'SOLVED' },
                { qid: 42, slug: 'trapping-rain-water', title: '接雨水', difficulty: 'HARD', status: 'ATTEMPTED' },
                { qid: 15, slug: '3sum', title: '三数之和', difficulty: 'MEDIUM', status: 'TO_DO' }
            ]
        }
    }));
    const ptree = new ProblemListsTree({
        load: () => [{ qid: 1, slug: 'two-sum', title: '两数之和', difficulty: 'EASY', attempts: [{ ts: 1, status: 'AC' }], errorTypes: [] }]
    }, treeDir);
    // 无 Cookie：我的题单给一键续期入口，不空指针
    const noCookieRoot = ptree.getChildren();
    const mineNoCk = ptree.getChildren(noCookieRoot[0]);
    ok(mineNoCk.length === 1 && mineNoCk[0].meta.cmd === 'lmt.refreshCookie', '无 Cookie → 我的题单给一键续期入口');
    process.env.LMT_TEST_COOKIE = 'csrftoken=x; LEETCODE_SESSION=y';
    const root = ptree.getChildren();
    ok(root.length === 6 && root.map(x => x.label).join('/') === '我的题单/收藏的题单/导入题单/热题 100/难度分类/全部题目',
        '树根 6 个区块', root.map(x => x.label).join('/'));
    const mine = ptree.getChildren(root[0]);
    ok(mine.length === 2 && mine[0].contextValue === 'favList' && mine[0].label === '我的收藏' && mine[0].description === '1/3'
        && mine[1].label === 'zy的题库' && mine[1].description === '展开加载',
        '我的题单 = LeetCode 收藏夹（done/total + 未拉题目的显示展开加载）', mine.map(m => `${m.label}:${m.description}`).join(','));
    const favItems = ptree.getChildren(mine[0]);
    ok(favItems.length === 3 && favItems[0].description === '一次通过' && favItems[1].description === '远端尝试过 · 困难'
        && favItems[2].description === '未做 · 中等' && favItems.every(i => i.contextValue === 'problem'),
        '收藏夹题目（本地记录优先，远端进度兜底）', favItems.map(i => i.description).join(','));
    const collected = ptree.getChildren(root[1]);
    ok(collected.length === 1 && collected[0].label === 'Shopee' && collected[0].contextValue === 'favList',
        '收藏的题单（企业/他人题单）', collected.map(c => c.label).join(','));
    const imports = ptree.getChildren(root[2]);
    ok(imports.length === 1 && imports[0].contextValue === 'list' && imports[0].description === '1/3', '导入题单节点 done/total');
    const listItems = ptree.getChildren(imports[0]);
    ok(listItems.length === 3 && listItems[0].contextValue === 'problemInList' && listItems[0].description === '一次通过'
        && listItems[2].description === '题库外', '题单子节点（AC 状态 + 题库外兜底）', listItems.map(i => i.description).join(','));
    ok(ptree.getChildren(root[3]).length > 0, '热题 100 分组仍在');
    const diff = ptree.getChildren(root[4]);
    ok(diff.length === 3 && diff.map(d => d.label).join() === '简单,中等,困难' && root[4].description === '简 3 · 中 1 · 困 1',
        '难度分类 3 档带计数（大小写混合难度归一）', root[4].description);
    const easy = ptree.getChildren(diff[0]);
    ok(easy.length === 3 && easy.every(e => e.contextValue === 'problem' && e.command?.command === 'lmt.startProblem'),
        '简单档 3 题且点击=打开题目', easy.map(e => e.label).join(','));
    const allSec = ptree.getChildren(root[5]);
    ok(allSec[0].meta.kind === 'placeholder' && allSec[0].meta.cmd === 'lmt.startProblem' && allSec.length === 2,
        '全部题目：首节点=搜索 + 1 个区间（5 题）', allSec.map(x => x.label).join(' | '));
    const rangeItems = ptree.getChildren(allSec[1]);
    ok(rangeItems.length === 5, '区间展开 5 题');
    delete process.env.LMT_TEST_COOKIE;

    // aiConfigured（桩未配置 → false）
    ok(aiConfigured() === false, 'aiConfigured 未配置 = false');

    /* ========== 7.5 仪表盘统计口径切换（0.17：题单下拉过滤重算） ========== */
    const { renderDashboard } = require(path.join(ROOT, 'out/dashboard.js'));
    const dashHtml = renderDashboard(
        { load: () => [
            { qid: 1, slug: 'two-sum', title: '两数之和', difficulty: 'EASY', attempts: [{ ts: 100, status: 'AC' }], errorTypes: ['logic'] },
            { qid: 42, slug: 'trapping-rain-water', title: '接雨水', difficulty: 'HARD',
              attempts: [{ ts: 50, status: 'WA' }, { ts: 200, status: 'AC' }], errorTypes: ['boundary'] }
        ] },
        { data: () => [{ qid: 1, slug: 'two-sum', title: '两数之和', difficulty: 'EASY', group: '哈希' }] },
        [{ id: 'list:a', group: '导入题单', name: '高频', slugs: ['two-sum'], total: 5 }]);
    ok(dashHtml.includes('统计口径') && dashHtml.includes('optgroup'), '仪表盘带口径下拉');
    // 内嵌脚本在 DOM 桩上真实执行一遍：默认=全部 → 切到导入题单 → 数字跟着变
    const script = /<script>([\s\S]*?)<\/script>/.exec(dashHtml)[1];
    const els = {};
    const mkEl = () => ({ value: '', label: '', textContent: '', innerHTML: '', onchange: null,
        appendChild(c) { this.children.push(c); }, append(...cs) { this.children.push(...cs); }, children: [] });
    global.document = {
        getElementById: id => (els[id] ??= mkEl()),
        createElement: () => mkEl()
    };
    try {
        new Function(script)();
        ok(els.cards.innerHTML.includes('已做题数') && els.recent.innerHTML.includes('接雨水'),
            '默认口径=全部（含 Top100 进度卡）', els.cards.innerHTML.slice(0, 120));
        els.scope.value = 'list:a';
        els.scope.onchange();
        ok(els.cards.innerHTML.includes('题单进度') && els.cards.innerHTML.includes('1/5')
            && !els.recent.innerHTML.includes('接雨水') && els.recent.innerHTML.includes('两数之和'),
            '切到导入题单：进度卡 1/5 且最近提交只剩题单内的题', els.cards.innerHTML.slice(0, 120));
    } finally { delete global.document; }

    // ---- 8. 题目文件识别（0.12.1：@lc 标记兜底 + 文件名 trim）----
    const { lcMarkerQid } = require(path.join(ROOT, 'out/extension.js'));
    const gp = require(path.join(ROOT, 'out/leetcode.js')).guessProblemFromFileName;
    const markerDir = path.join(TESTDIR, 'marker-dir');
    fs.mkdirSync(markerDir, { recursive: true });
    const mk = (name, head) => { const p = path.join(markerDir, name); fs.writeFileSync(p, head, 'utf8'); return p; };
    ok(lcMarkerQid(mk('1.two-sum.py', '#\n# @lc app=leetcode.cn id=1 lang=python3\n#\n# [1] 两数之和\nclass Solution: pass\n')) === 1,
        'lcMarkerQid 读到 @lc 标记题号');
    ok(lcMarkerQid(mk('plain.py', 'x = 1\n')) === undefined, 'lcMarkerQid 无标记 = undefined');
    ok(lcMarkerQid(path.join(markerDir, '不存在.py')) === undefined, 'lcMarkerQid 文件不存在不炸');
    ok(gp('/x/1.two-sum.py')?.slug === 'two-sum' && gp('/x/15.py')?.qid === 15, 'guess 常规文件名');
    ok(lcMarkerQid(mk('BinaryTreePreorderTraversal .py', '# @lc app=leetcode.cn id=144 lang=python3\n') ) === 144,
        '带空格旧文件名：guess 认不出但标记兜底拿到 qid=144');

    // ---- 9. 从零安装自举（0.13.1：无任何配置时默认 ~/leetcode/editor/cn，首次打开题目自动建目录链 + node.py）----
    const probs2 = require(path.join(ROOT, 'out/problems.js'));
    const freshRoot = path.join(TESTDIR, 'fresh-root');   // 模拟一个空环境（等价于 ~ 下什么都没有）
    process.env.LMT_TEST_PROBLEMS_ROOT = freshRoot;
    ok(probs2.problemsRoot() === freshRoot, 'problemsRoot 读 lmt.problemsDir');
    delete process.env.LMT_TEST_PROBLEMS_ROOT;
    ok(probs2.problemsRoot() === require('os').homedir(), '未配置时默认 ~（→ ~/leetcode/editor/cn，固定不随工作区漂移）');
    process.env.LMT_TEST_PROBLEMS_ROOT = freshRoot;
    const qd2 = {
        questionId: '1', frontendId: '1', title: '两数之和', difficulty: 'EASY',
        descHtml: '<p>给定整数数组</p>', python3: 'class Solution:\n    def twoSum(self, nums, target):\n        pass\n',
        exampleTestcases: '2 7 11 15\n9', sampleTestCase: '2 7 11 15\n9'
    };
    const f = probs2.openOrCreate(qd2, 'two-sum');
    ok(f.startsWith(freshRoot) && f.endsWith('1.two-sum.py'), 'openOrCreate 落在 problemsDir 的 cn 目录', f);
    ok(fs.existsSync(path.join(freshRoot, 'leetcode', 'editor', 'cn', '1.two-sum.py')), '目录链 leetcode/editor/cn 自动创建');
    ok(fs.readFileSync(path.join(freshRoot, 'leetcode', 'editor', 'common', 'node.py'), 'utf8').includes('class ListNode'), 'common/node.py 自动内置（链表/树开箱即用）');
    const gen = fs.readFileSync(f, 'utf8');
    ok(gen.includes('# @lc app=leetcode.cn id=1') && gen.includes('# @lc code=start') && gen.includes('# @lcpr case=start'),
        '生成文件带 @lc 标记 + code 区 + case 用例块');
    ok(probs2.openOrCreate(qd2, 'two-sum') === f, '重复打开同一题不重建');
    ok(probs2.listProblemFiles().includes(f), 'listProblemFiles 能列出新生成的文件');
    delete process.env.LMT_TEST_PROBLEMS_ROOT;

    // ---- 9.5 历史文件补题干（0.15.5：openOrCreate 命中已存在文件时回填 docstring，解法代码不动）----
    const bfRoot = path.join(TESTDIR, 'bf-root');
    fs.mkdirSync(path.join(bfRoot, 'leetcode', 'editor', 'cn'), { recursive: true });
    process.env.LMT_TEST_PROBLEMS_ROOT = bfRoot;
    // labuladong codeonly 老格式（无题干、code 标记在行首）
    const oldA = ['#', '# @lc app=leetcode.cn id=1 lang=python3', '# @lcpr version=30404', '#', '# [1] 两数之和', '#', '', '# @lc code=start', SOLUTION, '# @lc code=end', ''].join('\n');
    fs.writeFileSync(path.join(bfRoot, 'leetcode/editor/cn/1.two-sum.py'), oldA, 'utf8');
    ok(probs2.openOrCreate(qd2, 'two-sum').endsWith('1.two-sum.py'), 'openOrCreate 命中已存在文件');
    const bfA = fs.readFileSync(path.join(bfRoot, 'leetcode/editor/cn/1.two-sum.py'), 'utf8');
    ok(bfA.includes('"""\n给定整数数组\n"""') && bfA.indexOf('"""') < bfA.indexOf('# @lc code=start'), '老格式补题干：docstring 插在 code 区之前');
    ok(bfA.includes(SOLUTION) && bfA.trimEnd().endsWith('# @lc code=end'), '解法代码原样保留');
    ok(probs2.backfillDesc(path.join(bfRoot, 'leetcode/editor/cn/1.two-sum.py'), qd2.descHtml) === false, '重复补写 = 幂等跳过');
    // 更老格式：code 标记缩进在类里 → 题干插到文件头注释块之后，不动类内缩进
    const oldB = ['#', '# @lc app=leetcode.cn id=21 lang=python3', '#', '# [21] 合并两个有序链表', '#', '', 'import sys', '', 'class MergeTwoSortedLists:', '    # @lc code=start', '    class Solution:', '        pass', '    # @lc code=end', ''].join('\n');
    const bfBPath = path.join(bfRoot, 'leetcode/editor/cn/merge-two-sorted-lists.py');
    fs.writeFileSync(bfBPath, oldB, 'utf8');
    ok(probs2.backfillDesc(bfBPath, '<p>将两个升序链表合并</p>') === true, '缩进标记文件补写成功');
    const bfB = fs.readFileSync(bfBPath, 'utf8');
    ok(bfB.indexOf('"""') < bfB.indexOf('import sys') && bfB.includes('    # @lc code=start'), '缩进标记：题干在文件头注释块后，标记行不动');
    // 无 @lc 标记散文件：题干放最前；空题面不动文件
    const pNoMark = path.join(bfRoot, 'leetcode/editor/cn/plain.py');
    fs.writeFileSync(pNoMark, 'from typing import *\n\nclass Solution:\n    pass\n', 'utf8');
    ok(probs2.backfillDesc(pNoMark, '<p>题目甲</p>') === true && fs.readFileSync(pNoMark, 'utf8').startsWith('"""\n题目甲'), '无标记文件：题干放最前');
    const pEmpty = path.join(bfRoot, 'leetcode/editor/cn/empty-desc.py');
    fs.writeFileSync(pEmpty, '# @lc code=start\nclass Solution:\n    pass\n', 'utf8');
    ok(probs2.backfillDesc(pEmpty, '') === false && fs.readFileSync(pEmpty, 'utf8') === '# @lc code=start\nclass Solution:\n    pass\n', '空题面不动文件');
    delete process.env.LMT_TEST_PROBLEMS_ROOT;

    // ---- 10. 代码内悬浮按钮（CodeLens）锚点（0.14.0）----
    const { problemLensAnchor } = require(path.join(ROOT, 'out/extension.js'));
    const sampleA = ['"""', '题面', '"""', '', '# @lc code=start', 'class Solution:', '    def twoSum(self):', '        pass', '# @lc code=end'].join('\n');
    ok(problemLensAnchor(sampleA) === 4, '锚点= @lc code=start 行', String(problemLensAnchor(sampleA)));
    const sampleB = ['from typing import *', '', 'class Solution:', '    def twoSum(self):', '        pass'].join('\n');
    ok(problemLensAnchor(sampleB) === 2, '无标记时兜底= 第一个 class 行', String(problemLensAnchor(sampleB)));
    ok(problemLensAnchor('x = 1') === 0, '啥都没有= 首行');

    // ---- 11. case 块回放锚点（0.15.0：每个 @lcpr case=start 上方挂单用例回放 CodeLens）----
    const { problemCaseAnchors } = require(path.join(ROOT, 'out/extension.js'));
    const sampleC = [
        '# @lc code=start', 'class Solution:', '    def twoSum(self):', '        pass', '# @lc code=end', '',
        '# @lcpr case=start', '# [2,7,11,15]\\n9', '# @lcpr case=end', '',
        '# @lcpr case=start', '# [3,2,4]\\n6', '# @lcpr case=end'
    ].join('\n');
    const anchors = problemCaseAnchors(sampleC);
    ok(anchors.length === 2 && anchors[0].line === 6 && anchors[0].no === 1 && anchors[1].line === 10 && anchors[1].no === 2,
        'case 锚点行号与序号', JSON.stringify(anchors));
    ok(anchors[0].preview.includes('[2,7,11,15]') && anchors[1].preview.includes('[3,2,4]'), 'case 预览取自块内首行');
    ok(problemCaseAnchors('no cases here').length === 0, '无 case 块 → 空数组');

    // ---- 12. 重置代码区（0.15.7：↩️重置 CodeLens → 只换代码区，题干与用例保留）----
    const TPL = 'class Solution:\n    def twoSum(self, nums, target):\n        pass\n';
    const mkFile = (code, indent = '') => [
        '#', '# @lc app=leetcode.cn id=1 lang=python3', '#', '"""题干"""', '',
        `${indent}# @lc code=start`, ...code, `${indent}# @lc code=end`, '',
        '# @lcpr case=start', '# [2,7,11,15]\\n9', '# @lcpr case=end'
    ].join('\n');
    const dirty = mkFile(['class Solution:', '    def twoSum(self, nums, target):', '        return []']);
    const reset = probs.resetCodeRegion(dirty, TPL);
    ok(reset && reset.includes('pass') && reset.includes('"""题干"""') && reset.includes('@lcpr case=start') && !reset.includes('return []'),
        'resetCodeRegion 换掉代码区、保留题干与用例');
    ok(probs.resetCodeRegion(reset, TPL) === reset, '已是初始模板 → 幂等');
    ok(probs.resetCodeRegion('print(1)\n', TPL) === undefined, '无标记散文件 → undefined');
    const indented = probs.resetCodeRegion(mkFile(['        return []'], '    '), TPL);
    ok(indented !== undefined && indented.includes('    class Solution:') && !indented.includes('return []'),
        '标记缩进的老格式：模板行随缩进补前缀');

    console.log(failed === 0 ? '\n🎉 全部自测通过' : `\n💥 ${failed} 项失败`);
    process.exit(failed === 0 ? 0 : 1);
})().catch(e => { console.error('❌ 自测中断:', e.message); process.exit(1); });
