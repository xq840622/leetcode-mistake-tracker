// 一次性批量补题干：给题目目录里缺题面 docstring 的历史文件（labuladong 插件生成的）
// 拉取 leetcode.cn 题面并回填，解法代码与用例块一律不动。可重复执行（已补过的自动跳过）。
// 用法：node scripts/backfill-desc.cjs [目录，默认 ~/leetcode/editor/cn]
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

// 复用编译产物 out/problems.js 的 backfillDesc（需要 vscode 桩，与 selftest 同款）
const origResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...args) {
    if (request === 'vscode') { return path.join(__dirname, 'vscode-stub.cjs'); }
    return origResolve.call(this, request, ...args);
};
const { backfillDesc } = require(path.join(__dirname, '..', 'out', 'problems.js'));

const dir = process.argv[2] || path.join(os.homedir(), 'leetcode', 'editor', 'cn');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// 文件名 → slug：剥题号前缀与扩展名；驼峰旧名（BinaryTreePreorderTraversal）转 kebab
const slugOf = name => name.replace(/\.py$/, '').trim().replace(/^\d+\./, '').trim()
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();

async function descHtmlOf(slug) {
    const res = await fetch('https://leetcode.cn/graphql/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Referer: 'https://leetcode.cn', 'User-Agent': 'lmt-backfill' },
        body: JSON.stringify({
            query: 'query qd($slug: String!) { question(titleSlug: $slug) { content translatedContent } }',
            variables: { slug }
        })
    });
    const q = (await res.json())?.data?.question;
    return q?.translatedContent || q?.content || '';
}

// 与 backfillDesc 同款判断：code 区之前已有 docstring 就不必浪费一次接口调用
function hasDesc(text) {
    const lines = text.split('\n');
    const markerIdx = lines.findIndex(l => l.trim() === '# @lc code=start');
    return (markerIdx >= 0 ? lines.slice(0, markerIdx) : lines).some(l => l.includes('"""'));
}

(async () => {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.py')).sort();
    let filled = 0, skipped = 0, failed = 0;
    for (const f of files) {
        const file = path.join(dir, f);
        if (hasDesc(fs.readFileSync(file, 'utf8'))) { console.log(`⏭  ${f}（已有题干）`); skipped++; continue; }
        const slug = slugOf(f);
        try {
            const ok = backfillDesc(file, await descHtmlOf(slug));
            if (ok) { console.log(`✅ ${f} ← ${slug} 题干已补`); filled++; }
            else { console.log(`⚠️  ${f} ← ${slug} 接口没返回题面（会员题？）`); failed++; }
        } catch (e) {
            console.log(`❌ ${f} ← ${slug}: ${e.message}`); failed++;
        }
        await sleep(300);
    }
    console.log(`\n补写 ${filled} · 跳过 ${skipped} · 失败 ${failed} · 共 ${files.length} 个文件`);
})();
