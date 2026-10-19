// 守护：轮询等待用户续期 cookie（唯一解锁步骤）→ 一旦有效立即用出货代码跑完整提交闭环
//   node scripts/verify-submit.cjs          （等待模式：最多 10 分钟）
// 验证链：submitCode → waitSubmission(轮询判定) → fetchSubmissionDetail(权威状态) → Store.upsert 入库去重
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const SOLUTION = '/Users/liuqiang/leetcode/lc-plugin-template/python-template/leetcode/editor/cn/1.two-sum.py';

const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') { return path.join(__dirname, 'vscode-stub.cjs'); }
    return origResolve.call(this, request, ...args);
};
process.env.LMT_TEST_PROBLEMS_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'lmt-store-'));
const { fetchQuestionDetail, submitCode, waitSubmission, fetchSubmissionDetail } = require(path.join(ROOT, 'out/leetcode.js'));
const { Store } = require(path.join(ROOT, 'out/store.js'));

const settingsFile = path.join(os.homedir(), 'Library/Application Support/Code/User/settings.json');
function readCookie() {
    const m = /"lmt\.leetcodeCookie"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(fs.readFileSync(settingsFile, 'utf8'));
    return m ? JSON.parse(`"${m[1]}"`) : '';
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function verify(cookie) {
    try {
        const res = await fetch('https://leetcode.cn/graphql/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.cn', 'User-Agent': 'Mozilla/5.0 lmt-probe', Cookie: cookie },
            body: JSON.stringify({ query: '{ user { username } }', variables: {} })
        });
        const b = await res.json();
        return b?.data?.user?.username || '';
    } catch { return ''; }
}

(async () => {
    // —— 等待解锁（最多 10 分钟）——
    let cookie = readCookie();
    let user = await verify(cookie);
    for (let i = 0; !user && i < 29; i++) {
        await sleep(20_000);
        const next = readCookie();
        if (next !== cookie) { cookie = next; user = await verify(cookie); console.log(`[轮询 ${i + 1}] cookie 已更新，登录态: ${user || '仍无效'}`); }
        else if (i % 3 === 0) { console.log(`[轮询 ${i + 1}] 等待续期…`); }
    }
    if (!user) { console.log('TIMEOUT: 10 分钟内未等到有效 cookie'); process.exit(2); }
    console.log(`✅ 检测到有效登录态（用户 ${user}）`);

    // —— 1) 拉题拿内部 questionId ——
    const qd = await fetchQuestionDetail('two-sum');
    console.log(`题目: ${qd.frontendId}. ${qd.title} · 内部 questionId=${qd.questionId}`);

    // —— 2) 真实提交（出货代码 submitCode）——
    const code = fs.readFileSync(SOLUTION, 'utf8');
    const sid = await submitCode('two-sum', qd.questionId, code, 'python3', cookie);
    console.log(`✅ 提交成功 submissionId=${sid}（REST 接受，非 403）`);

    // —— 3) 轮询判定（出货代码 waitSubmission）——
    const outcome = await waitSubmission(sid, cookie);
    console.log(`✅ 判定完成 status_code=${outcome.statusCode} runtime=${outcome.runtime} memory=${outcome.memory}`);

    // —— 4) 权威状态（submissionDetail）——
    const det = await fetchSubmissionDetail(String(sid), cookie);
    console.log(`✅ submissionDetail: ${det.status} ${det.runtime} ${det.memory} codeLen=${(det.code || '').length}`);
    if (det.status !== 'AC') { console.log('⚠ 提交未通过（这不是链路问题，是解法问题）'); }

    // —— 5) 入库去重（出货代码 Store.upsert，隔离在临时目录）——
    const store = new Store({ globalStorageUri: { fsPath: process.env.LMT_TEST_PROBLEMS_ROOT } });
    const mkRec = () => ({
        qid: 1, slug: 'two-sum', title: qd.title, difficulty: qd.difficulty, errorTypes: [],
        attempts: [{ ts: Date.now(), status: det.status, lang: det.lang, runtime: det.runtime, id: String(sid) }],
        codeSnapshot: code.slice(0, 1000)
    });
    store.upsert(mkRec());
    const after1 = store.load()[0].attempts.length;
    store.upsert(mkRec()); // 同 id 再来一遍 = 模拟"插件入库 + 后续同步拉到同一条"
    const after2 = store.load()[0].attempts.length;
    console.log(`✅ 入库去重: ${after1} 条 → 再 upsert 同 id 后仍 ${after2} 条 ${after1 === after2 ? '(去重正确)' : '(❌ 去重失效!)'}`);

    console.log(after1 === after2 && sid > 0 ? '\n🎉 提交→判定→入库 全链路端到端验证通过' : '\n💥 链路有异常，见上');
    process.exit(after1 === after2 ? 0 : 1);
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
