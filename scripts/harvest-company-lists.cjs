// 收割企业题库：8 家公司 × 频率 TOP100 → 写入插件 problemLists.json（我的题单）
const fs = require('fs');
const path = require('path');
const os = require('os');
const settings = fs.readFileSync(path.join(os.homedir(), 'Library/Application Support/Code/User/settings.json'), 'utf8');
const mm = /"lmt\.leetcodeCookie"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(settings);
const cookie = JSON.parse('"' + mm[1] + '"');
const UA = 'Mozilla/5.0 lmt';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const gql = async (query, variables) => (await fetch('https://leetcode.cn/graphql/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Referer': 'https://leetcode.cn/problemset/', 'Cookie': cookie, 'User-Agent': UA },
    body: JSON.stringify({ query, variables })
})).json();

const V2 = `query q($filters: QuestionFilterInput, $limit: Int, $skip: Int, $sortBy: QuestionSortByInput) {
  problemsetQuestionListV2(filters: $filters, limit: $limit, skip: $skip, sortBy: $sortBy) {
    questions { questionFrontendId titleSlug translatedTitle difficulty frequency paidOnly }
    totalLength hasMore
  }
}`;

(async () => {
    // 1) 公司全表
    let offset = 0; const all = [];
    while (true) {
        const j = await gql(`query { companyTagsV2(limit: 15, offset: ${offset}) { companyTagInfoNodes { name slug questionCount: companyQuestionNum } hasMore } }`, {});
        const nodes = j?.data?.companyTagsV2?.companyTagInfoNodes ?? [];
        all.push(...nodes);
        if (!j?.data?.companyTagsV2?.hasMore || !nodes.length) { break; }
        offset += 15; await sleep(200);
    }
    console.log('公司总数:', all.length);

    // 目标公司（杭州/大厂向）
    const want = ['bytedance', 'alibaba', 'tencent', 'meituan', 'huawei', 'netease', 'baidu', 'pinduoduo'];
    const targets = want.map(w => ({ slug: w, meta: all.find(c => c.slug === w) })).filter(t => t.meta);
    const missing = want.filter(w => !all.some(c => c.slug === w));
    if (missing.length) { console.log('（题库里没有，跳过:', missing.join(', '), '）'); }
    // netease 等找不到时给候选提示
    if (!all.some(c => c.slug === 'netease')) {
        console.log('网易相关候选:', all.filter(c => /netease|163|网易/i.test(c.name + c.slug)).map(c => c.slug + '/' + c.name).join(', ') || '无');
    }

    // 2) 试服务器端频率排序
    let sortBy;
    for (const sb of [{ sortField: 'FREQUENCY', sortOrder: 'DESC' }, { sortField: 'Frequency', sortOrder: 'DESC' }]) {
        const j = await gql(V2, { filters: { filterCombineType: 'ALL', companyFilter: { companySlugs: ['bytedance'], operator: 'IS' } }, limit: 3, skip: 0, sortBy: sb });
        if (!j?.errors) { sortBy = sb; console.log('✅ 服务器频率排序可用:', JSON.stringify(sb)); break; }
        console.log('sortBy 不行:', JSON.stringify(sb), j.errors[0].message.replace(/\n/g, ' ').slice(0, 120));
    }

    // 3) 逐公司拉题（有 sortBy 只拉 100；没有就翻页拉全量本地排序）
    const TOP_N = 100;
    const lists = [];
    for (const t of targets) {
        const filters = { filterCombineType: 'ALL', companyFilter: { companySlugs: [t.slug], operator: 'IS' } };
        let qs = [];
        if (sortBy) {
            const j = await gql(V2, { filters, limit: TOP_N, skip: 0, sortBy });
            qs = j?.data?.problemsetQuestionListV2?.questions ?? [];
        } else {
            let skip = 0;
            while (true) {
                const j = await gql(V2, { filters, limit: 100, skip });
                const d = j?.data?.problemsetQuestionListV2;
                qs.push(...(d?.questions ?? []));
                if (!d?.hasMore || (d?.questions ?? []).length === 0) { break; }
                skip += 100; await sleep(300);
            }
            qs.sort((a, b) => (b.frequency ?? 0) - (a.frequency ?? 0));
        }
        const top = qs.slice(0, TOP_N);
        const paid = top.filter(q => q.paidOnly).length;
        lists.push({ name: `${t.meta.name}·高频TOP${top.length}`, slug: t.slug, count: t.meta.questionCount, items: top.map(q => q.titleSlug), paid });
        console.log(`✅ ${t.meta.name}: 题库 ${t.meta.questionCount} 题 → 取 TOP${top.length}（含会员题 ${paid}）· 首题 ${top[0]?.questionFrontendId}.${top[0]?.titleSlug}(freq${top[0]?.frequency})`);
        await sleep(300);
    }

    // 4) 合入 problemLists.json（保留用户已有题单，名字冲突则覆盖旧的生成款）
    const file = path.join(os.homedir(), 'Library/Application Support/Code/User/globalStorage/liuqiang-local.leetcode-mistake-tracker/problemLists.json');
    let existing = [];
    try { existing = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
    const id = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const generatedNames = new Set(lists.map(l => l.name));
    const kept = (existing || []).filter(l => !generatedNames.has(l.name) && !/·高频TOP\d+$/.test(l.name));
    const merged = [...kept, ...lists.map(l => ({ id: id(), name: l.name, items: l.items, createdAt: Date.now() }))];
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(merged, null, 1), 'utf8');
    console.log(`\n题单文件已写入: 保留原有 ${kept.length} 个 + 新增 ${lists.length} 个公司高频题单（共 ${merged.length} 个）`);
})().catch(e => { console.error('ERR', e.message); process.exit(1); });
