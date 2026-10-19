import { isMistake, isSolved, ERROR_TYPE_LABEL, STATUS_LABEL, Store } from './store';
import { ListsData } from './treeView';

/** 统计口径（题单）：dashboard 按它过滤记录。slugs/qids 至少给一个，total 为题单总题数（未做也计入） */
export interface DashScope {
    id: string;
    group: string; // 我的题单 / 收藏的题单 / 导入题单
    name: string;
    slugs?: string[];
    qids?: number[];
    total: number;
}

/** 打进页面里的最小记录结构（浏览器端按口径过滤重算，切换不用回扩展要数据） */
interface DashRec {
    qid: number; slug: string; title: string; difficulty: string;
    solved: boolean; mistake: boolean;
    errorTypes: string[];
    attempts: Array<{ s: string; t: number }>;
}

export function renderDashboard(store: Store, tree: ListsData, scopes: DashScope[] = []): string {
    const recs: DashRec[] = store.load().map(r => ({
        qid: r.qid, slug: r.slug, title: r.title || r.slug, difficulty: r.difficulty,
        solved: isSolved(r), mistake: isMistake(r),
        errorTypes: r.errorTypes ?? [],
        attempts: r.attempts.map(a => ({ s: a.status, t: a.ts }))
    }));
    const top100 = tree.data().map(t => t.qid);
    const payload = JSON.stringify({ recs, top100, scopes }).replace(/</g, '\\u003c');

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head><meta charset="UTF-8">
<style>
    body { font-family: -apple-system, "PingFang SC", sans-serif; padding: 24px; color: var(--vscode-foreground); background: var(--vscode-editor-background); }
    h1 { font-size: 20px; } h2 { font-size: 15px; margin-top: 28px; }
    .cards { display: flex; gap: 12px; flex-wrap: wrap; }
    .card { background: var(--vscode-sideBar-background); border: 1px solid var(--vscode-panel-border); border-radius: 10px; padding: 14px 18px; min-width: 120px; text-align: center; }
    .num { font-size: 22px; font-weight: 600; } .lbl { font-size: 12px; opacity: .8; margin-top: 4px; }
    .bar-row { display: flex; align-items: center; gap: 10px; margin: 6px 0; }
    .bar-lbl { width: 110px; font-size: 13px; }
    .bar-track { flex: 1; background: var(--vscode-sideBar-background); border-radius: 5px; height: 18px; }
    .bar-fill { background: #d29922; height: 100%; border-radius: 5px; min-width: 2px; }
    .bar-num { width: 30px; font-size: 13px; text-align: right; }
    table { border-collapse: collapse; width: 100%; font-size: 13px; }
    td, th { padding: 6px 10px; border-bottom: 1px solid var(--vscode-panel-border); text-align: left; }
    .ok { color: var(--vscode-testing-iconPassed); } .bad { color: var(--vscode-testing-iconFailed); }
    .empty { opacity: .7; font-size: 13px; }
    .toolbar { margin-bottom: 8px; }
    .toolbar a { display: inline-block; padding: 6px 14px; margin: 0 8px 8px 0; border: 1px solid var(--vscode-panel-border);
        border-radius: 8px; text-decoration: none; color: var(--vscode-foreground); font-size: 13px; }
    .toolbar a:hover { background: var(--vscode-sideBar-background); }
    .scope-row { display: flex; align-items: center; gap: 10px; margin: 14px 0 4px; }
    .scope-row select { padding: 5px 10px; border: 1px solid var(--vscode-panel-border); border-radius: 8px;
        background: var(--vscode-sideBar-background); color: var(--vscode-foreground); font-size: 13px; max-width: 420px; }
    .scope-hint { font-size: 12px; opacity: .7; }
</style></head>
<body>
<h1>LeetCode 错题本 · 统计<span id="scopeTitle"></span></h1>
<div class="toolbar">
    <a href="command:lmt.sync">⟳ 同步提交记录</a>
    <a href="command:lmt.refreshCookie">🔑 续期 Cookie</a>
    <a href="command:lmt.exportNotes">📤 导出错题 md</a>
</div>
<div class="scope-row">
    <label for="scope" class="scope-hint">统计口径</label>
    <select id="scope"></select>
    <span id="scopeHint" class="scope-hint"></span>
</div>
<div class="cards" id="cards"></div>
<h2>错误类型分布（AI 归因累计）</h2>
<div id="bars"></div>
<h2>最近提交</h2>
<table><thead><tr><th>题目</th><th>结果</th><th>时间</th></tr></thead><tbody id="recent"></tbody></table>
<script>
const DATA = ${payload};
const STATUS_LABEL = ${JSON.stringify(STATUS_LABEL)};
const ERROR_TYPE_LABEL = ${JSON.stringify(ERROR_TYPE_LABEL).replace(/</g, '\\u003c')};
const sel = document.getElementById('scope');
const E = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// 口径下拉：全部（默认）/ 内置（热题100、难度）/ 我的题单 / 收藏的题单 / 导入题单（LeetCode 侧题单只列出题目已加载过的）
(function buildSelect() {
    const opt = (v, t) => { const o = document.createElement('option'); o.value = v; o.textContent = t; return o; };
    sel.appendChild(opt('', '全部题目'));
    const builtin = document.createElement('optgroup'); builtin.label = '内置';
    builtin.appendChild(opt('builtin:hot100', '热题 100'));
    builtin.appendChild(opt('builtin:EASY', '简单（已做题内）'));
    builtin.appendChild(opt('builtin:MEDIUM', '中等（已做题内）'));
    builtin.appendChild(opt('builtin:HARD', '困难（已做题内）'));
    sel.appendChild(builtin);
    const groups = [...new Set(DATA.scopes.map(s => s.group))];
    for (const g of groups) {
        const og = document.createElement('optgroup'); og.label = g;
        for (const s of DATA.scopes.filter(x => x.group === g)) { og.appendChild(opt(s.id, s.name)); }
        sel.appendChild(og);
    }
})();

const inScope = (r, sc) => {
    if (!sc) { return true; }
    if (sc.id === 'builtin:hot100') { return DATA.top100.includes(r.qid); }
    if (sc.id.startsWith('builtin:')) { return (r.difficulty || '').toUpperCase() === sc.id.slice(8); }
    if (sc.slugs && r.slug && sc.slugs.includes(r.slug)) { return true; }
    if (sc.qids && r.qid && sc.qids.includes(r.qid)) { return true; }
    return false;
};

function render() {
    const sc = DATA.scopes.find(s => s.id === sel.value);
    const recs = DATA.recs.filter(r => inScope(r, sc));
    document.getElementById('scopeTitle').textContent = sc ? ' · ' + (sc.group ? sc.group + '：' : '') + sc.name : '';

    const attempted = recs.length;
    const mistakes = recs.filter(r => r.mistake).length;
    const firstTry = recs.filter(r => !r.mistake && r.solved).length;
    const pct = n => attempted ? (n / attempted * 100).toFixed(1) + '%' : '0.0%';
    const avg = attempted ? (recs.reduce((s, r) => s + r.attempts.length, 0) / attempted).toFixed(1) : '0.0';
    const cards = [];
    if (!sc) {
        const topDone = DATA.top100.filter(q => { const r = DATA.recs.find(x => x.qid === q); return r && r.solved; }).length;
        cards.push(['已做题数', String(attempted)], ['Top100 进度', topDone + '/100'],
            ['错题率', pct(mistakes)], ['一次通过率', pct(firstTry)], ['平均提交次数', avg]);
        document.getElementById('scopeHint').textContent = '';
    } else if (sc.total > 0) {
        const done = recs.filter(r => r.solved).length;
        cards.push(['题单进度', done + '/' + sc.total], ['已做', attempted + '/' + sc.total],
            ['错题率', pct(mistakes)], ['一次通过率', pct(firstTry)], ['平均提交次数', avg]);
        document.getElementById('scopeHint').textContent =
            '题单共 ' + sc.total + ' 题，本地已碰 ' + attempted + ' 题；未做的题不计入错题率分母';
    } else {
        cards.push(['已做题数', String(attempted)], ['错题率', pct(mistakes)], ['一次通过率', pct(firstTry)], ['平均提交次数', avg]);
        document.getElementById('scopeHint').textContent = '';
    }
    document.getElementById('cards').innerHTML =
        cards.map(([k, v]) => '<div class="card"><div class="num">' + v + '</div><div class="lbl">' + k + '</div></div>').join('');

    const dist = {};
    for (const r of recs) { for (const t of r.errorTypes) { dist[t] = (dist[t] || 0) + 1; } }
    const distArr = Object.entries(dist).sort((a, b) => b[1] - a[1]);
    const maxDist = Math.max(1, ...distArr.map(d => d[1]));
    document.getElementById('bars').innerHTML = distArr.length
        ? distArr.map(([t, n]) => '<div class="bar-row"><div class="bar-lbl">' + E(ERROR_TYPE_LABEL[t] || t) +
            '</div><div class="bar-track"><div class="bar-fill" style="width:' + (n / maxDist * 100).toFixed(1) +
            '%"></div></div><div class="bar-num">' + n + '</div></div>').join('')
        : '<p class="empty">还没有错误类型数据——失败后用「AI 归因」打标签。</p>';

    const recent = recs.flatMap(r => r.attempts.map(a => ({ r, a }))).sort((x, y) => y.a.t - x.a.t).slice(0, 25)
        .map(({ r, a }) => '<tr><td>' + r.qid + '. ' + E(r.title) + '</td><td class="' + (a.s === 'AC' ? 'ok' : 'bad') + '">' +
            (a.s === 'AC' ? '✅' : '❌') + ' ' + E(STATUS_LABEL[a.s] || a.s) + '</td><td>' +
            new Date(a.t).toLocaleString('zh-CN', { hour12: false }) + '</td></tr>').join('');
    document.getElementById('recent').innerHTML = recent || '<tr><td colspan="3" class="empty">该口径下还没有记录 🎯</td></tr>';
}
sel.onchange = render;
render();
</script>
</body></html>`;
}
