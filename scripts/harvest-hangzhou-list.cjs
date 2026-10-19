// 杭州后端求职向：codetop.cc 面经考频 × 公司权重 → 「杭州后端·加权高频TOP100」
// 数据源：codetop.cc（牛客面经聚合，免费 API，题目 value=面经出现次数），题号→slug 用插件 allQuestions.json 缓存反查
// 背景：leetcode.cn 企业题库已锁 Plus 会员（非会员 companyFilter/favoriteQuestionList 均静默返回空），故改用 codetop
const fs = require('fs');
const path = require('path');
const os = require('os');
const GS = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/liuqiang-local.leetcode-mistake-tracker');
const sleep = ms => new Promise(r => setTimeout(r, ms));

// [codetop公司id, 专项题单名, 杭州权重(后端 HC 体量 × 在杭存在感)]
const COMPANIES = [
    [4, '阿里巴巴·高频TOP100', 1.0],   // 总部杭州（淘天/阿里云/菜鸟/钉钉）；蚂蚁题风与之高度重合
    [1, '字节跳动·高频TOP100', 0.85],  // 杭州大研发中心（抖音电商/火山引擎/飞书）
    [11, '华为·高频TOP100', 0.7],      // 杭研所（滨江，数通/AI/云）
    [16, '网易·高频TOP100', 0.6],      // 网易杭州（雷火/云音乐/严选）
    [6, '腾讯·高频TOP100', 0.4],       // 在杭有游戏后端/大模型岗
];
const MERGED_NAME = '杭州后端·加权高频TOP100';
const PER_COMPANY_N = 100;

(async () => {
    // 1) qid → {slug,title,diff} 映射（插件题目缓存）
    const all = JSON.parse(fs.readFileSync(path.join(GS, 'allQuestions.json'), 'utf8'));
    const byQid = new Map(all.map(q => [String(q[0]), { slug: q[1], title: q[2], diff: q[3] }]));

    // 2) 逐公司拉 codetop 面经考频（value = 面经出现次数）
    const merged = new Map(); // slug -> {score, qid, title, diff, sources}
    const lists = [];
    for (const [cid, listName, weight] of COMPANIES) {
        let page = 1; const raw = new Map(); // qid -> max value
        while (true) {
            const r = await fetch(`https://codetop.cc/api/questions/?company=${cid}&page=${page}`, { headers: { 'User-Agent': 'Mozilla/5.0 lmt', Referer: 'https://codetop.cc/home' } });
            const j = await r.json();
            const items = j?.list ?? [];
            for (const q of items) {
                const qid = String(q.leetcode?.frontend_question_id ?? '');
                if (!qid) { continue; }
                raw.set(qid, Math.max(raw.get(qid) ?? 0, q.value ?? 0));
            }
            if (!items.length || raw.size >= (j?.count ?? 0)) { break; }
            page++; await sleep(250);
        }
        const ranked = [...raw.entries()].sort((a, b) => b[1] - a[1]);
        const top = [];
        for (const [qid, value] of ranked) {
            const meta = byQid.get(qid);
            if (!meta) { continue; } // 数据库题/下架题等不在插件缓存里
            top.push({ qid, ...meta, value });
            if (top.length >= PER_COMPANY_N) { break; }
        }
        const maxV = top[0]?.value || 1;
        for (const q of top) {
            const e = merged.get(q.slug) ?? { score: 0, qid: q.qid, title: q.title, diff: q.diff, sources: [] };
            e.score += weight * (q.value / maxV);
            e.sources.push(`${listName.split('·')[0]}:${q.value}次`);
            merged.set(q.slug, e);
        }
        lists.push({ name: listName, items: top.map(q => q.slug), skipped: ranked.length - raw.size });
        console.log(`✅ ${listName.split('·')[0]}: 面经题 ${ranked.length} 道 → 取 TOP${top.length}（最高频 ${top[0]?.title} ${top[0]?.value} 次）`);
        await sleep(250);
    }

    const mergedRanked = [...merged.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 100);
    console.log(`\n=== ${MERGED_NAME}（权重 = Σ 公司权重 × 该公司面经频次归一）===`);
    mergedRanked.forEach(([slug, e], i) => {
        if (i < 30) console.log(`${String(i + 1).padStart(3)}. ${e.qid}.${e.title} [${e.diff}] ${e.score.toFixed(2)} ← ${e.sources.join(' | ')}`);
    });
    const byDiff = { Easy: 0, Medium: 0, Hard: 0 };
    mergedRanked.forEach(([, e]) => { byDiff[e.diff] = (byDiff[e.diff] ?? 0) + 1; });
    console.log(`   共 100 题，难度分布 Easy/Medium/Hard = ${byDiff.Easy}/${byDiff.Medium}/${byDiff.Hard}`);

    // 3) 合入 problemLists.json：清掉 items 为空的废题单，覆盖同名旧题单（旧 8 家里非杭州的保留）
    const file = path.join(GS, 'problemLists.json');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
    const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const names = new Set([MERGED_NAME, ...lists.map(l => l.name)]);
    const kept = (existing || []).filter(l => Array.isArray(l.items) && l.items.length && !names.has(l.name));
    const out = [
        { id: id(), name: MERGED_NAME, items: mergedRanked.map(([slug]) => slug), createdAt: Date.now() },
        ...lists.map(l => ({ id: id(), name: l.name, items: l.items, createdAt: Date.now() })),
        ...kept
    ];
    fs.writeFileSync(file, JSON.stringify(out, null, 1), 'utf8');
    console.log(`\n题单已写入: 保留原有 ${kept.length} 个，新写 1 个杭州加权题单 + ${lists.length} 个公司专项（面经版，覆盖同名旧款）`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
