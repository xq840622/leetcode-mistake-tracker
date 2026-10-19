import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Store, Rec, isMistake, mistakeCount, STATUS_LABEL, ERROR_TYPE_LABEL } from './store';
import { guessProblemFromEditor, guessProblemFromFileName, findBySlug, allQuestions, fetchSubmissionDetail, fetchVerdict, syncSlugs, log, fetchQuestionDetail, submitCode, waitSubmission, fetchMyFavorites, fetchFavoriteQuestions } from './leetcode';
import { analyzeWithAi, aiConfigured, AiResult, DEFAULT_AI_PROMPT } from './ai';
import { resolveNotesDir, exportRecord, silentNotesDir, notesDir, noteFilePath } from './notes';
import { ProblemListsTree, TreeEntry } from './treeView';
import { loadLists, saveLists, newList, parseListInput, QMetaLite } from './lists';
import { OverviewTree } from './overview';
import { renderDashboard, DashScope } from './dashboard';
import { parseCookieString, decodeSession, verifyCookie, labuladongUserFile, writeLabuladongSession } from './cookie';
import { ensureDriver } from './debug';
import { VizEventBus, recordSteps, renderVizHtml } from './visualize';
import { openOrCreate, listProblemFiles, problemsRoot, adoptProblemsRoot, resetCodeRegion } from './problems';

const ACTIVE_MS = 30 * 86400_000; // 「活跃题」窗口：只自动同步近 30 天碰过的题
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 读文件头找 labuladong 格式标记 `# @lc app=leetcode.cn id=数字`：带标记的就是题目文件，不管放在哪个目录 */
export function lcMarkerQid(fsPath: string): number | undefined {
    try {
        const head = fs.readFileSync(fsPath, 'utf8').slice(0, 3000);
        const m = /^#\s*@lc\s+app=leetcode\.cn\s+id=(\d+)/m.exec(head);
        return m ? Number(m[1]) : undefined;
    } catch { return undefined; }
}

/** 判定文档是否题目文件并给出题号/slug（trackDoc 与 CodeLens 共用）：文件名在刷题目录内解析，认不出读文件头 @lc 标记兜底 */
export function problemGuessOf(doc: vscode.TextDocument): { qid: number; slug: string } | undefined {
    if (doc.languageId !== 'python') { return undefined; }
    const fsPath = doc.uri.fsPath;
    const root = problemsRoot();
    const inLeetcodeDir = fsPath.includes('/leetcode/') || fsPath.startsWith(root);
    let g = inLeetcodeDir ? guessProblemFromFileName(fsPath) : undefined;
    if (!g) {
        const qid = lcMarkerQid(fsPath);
        if (qid) { g = { qid, slug: '' }; }
    }
    return g;
}

/** 代码内悬浮按钮（CodeLens）的锚点行：@lc code=start 标记行，兜底第一个 class 行，再兜底首行 */
export function problemLensAnchor(text: string): number {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('@lc code=start')) { return i; }
    }
    for (let i = 0; i < lines.length; i++) {
        if (/^class\s+\w+/.test(lines[i])) { return i; }
    }
    return 0;
}

/** 每个 @lcpr case 块的回放锚点：case=start 行号（0-based）、按出现顺序编号、下一行用例内容预览 */
export function problemCaseAnchors(text: string): Array<{ line: number; no: number; preview: string }> {
    const lines = text.split('\n');
    const out: Array<{ line: number; no: number; preview: string }> = [];
    for (let i = 0; i < lines.length; i++) {
        if (!/^\s*#\s*@lcpr\s+case=start/.test(lines[i])) { continue; }
        const raw = (lines[i + 1] ?? '').trim().replace(/^#\s*/, '');
        out.push({ line: i, no: out.length + 1, preview: raw.length > 24 ? `${raw.slice(0, 24)}…` : raw });
    }
    return out;
}

export function activate(ctx: vscode.ExtensionContext) {
    const store = new Store(ctx);
    const storageDir = ctx.globalStorageUri.fsPath;
    // ================= LeetCode 侧题单（收藏夹 / VIP 自建题单） =================
    // 树是同步渲染的：网络结果写进 globalStorage 缓存（favorites.json / favItems.json），再 refresh 树。
    let tree: ProblemListsTree;
    const favCacheFile = path.join(storageDir, 'favorites.json');
    const favItemsFile = path.join(storageDir, 'favItems.json');
    const FAV_ITEMS_TTL = 12 * 3600_000; // 单题单题目缓存 12 小时（题单列表本身每次刷新都拉）
    let favLoading = false;
    const favItemsLoading = new Set<string>();
    const readJson = (f: string): any => { try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : undefined; } catch { return undefined; } };
    const writeJson = (f: string, o: unknown) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o), 'utf8'); };

    const refreshFavorites = async (): Promise<void> => {
        const ck = cookieOf();
        if (!ck || favLoading) { return; }
        favLoading = true;
        try {
            const { created, collected } = await fetchMyFavorites(ck);
            if (created.length === 0 && collected.length === 0) { return; } // 空结果多为 Cookie 失效，保留旧缓存
            writeJson(favCacheFile, { at: Date.now(), created, collected });
            tree.refresh();
        } catch (e: any) {
            log(ctx).appendLine(`LeetCode 题单拉取失败: ${e.message}`);
        } finally { favLoading = false; }
    };
    const loadFavItems = async (favSlug: string): Promise<void> => {
        const ck = cookieOf();
        if (!favSlug || !ck || favItemsLoading.has(favSlug)) { return; }
        const cached = readJson(favItemsFile)?.[favSlug];
        if (cached && Date.now() - (cached.at ?? 0) < FAV_ITEMS_TTL) { return; }
        favItemsLoading.add(favSlug);
        try {
            const questions = await fetchFavoriteQuestions(favSlug, ck);
            const o = readJson(favItemsFile) ?? {};
            o[favSlug] = { at: Date.now(), questions };
            writeJson(favItemsFile, o);
            tree.refresh();
        } catch (e: any) {
            log(ctx).appendLine(`LeetCode 题单 ${favSlug} 题目拉取失败: ${e.message}`);
        } finally { favItemsLoading.delete(favSlug); }
    };

    tree = new ProblemListsTree(store, storageDir, {
        ensureFolders: () => { void refreshFavorites(); },
        ensureItems: favSlug => { void loadFavItems(favSlug); },
    });
    // 概览 / 记录与整理 / 设置：侧边栏与「题单」平级的三个视图，共用 OverviewTree 的行渲染
    const overviewViews = ([
        ['lmt.overview', 'overview'],
        ['lmt.records', 'records'],
        ['lmt.settings', 'settings'],
    ] as const).map(([id, view]) => {
        const provider = new OverviewTree(store, () => ctx.globalState.get<number>('lmt.lastSync'),
            String((ctx.extension.packageJSON as any)?.version ?? ''),
            () => !!ctx.globalState.get<number>('lmt.cookieDeadAt'), view);
        ctx.subscriptions.push(vscode.window.registerTreeDataProvider(id, provider));
        return provider;
    });
    const refreshOverviews = () => { for (const v of overviewViews) { v.refresh(); } };

    // 编辑器右上角 🐞🔍 按钮的显示条件；启动时就要按当前活动编辑器初始化一次
    // （Reload 后题目文件是"恢复打开"的，不会再触发 onDidChangeActiveTextEditor）
    void vscode.commands.executeCommand('setContext', 'lmt.supportedLanguages',
        ['python', 'python3', 'javascript', 'typescript', 'java', 'c', 'cpp', 'go', 'csharp', 'ruby', 'swift', 'kotlin', 'rust', 'php', 'dart', 'scala']);
    void vscode.commands.executeCommand('setContext', 'lmt.isProblemFile', false);

    const statusItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
    statusItem.name = 'LeetCode 错题率';
    statusItem.command = 'lmt.openDashboard';
    ctx.subscriptions.push(statusItem);

    const refreshStatus = () => {
        const recs = store.load();
        if (recs.length === 0) { statusItem.hide(); return; }
        const wrong = recs.filter(isMistake).length;
        statusItem.text = `$(book) LC 错题 ${wrong}/${recs.length}（${(wrong / recs.length * 100).toFixed(0)}%）`;
        statusItem.show();
    };
    refreshStatus();

    const afterChange = () => { refreshStatus(); tree.refresh(); refreshOverviews(); };
    ctx.subscriptions.push(vscode.window.registerTreeDataProvider('lmt.listsTree', tree));

    const cfg = () => vscode.workspace.getConfiguration('lmt');
    const cookieOf = () => cfg().get<string>('leetcodeCookie') ?? '';

    // ================= 已知题目登记（自动同步的题池）=================
    // 来源：打开/保存过题目文件、已有记录、启动时扫描题目目录
    const knownSlugs = (): Record<string, number> => ctx.globalState.get<object>('lmt.knownSlugs') as any ?? {};
    const rememberSlug = (slug: string) => {
        if (!slug) { return; }
        const m = knownSlugs();
        if (m[slug] && Date.now() - m[slug] < 60_000) { return; }
        m[slug] = Date.now();
        if (Object.keys(m).length > 300) { // 剪掉 90 天没碰过的
            const cut = Date.now() - 90 * 86400_000;
            for (const k of Object.keys(m)) { if (m[k] < cut) { delete m[k]; } }
        }
        void ctx.globalState.update('lmt.knownSlugs', m);
    };
    const seedFromWorkspace = () => {
        const dir = path.join(problemsRoot(), 'leetcode', 'editor', 'cn');
        if (!fs.existsSync(dir)) { return; }
        for (const f of fs.readdirSync(dir)) {
            const g = guessProblemFromFileName(f);
            if (g?.slug) { rememberSlug(g.slug); }
        }
    };
    // 独立化迁移：检测到 labuladong 旧目录就接管为 lmt.problemsDir（一次性，此后不再读它的配置）
    void adoptProblemsRoot(ctx).then(() => seedFromWorkspace()).catch(() => { });

    const activeSlugs = (): string[] => {
        const now = Date.now();
        const fromWatch = Object.entries(knownSlugs()).filter(([, t]) => now - t < ACTIVE_MS).map(([s]) => s);
        const fromRecs = store.load()
            .filter(r => Math.max(0, ...r.attempts.map(a => a.ts)) > now - ACTIVE_MS)
            .map(r => r.slug).filter(Boolean);
        return [...new Set([...fromWatch, ...fromRecs])];
    };
    const allSlugs = (): string[] => {
        const fromRecs = store.load().map(r => r.slug).filter(Boolean);
        return [...new Set([...fromRecs, ...Object.keys(knownSlugs())])];
    };

    // ================= AI 归因（拿失败提交代码，对照 AC 代码）=================
    async function attributeProblem(qid: number): Promise<AiResult> {
        const rec = store.byQid(qid);
        if (!rec) { throw new Error('本地没有该题记录'); }
        const fails = rec.attempts.filter(a => a.status !== 'AC').sort((a, b) => b.ts - a.ts);
        const fail = fails[0];
        if (!fail) { throw new Error('该题没有失败提交'); }
        const cookie = cookieOf();
        let code = '';
        if (fail.id && cookie) {
            try { code = (await fetchSubmissionDetail(fail.id, cookie)).code ?? ''; } catch { /* 拿不到就退回快照 */ }
        }
        if (!code) { code = rec.codeSnapshot ?? ''; }
        const ac = rec.attempts.filter(a => a.status === 'AC').sort((a, b) => b.ts - a.ts)[0];
        let acCode = '';
        if (ac?.id && cookie && ac.id !== fail.id) {
            try { acCode = (await fetchSubmissionDetail(ac.id, cookie)).code ?? ''; } catch { /* 忽略 */ }
        }
        // 判定详情：优先实时提交时存的 failInfo（WA 用例三件套）；旧记录走 check REST 接口拉 RE 栈 / WA 用例
        const verdict = fail.failInfo ?? (fail.id && cookie
            ? await fetchVerdict(fail.id, cookie).then(v => v.failInfo ?? '').catch(() => '')
            : '');
        const r = await analyzeWithAi(
            `${rec.qid}. ${rec.title || rec.slug}（https://leetcode.cn/problems/${rec.slug}/）`,
            code.slice(0, 6000),
            `最近一次失败提交：${STATUS_LABEL[fail.status] ?? fail.status}${fail.lang ? `（${fail.lang}）` : ''}${ac ? '；该题后来已 AC，可对比两版代码' : '；该题尚未通过'}${verdict ? `\n## 判定详情\n${verdict}` : ''}`,
            acCode.slice(0, 4000));
        const errorTypes = rec.errorTypes.includes(r.type) ? rec.errorTypes : [...rec.errorTypes, r.type];
        store.upsert({
            ...rec, errorTypes,
            ai: { type: r.type, summary: r.summary ? `${r.summary}${r.fixHint ? ' → ' + r.fixHint : ''}` : '', ts: Date.now() },
            codeSnapshot: rec.codeSnapshot ?? code.slice(0, 20_000)
        });
        afterChange();
        return r;
    }

    const pendingAttribution = (): Rec[] => store.load()
        .filter(r => isMistake(r) && !r.ai && r.attempts.some(a => a.status !== 'AC'))
        .sort((a, b) => Math.max(...b.attempts.map(x => x.ts)) - Math.max(...a.attempts.map(x => x.ts)));

    // ================= 同步（手动带进度条 / 自动静默）=================
    let syncing = false;
    let failNotified = false; // 静默失败每次会话只提醒一次，避免刷屏
    async function doSync(slugs: string[], silent: boolean): Promise<{ added: number; attributed: number }> {
        if (syncing) { return { added: 0, attributed: 0 }; }
        syncing = true;
        let added = 0; let attributed = 0;
        try {
            if (silent) {
                added = (await syncSlugs(ctx, store, slugs)).added;
            } else {
                added = (await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: '错题本: 同步 LeetCode 提交…' },
                    p => syncSlugs(ctx, store, slugs, (msg, inc) => p.report({ message: msg, increment: inc })))).added;
            }
            await ctx.globalState.update('lmt.lastSync', Date.now());
            failNotified = false;
            afterChange();
            void refreshFavorites(); // 顺带同步 LeetCode 侧题单（网页端改了收藏夹，这边跟着变）
            // 自动归因新错题（限流，防首次导入历史时爆量）
            const cap = cfg().get<number>('autoAnalyzePerSync') ?? 5;
            if (cap > 0) {
                for (const r of pendingAttribution().slice(0, cap)) {
                    try { await attributeProblem(r.qid); attributed++; } catch { /* 单题失败不阻塞 */ }
                    await sleep(300);
                }
            }
        } catch (e: any) {
            // cookie 服务端作废时同步会静默拉空，这里显式报告并标记（「记录与整理」视图会显示）
            if (e.message === 'COOKIE_EXPIRED') {
                await ctx.globalState.update('lmt.cookieDeadAt', Date.now());
                refreshOverviews();
            } else {
                await ctx.globalState.update('lmt.cookieDeadAt', undefined);
            }
            const msg = e.message === 'COOKIE_EXPIRED'
                ? 'Cookie 已失效（服务端已提前作废），需要重新粘贴一份' : e.message;
            if (silent) {
                if (!failNotified) {
                    failNotified = true;
                    const pick = await vscode.window.showWarningMessage(`自动同步失败: ${msg}`, '一键续期 Cookie');
                    if (pick === '一键续期 Cookie') { await vscode.commands.executeCommand('lmt.refreshCookie'); }
                }
            } else {
                const pick = await vscode.window.showErrorMessage(`同步失败: ${msg}`, '一键续期 Cookie');
                if (pick === '一键续期 Cookie') { await vscode.commands.executeCommand('lmt.refreshCookie'); }
            }
        } finally { syncing = false; }
        return { added, attributed };
    }

    const silentSync = (slugs: string[]) => doSync(slugs, true).then(({ added, attributed }) => {
        if (added > 0 || attributed > 0) {
            vscode.window.showInformationMessage(
                `错题本 自动同步：新入库 ${added} 条提交${attributed ? `，AI 已归因 ${attributed} 题` : ''}`, '看仪表盘')
                .then(pick => { if (pick === '看仪表盘') { void vscode.commands.executeCommand('lmt.openDashboard'); } });
        }
    });

    // —— 同步（手动：全量已知题 + 进度条）——
    const sync = vscode.commands.registerCommand('lmt.sync', async () => {
        const slugs = allSlugs();
        if (slugs.length === 0) {
            vscode.window.showInformationMessage('还没有已知题目：用「打开题目」生成一道（文件名会自动登记），或先提交一题。');
            return;
        }
        const { added, attributed } = await doSync(slugs, false);
        if (added > 0) { vscode.window.showInformationMessage(`同步完成：新入库 ${added} 条提交记录${attributed ? `，AI 已归因 ${attributed} 题` : ''}`); }
        else { vscode.window.showInformationMessage(attributed ? `同步完成：无新提交，AI 补归因 ${attributed} 题` : '同步完成：没有新的提交记录'); }
    });

    // ================= 自动触发器 =================
    // 1) 启动 8 秒后：cookie 就绪且距上次同步 >10 分钟 → 静默同步一轮
    const startupTimer = setTimeout(() => {
        if (!cookieOf()) { return; }
        void refreshFavorites();
        // 顺带做一次登录态探测：JWT 没到期也可能被服务端提前作废，作废要在概览里亮出来
        void verifyCookie(cookieOf()).then(async who => {
            const dead = !who;
            const was = !!ctx.globalState.get<number>('lmt.cookieDeadAt');
            if (dead !== was) {
                await ctx.globalState.update('lmt.cookieDeadAt', dead ? Date.now() : undefined);
                refreshOverviews();
            }
        }).catch(() => { /* 网络问题不标记 */ });
        const ls = ctx.globalState.get<number>('lmt.lastSync') ?? 0;
        if (Date.now() - ls > 10 * 60_000) { void silentSync(activeSlugs()); }
    }, 8_000);
    ctx.subscriptions.push({ dispose: () => clearTimeout(startupTimer) });

    // 2) 定时（默认 15 分钟）
    const minutes = cfg().get<number>('autoSyncMinutes') ?? 15;
    if (minutes > 0) {
        const timer = setInterval(() => { if (cookieOf()) { void silentSync(activeSlugs()); } }, minutes * 60_000);
        ctx.subscriptions.push({ dispose: () => clearInterval(timer) });
    }

    // 3) 保存/切换/打开题目文件 → 登记该题并 5 秒后单独同步它（提交完立刻入库的关键路径）
    let fileDebounce: NodeJS.Timeout | undefined;
    const trackDoc = (doc: vscode.TextDocument | undefined) => {
        if (!doc) { return; }
        const g = problemGuessOf(doc);
        // 编辑器右上角 🚀提交 🐞调试 🔍回放 图标按钮的显示条件
        void vscode.commands.executeCommand('setContext', 'lmt.isProblemFile', !!g);
        if (!g) { return; }
        const register = (slug: string) => {
            rememberSlug(slug);
            if (fileDebounce) { clearTimeout(fileDebounce); }
            fileDebounce = setTimeout(() => { void silentSync([slug]); }, 5_000);
        };
        if (g.slug) { register(g.slug); return; }
        if (g.qid > 0) {
            // 文件里只有题号没有 slug（旧文件名风格）→ 题库元数据反查
            void allQuestions(ctx).then(map => {
                const slug = map.get(g.qid)?.slug;
                if (slug) { register(slug); }
            }).catch(() => { /* 反查失败不影响按钮显示 */ });
        }
    };
    ctx.subscriptions.push(vscode.workspace.onDidSaveTextDocument(d => trackDoc(d)));
    ctx.subscriptions.push(vscode.workspace.onDidOpenTextDocument(d => trackDoc(d)));
    ctx.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(e => trackDoc(e?.document)));

    // —— 代码内悬浮按钮（CodeLens，labuladong 同款形态）：题目文件的代码区上方挂 🚀提交 / ↩️重置 / 🐞调试 / 🔍回放全部，
    //    每个 @lcpr case 块上方再挂一个 🔍回放 case N，方便用不同用例分别回放 ——
    const lensChanged = new vscode.EventEmitter<void>();
    const codeLensProvider: vscode.CodeLensProvider = {
        onDidChangeCodeLenses: lensChanged.event,
        provideCodeLenses: (doc: vscode.TextDocument) => {
            if (!problemGuessOf(doc)) { return []; }
            const text = doc.getText();
            const line = problemLensAnchor(text);
            const range = new vscode.Range(line, 0, line, 0);
            const lenses = [
                new vscode.CodeLens(range, { title: '🚀 提交', command: 'lmt.submit' }),
                new vscode.CodeLens(range, { title: '↩️ 重置', command: 'lmt.resetProblem' }),
                new vscode.CodeLens(range, { title: '🐞 调试', command: 'lmt.debugCurrent' }),
                new vscode.CodeLens(range, { title: '🔍 回放全部', command: 'lmt.visualizeCurrent' })
            ];
            for (const c of problemCaseAnchors(text)) {
                lenses.push(new vscode.CodeLens(new vscode.Range(c.line, 0, c.line, 0), {
                    title: `🔍 回放 case ${c.no}${c.preview ? ` · ${c.preview}` : ''}`,
                    command: 'lmt.visualizeCurrent',
                    arguments: [c.no]
                }));
            }
            return lenses;
        }
    };
    ctx.subscriptions.push(vscode.languages.registerCodeLensProvider({ language: 'python' }, codeLensProvider));
    ctx.subscriptions.push(lensChanged);

    // 4) 窗口重新聚焦 → 距上次同步 >5 分钟则静默同步
    ctx.subscriptions.push(vscode.window.onDidChangeWindowState(s => {
        if (!s.focused || !cookieOf()) { return; }
        const ls = ctx.globalState.get<number>('lmt.lastSync') ?? 0;
        if (Date.now() - ls > 5 * 60_000) { void silentSync(activeSlugs()); }
    }));

    // 启动时按当前活动编辑器初始化题目文件上下文（Reload 恢复的文件不会触发切换事件）
    trackDoc(vscode.window.activeTextEditor?.document);

    // ================= 命令 =================
    // —— 记录本次提交结果（离线备用通道；自动同步开启时基本用不到）——
    const recordResult = vscode.commands.registerCommand('lmt.recordResult', async (item?: TreeEntry) => {
        let guess = item?.meta?.qid
            ? { qid: item.meta.qid, slug: item.meta.slug ?? '' }
            : guessProblemFromEditor(vscode.window.activeTextEditor);
        if (guess && !guess.qid && guess.slug) {
            try { const m = await findBySlug(ctx, guess.slug); if (m) { guess = { qid: m.qid, slug: m.slug }; } } catch { /* 离线容忍 */ }
        }
        if (!guess || !guess.qid) {
            const input = await vscode.window.showInputBox({ prompt: '当前文件无法识别题号，请输入题号', validateInput: v => /^\d+$/.test(v) ? undefined : '纯数字' });
            if (!input) { return; }
            guess = { qid: Number(input), slug: guess?.slug ?? '' };
        }
        const status = await vscode.window.showQuickPick(
            ['✅ AC 通过', '❌ WA 答案错误', '⏱ TLE 超时', '💾 MLE 超内存', '💥 RE 运行错误', '📝 CE 编译错误'],
            { placeHolder: `${guess.qid} 号题 · 本次提交结果？` });
        if (!status) { return; }
        const code = status.includes('AC') ? undefined : status.includes('WA') ? 'WA'
            : status.includes('TLE') ? 'TLE' : status.includes('MLE') ? 'MLE'
            : status.includes('RE') ? 'RE' : 'CE';

        let title = '', difficulty = '', slug = guess.slug;
        try {
            const meta = (await allQuestions(ctx)).get(guess.qid);
            if (meta) { title = meta.title; difficulty = meta.difficulty; slug = slug || meta.slug; }
        } catch { /* 离线时容忍，仅缺元数据 */ }

        const editor = vscode.window.activeTextEditor;
        const lang = editor?.document.languageId;
        const rec: Rec = {
            qid: guess.qid, slug, title, difficulty,
            attempts: [{ ts: Date.now(), status: code!, lang, note: '手动记录' }],
            errorTypes: [],
            codeSnapshot: editor?.document.getText().slice(0, 20_000)
        };
        const merged = store.upsert(rec);
        afterChange();
        const wrong = isMistake(merged);
        vscode.window.showInformationMessage(
            `已记录 ${guess.qid}. ${title || slug} → ${code}${wrong ? '（错题）' : '（一次通过 🎉）'}`,
            ...(wrong ? ['AI 归因'] : []), ...(wrong ? ['导出错题 md'] : [])
        ).then(async pick => {
            if (pick === 'AI 归因') { await vscode.commands.executeCommand('lmt.analyze', merged.qid); }
            if (pick === '导出错题 md') { await vscode.commands.executeCommand('lmt.exportNotes', merged.qid); }
        });
    });

    // —— AI 归因当前题（支持：树节点参数 / 编辑器文件名 / 快速挑选错题）——
    const analyze = vscode.commands.registerCommand('lmt.analyze', async (arg?: number | TreeEntry) => {
        let qid = 0;
        if (typeof arg === 'number') { qid = arg; }
        else if (arg && (arg as TreeEntry).meta?.qid) { qid = (arg as TreeEntry).meta!.qid!; }
        if (!qid) {
            const guess = guessProblemFromEditor(vscode.window.activeTextEditor);
            if (guess && !guess.qid && guess.slug) {
                try { const m = await findBySlug(ctx, guess.slug); if (m) { guess.qid = m.qid; } } catch { /* 离线容忍 */ }
            }
            qid = guess?.qid ?? 0;
        }
        if (!qid) {
            const wrongs = store.load().filter(isMistake)
                .sort((a, b) => Math.max(...b.attempts.map(x => x.ts)) - Math.max(...a.attempts.map(x => x.ts)));
            if (wrongs.length === 0) {
                vscode.window.showWarningMessage('暂无错题可归因：先同步提交记录，或用「记录本次结果」记一题。');
                return;
            }
            const pick = await vscode.window.showQuickPick(
                wrongs.map(r => ({ label: `${r.qid}. ${r.title || r.slug}`, description: `错 ${mistakeCount(r)} 次`, qid: r.qid })),
                { placeHolder: '当前文件不是题目，选择要归因的错题' });
            if (!pick) { return; }
            qid = pick.qid;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '错题本: AI 归因中…' },
            async () => {
                try {
                    const r = await attributeProblem(qid);
                    const pick = await vscode.window.showInformationMessage(
                        `AI 归因: ${ERROR_TYPE_LABEL[r.type] ?? r.type} —— ${r.summary}`, '导出错题 md');
                    if (pick === '导出错题 md') { await vscode.commands.executeCommand('lmt.exportNotes', qid); }
                } catch (e: any) {
                    vscode.window.showErrorMessage(`AI 归因失败: ${e.message}`);
                }
            });
    });

    // —— 批量 AI 归因全部未归因错题 ——
    const analyzeAll = vscode.commands.registerCommand('lmt.analyzeAll', async () => {
        const pending = pendingAttribution();
        if (pending.length === 0) {
            vscode.window.showInformationMessage(store.load().filter(isMistake).length
                ? '所有错题都已归因 ✓' : '暂无错题');
            return;
        }
        await vscode.window.withProgress(
            { location: vscode.ProgressLocation.Notification, title: `错题本: 批量 AI 归因（${pending.length} 题）…` },
            async p => {
                let n = 0;
                for (let i = 0; i < pending.length; i++) {
                    p.report({ message: `${pending[i].qid}. ${pending[i].title || pending[i].slug}（${i + 1}/${pending.length}）`, increment: 100 / pending.length });
                    try { await attributeProblem(pending[i].qid); n++; } catch { /* 单题失败不阻塞 */ }
                    await sleep(400);
                }
                afterChange();
                const byType: Record<string, number> = {};
                for (const w of store.load().filter(isMistake)) {
                    if (w.ai) { byType[w.ai.type] = (byType[w.ai.type] ?? 0) + 1; }
                }
                const parts = Object.entries(byType).map(([t, c]) => `${ERROR_TYPE_LABEL[t] ?? t} ${c}`).join(' · ');
                vscode.window.showInformationMessage(`批量归因完成：本次 ${n} 题${parts ? `，错题构成：${parts}` : ''}`);
            });
    });

    // —— Python Tutor 式执行录像：逐步录制 + 回放 ——
    const bus = new VizEventBus();
    bus.register(ctx);
    const logShow = (c: vscode.ExtensionContext) => { log(c).show(); };
    const problemFileGuards = async (): Promise<{ doc: vscode.TextDocument; ws: string } | undefined> => {
        const ws = problemsRoot();
        const doc = vscode.window.activeTextEditor?.document;
        if (doc && doc.languageId === 'python') {
            const inLeetcodeDir = doc.uri.fsPath.includes('/leetcode/') || doc.uri.fsPath.startsWith(ws);
            if ((inLeetcodeDir && guessProblemFromFileName(doc.uri.fsPath)) || lcMarkerQid(doc.uri.fsPath)) {
                return { doc, ws };
            }
        }
        // 活动文件不是题目文件：直接列出刷题目录里的题目文件让用户挑，而不是只弹个警告
        const files = listProblemFiles().slice(0, 30);
        if (files.length === 0) {
            vscode.window.showWarningMessage('请先打开一个 Python 题目文件，或用「打开题目」从题库生成一道。', '打开题目').then(pick => {
                if (pick === '打开题目') { void vscode.commands.executeCommand('lmt.startProblem'); }
            });
            return undefined;
        }
        const pick = await vscode.window.showQuickPick(
            files.map(f => ({ label: path.basename(f), full: f, description: '最近打开的题目文件' })),
            { placeHolder: '当前文件不是题目文件——选一道题来调试/回放' });
        if (!pick) { return undefined; }
        const picked = await vscode.workspace.openTextDocument(pick.full);
        await vscode.window.showTextDocument(picked, vscode.ViewColumn.One);
        return { doc: picked, ws };
    };
    const debugLaunchConfig = (doc: vscode.TextDocument, ws: string, caseNo?: number): vscode.DebugConfiguration => ({
        type: 'debugpy',
        name: `错题本: 调试 ${path.basename(doc.uri.fsPath)}`,
        request: 'launch',
        program: ensureDriver(ctx),
        args: [doc.uri.fsPath, ...(caseNo ? [String(caseNo)] : [])], // 第二个参数 = 只跑第 N 个 case（CodeLens 单用例回放用）
        cwd: path.dirname(doc.uri.fsPath),
        console: 'integratedTerminal',
        justMyCode: true
    });
    /** 🐞调试/🔍回放 需要 ms-python.debugpy（调试引擎）+ ms-python.python（解释器发现）：缺了给一键安装入口，其余功能（提交/错题/AI）不受影响 */
    const ensureDebugDeps = async (): Promise<boolean> => {
        const missing: Array<[string, string]> = [];
        if (!vscode.extensions.getExtension('ms-python.debugpy')) { missing.push(['ms-python.debugpy', 'Python 调试器 (debugpy)']); }
        if (!vscode.extensions.getExtension('ms-python.python')) { missing.push(['ms-python.python', 'Python 扩展']); }
        if (missing.length === 0) { return true; }
        const pick = await vscode.window.showErrorMessage(
            `🐞 调试 / 🔍 回放需要安装：${missing.map(m => m[1]).join(' + ')}（提交与错题记录不受影响）`, '去安装');
        if (pick === '去安装') {
            for (const [id] of missing) { void vscode.env.openExternal(vscode.Uri.parse(`vscode:extension/${id}`)); }
        }
        return false;
    };
    const visualizeCurrent = vscode.commands.registerCommand('lmt.visualizeCurrent', async (arg?: unknown) => {
        // CodeLens 单用例回放传 case 序号（number）；编辑器右上角按钮/命令面板会传 URI 或不传 → 回放全部
        const caseNo = typeof arg === 'number' && Number.isInteger(arg) && arg > 0 ? arg : undefined;
        // 先清掉残留的调试会话（上次异常中止留下的僵尸会话会让本次直接报 session not found）
        while (vscode.debug.activeDebugSession) {
            try { await vscode.commands.executeCommand('workbench.action.debug.stop'); } catch { break; }
            await new Promise(r => setTimeout(r, 400));
        }
        const g = await problemFileGuards();
        if (!g) { return; }
        if (!(await ensureDebugDeps())) { return; }
        await g.doc.save();
        let rec: Awaited<ReturnType<typeof recordSteps>>;
        try {
            rec = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `错题本: 逐步录制${caseNo ? ` case ${caseNo}` : ''}（最多 150 步）…` },
                () => recordSteps(ctx, bus, {
                    driverPath: ensureDriver(ctx),
                    solutionPath: g.doc.uri.fsPath,
                    solutionText: g.doc.getText(),
                    launchConfig: debugLaunchConfig(g.doc, g.ws, caseNo)
                }));
        } catch (e: any) {
            const pick = await vscode.window.showErrorMessage(`可视化失败: ${e.message}`, '查看诊断日志');
            if (pick === '查看诊断日志') { logShow(ctx); }
            return;
        }
        if (rec.steps.length === 0) {
            const pick = await vscode.window.showErrorMessage('录制失败：没抓到任何执行步骤（先用 🐞 确认这题能正常调试）', '查看诊断日志');
            if (pick === '查看诊断日志') { logShow(ctx); }
            return;
        }
        const panel = vscode.window.createWebviewPanel('lmt.viz',
            `执行回放 · ${path.basename(g.doc.uri.fsPath)}${caseNo ? ` · case ${caseNo}` : ''}`,
            vscode.ViewColumn.Beside, { enableScripts: true });
        panel.webview.html = renderVizHtml(rec.steps, g.doc.getText(),
            `${path.basename(g.doc.uri.fsPath)} · 每步的调用栈与变量`, rec.resultsText, rec.diag);
        panel.reveal(vscode.ViewColumn.Beside);
        vscode.window.showInformationMessage(
            `回放已生成：${rec.steps.length} 步${rec.resultsText ? ' · 含全部用例结果' : ''}（页面右侧已打开，滑块或 ←/→ 键回放）`);
    });

    // —— 断点调试当前题：通用驱动 import 题目文件 + 解析 @lcpr case，断点下在题目文件里 ——
    const debugCurrent = vscode.commands.registerCommand('lmt.debugCurrent', async () => {
        const g = await problemFileGuards();
        if (!g) { return; }
        if (!(await ensureDebugDeps())) { return; }
        await g.doc.save(); // 调试跑的是磁盘内容
        const ok = await vscode.debug.startDebugging(undefined, debugLaunchConfig(g.doc, g.ws));
        if (!ok) {
            vscode.window.showErrorMessage('启动调试失败：请确认已安装 Python 扩展与 debugpy（ms-python.python + ms-python.debugpy）。');
        }
    });

    // —— 一键续期 Cookie：粘贴一次配好错题本（若同时用 labuladong 插件，顺带续期它的会话）——
    const refreshCookie = vscode.commands.registerCommand('lmt.refreshCookie', async () => {
        const text = await vscode.window.showInputBox({
            title: '一键续期 Cookie（粘贴后自动验证并配置到错题本）',
            placeHolder: '浏览器 F12 → Network → 任一请求的 cookie 整行，或 Copy as cURL 的内容',
            prompt: '内容需同时包含 LEETCODE_SESSION= 和 csrftoken= 两个词',
            ignoreFocusOut: true,
            password: true
        });
        if (!text) { return; }
        const parsed = parseCookieString(text);
        if (!parsed) {
            vscode.window.showErrorMessage('解析失败：内容里没同时找到 LEETCODE_SESSION= 和 csrftoken=。请复制请求头里完整的 cookie 值再试。');
            return;
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '错题本: 正在验证 Cookie…' }, async () => {
            let username: string | undefined;
            try { username = await verifyCookie(parsed.full); }
            catch (e: any) {
                vscode.window.showErrorMessage(`验证请求失败: ${e.message}`);
                return;
            }
            if (!username) {
                vscode.window.showErrorMessage('Cookie 无效（leetcode.cn 说未登录）：请确认浏览器已登录 leetcode.cn 且复制的是最新 cookie。');
                return;
            }
            const info = decodeSession(parsed.sessionId);
            await vscode.workspace.getConfiguration('lmt').update('leetcodeCookie', parsed.full, vscode.ConfigurationTarget.Global);
            await ctx.globalState.update('lmt.cookieDeadAt', undefined);
            refreshOverviews();
            try { writeLabuladongSession(labuladongUserFile(), parsed, { ...info, login: username }); } catch { /* 不阻塞主流程 */ }
            const until = info.expiresAt ? new Date(info.expiresAt * 1000).toLocaleDateString('zh-CN') : '未知';
            vscode.window.showInformationMessage(
                `Cookie 已续期 ✓ 用户 ${username}，有效期至 ${until}。错题同步已生效。`, '立即同步')
                .then(pick => { if (pick === '立即同步') { vscode.commands.executeCommand('lmt.sync'); } });
        });
    });

    // —— 导出错题 markdown ——
    const exportNotes = vscode.commands.registerCommand('lmt.exportNotes', async (qid?: number) => {
        const dir = await resolveNotesDir();
        if (!dir) { return; }
        const c = { dir };
        const recs = qid ? store.load().filter(r => r.qid === qid) : store.load();
        if (recs.length === 0) { vscode.window.showInformationMessage('还没有任何记录可导出'); return; }
        let n = 0; let firstFile = '';
        for (const r of recs) {
            try { const f = await exportRecord(c, r); n++; if (!firstFile) { firstFile = f; } }
            catch (e: any) { vscode.window.showErrorMessage(`导出 ${r.qid} 失败: ${e.message}`); }
        }
        vscode.window.showInformationMessage(`已导出 ${n} 篇错题笔记到 ${dir}`, '打开目录', '预览')
            .then(pick => {
                if (pick === '打开目录') { vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(dir)); }
                if (pick === '预览' && firstFile) { vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(firstFile)); }
            });
    });

    // —— 仪表盘 ——
    // —— 仪表盘统计口径：全部 / 内置（热题100、难度在页面里现算）/ LeetCode 题单 / 导入题单 ——
    // LeetCode 侧题单只收录题目已加载过（展开过、favItems.json 里有缓存）的，没加载的在题单树里点开一次即可
    const dashScopes = (): DashScope[] => {
        const out: DashScope[] = [];
        const fav = readJson(favCacheFile);
        const items = readJson(favItemsFile) ?? {};
        if (fav) {
            for (const f of (fav.created ?? []) as any[]) {
                const qs = items[f.slug]?.questions;
                if (qs?.length) {
                    out.push({ id: 'fav:' + f.slug, group: '我的题单', name: f.name,
                        qids: qs.map((q: any) => q.qid).filter(Boolean), slugs: qs.map((q: any) => q.slug), total: qs.length });
                }
            }
            for (const f of (fav.collected ?? []) as any[]) {
                const qs = items[f.slug]?.questions;
                if (qs?.length) {
                    out.push({ id: 'fav:' + f.slug, group: '收藏的题单', name: f.name,
                        qids: qs.map((q: any) => q.qid).filter(Boolean), slugs: qs.map((q: any) => q.slug), total: qs.length });
                }
            }
        }
        for (const L of loadLists(storageDir)) {
            out.push({ id: 'list:' + L.id, group: '导入题单', name: L.name, slugs: L.items, total: L.items.length });
        }
        return out;
    };

    const openDashboard = vscode.commands.registerCommand('lmt.openDashboard', () => {
        const panel = vscode.window.createWebviewPanel('lmt.dashboard', 'LeetCode 错题本 · 统计',
            vscode.ViewColumn.One, { enableScripts: true, enableCommandUris: true });
        panel.webview.html = renderDashboard(store, tree, dashScopes());
        panel.webview.onDidReceiveMessage(() => { refreshOverviews(); });
    });

    // —— 打开题目（原生：本地有文件直接开，没有则拉题面/模板/用例生成；不依赖 labuladong）——
    const startProblem = vscode.commands.registerCommand('lmt.startProblem', async (item?: TreeEntry) => {
        let slug = item?.meta?.slug;
        if (!slug) {
            const guess = guessProblemFromEditor(vscode.window.activeTextEditor);
            if (guess?.slug) {
                const local = listProblemFiles().find(f => path.basename(f) === `${guess.qid}.${guess.slug}.py` || path.basename(f) === `${guess.slug}.py`);
                if (local) {
                    const doc = await vscode.workspace.openTextDocument(local);
                    await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
                    return;
                }
                slug = guess.slug;
            }
        }
        if (!slug) {
            // 全题库搜索（元数据有本地缓存，离线可用）
            let all: Array<{ qid: number; slug: string; title: string; difficulty: string }> = [];
            try { all = [...(await allQuestions(ctx)).values()]; } catch { /* 离线容忍 */ }
            if (all.length === 0) {
                vscode.window.showErrorMessage('题库列表拉取失败（且无本地缓存），请检查网络后重试。');
                return;
            }
            const pick = await vscode.window.showQuickPick(
                all.map(q => ({ label: `${q.qid}. ${q.title}`, description: q.difficulty, slug: q.slug })),
                { placeHolder: `搜索题目（共 ${all.length} 题，输入编号或关键字）`, matchOnDescription: true });
            if (!pick) { return; }
            slug = pick.slug;
        }
        try {
            const file = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `错题本: 打开题目 ${slug}…` },
                async () => {
                    const qd = await fetchQuestionDetail(slug!, cookieOf() || undefined);
                    return openOrCreate(qd, slug!);
                });
            const doc = await vscode.workspace.openTextDocument(file);
            await vscode.window.showTextDocument(doc, vscode.ViewColumn.One);
            rememberSlug(slug);
            vscode.window.showInformationMessage(
                `${path.basename(file)} 已就绪：写完解法后 🚀 提交、🐞 调试、🔍 回放都用得上（右上角图标）`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`打开题目失败: ${e.message}`);
        }
    });

    // —— 提交当前题（leetcode.cn 原生提交 + 轮询判定 + 自动入库；失败可直接 AI 归因）——
    const submit = vscode.commands.registerCommand('lmt.submit', async () => {
        const guess = guessProblemFromEditor(vscode.window.activeTextEditor);
        let slug = guess?.slug ?? '';
        if (!slug) {
            // 文件名只有题号或认不出（驼峰旧文件名）→ @lc 标记/文件名题号反查题库拿 slug
            const qid = guess?.qid ?? (vscode.window.activeTextEditor ? lcMarkerQid(vscode.window.activeTextEditor.document.uri.fsPath) : undefined) ?? 0;
            if (qid > 0) {
                try { slug = (await allQuestions(ctx)).get(qid)?.slug ?? ''; } catch { /* 反查失败走下面的文件选择兜底 */ }
            }
        }
        if (!slug) {
            const files = listProblemFiles().slice(0, 30);
            if (files.length === 0) {
                vscode.window.showWarningMessage('先打开一个题目文件再提交（或用「打开题目」生成）。', '打开题目')
                    .then(p => { if (p === '打开题目') { void vscode.commands.executeCommand('lmt.startProblem'); } });
                return;
            }
            const pick = await vscode.window.showQuickPick(
                files.map(f => ({ label: path.basename(f), full: f, description: '选择要提交的题目文件' })),
                { placeHolder: '当前文件不是题目文件——选一个要提交的题目' });
            if (!pick) { return; }
            const g = guessProblemFromFileName(pick.full);
            slug = g?.slug ?? '';
        }
        if (!slug) { vscode.window.showWarningMessage('无法从文件名识别题目'); return; }

        const cookie = cookieOf();
        if (!cookie) {
            const p = await vscode.window.showErrorMessage('提交需要 leetcode.cn Cookie（未配置）', '一键续期 Cookie');
            if (p) { await vscode.commands.executeCommand('lmt.refreshCookie'); }
            return;
        }
        const editor = vscode.window.activeTextEditor;
        const code = editor?.document.getText() ?? '';
        if (!code.includes('class Solution')) {
            vscode.window.showWarningMessage('当前文件里没有 class Solution，先写好解法再提交。');
            return;
        }
        await editor?.document.save();

        let result: { status: string; runtime?: string; memory?: string; id?: string; brief?: string; failInfo?: string } | undefined;
        try {
            result = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `错题本: 提交 ${slug} 到 leetcode.cn…` },
                async p => {
                    const qd = await fetchQuestionDetail(slug, cookie); // 拿内部 questionId（提交必需；会员题也需 cookie）
                    p.report({ message: '已提交，等待判定…' });
                    const sid = await submitCode(slug, qd.questionId, code, 'python3', cookie);
                    const outcome = await waitSubmission(sid, cookie, i => p.report({ message: `判定中…（${i + 1}s）` }));
                    const det = await fetchSubmissionDetail(String(sid), cookie); // 权威状态文案 + 代码回执
                    return { status: det.status ?? 'CE', runtime: det.runtime, memory: det.memory, id: String(sid), brief: outcome.brief, failInfo: outcome.failInfo };
                });
        } catch (e: any) {
            const msg = e.message === 'COOKIE_EXPIRED'
                ? 'Cookie 已失效（服务端已提前作废），需要重新粘贴一份' : e.message;
            await ctx.globalState.update('lmt.cookieDeadAt', e.message === 'COOKIE_EXPIRED' ? Date.now() : undefined);
            refreshOverviews();
            const p = await vscode.window.showErrorMessage(`提交失败: ${msg}`, '一键续期 Cookie');
            if (p) { await vscode.commands.executeCommand('lmt.refreshCookie'); }
            return;
        }

        // 入库（带提交 id：与后续同步自动去重合并）
        let qid = guess?.qid ?? 0;
        let title = '', difficulty = '';
        try {
            const qd = await fetchQuestionDetail(slug, cookie);
            qid = Number(qd.frontendId) || qid;
            title = qd.title; difficulty = qd.difficulty;
        } catch { /* 元数据缺失不阻塞 */ }
        store.upsert({
            qid, slug, title, difficulty, errorTypes: [],
            attempts: [{ ts: Date.now(), status: result.status, lang: 'python3', runtime: result.runtime, id: result.id, failInfo: result.failInfo }],
            codeSnapshot: code.slice(0, 20_000)
        });
        afterChange();
        rememberSlug(slug);

        const ok = result.status === 'AC';
        const label = STATUS_LABEL[result.status] ?? result.status;
        if (ok) {
            vscode.window.showInformationMessage(
                `✅ 通过！${qid}. ${title || slug} · ${result.runtime ?? ''}${result.memory ? ' / ' + result.memory : ''}（已自动记录）`,
                '看仪表盘').then(pick => { if (pick === '看仪表盘') { void vscode.commands.executeCommand('lmt.openDashboard'); } });
            return;
        }

        // 失败：完整判定详情（RE 栈 / WA 出错用例）进输出通道，通知里放一行摘要 + 「查看详情」直达
        if (result.failInfo) {
            const ch = log(ctx);
            ch.appendLine(`\n──── ${new Date().toLocaleString('zh-CN')} 提交失败 · ${qid}. ${title || slug}（${label}）────`);
            ch.appendLine(result.failInfo);
        }
        const brief = result.brief ? `\n${result.brief}` : '';

        // 失败：自动判断 + 自动整理。
        // 配了 LLM → 立刻 AI 归因（语法/思路/边界/复杂度入错题本）+ 自动导出错题 md；没配 → 只记错题集。
        if (aiConfigured()) {
            void vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `错题本: AI 整理错题 ${qid}. ${title || slug}…` },
                async () => {
                    try {
                        const r = await attributeProblem(qid);
                        let notePath = '';
                        const dir = silentNotesDir() ?? await resolveNotesDir().catch(() => undefined);
                        if (dir) {
                            try {
                                const oc = { dir };
                                const rec = store.byQid(qid);
                                if (rec) { await exportRecord(oc, rec); notePath = noteFilePath(oc, rec); }
                            } catch { /* 导出失败不阻塞 */ }
                        }
                        vscode.window.showInformationMessage(
                            `🤖 错题已整理: ${ERROR_TYPE_LABEL[r.type] ?? r.type} —— ${r.summary}${notePath ? '（已写错题 md）' : ''}`,
                            ...(notePath ? ['预览笔记'] : []), '可视化回放')
                            .then(async pick => {
                                if (pick === '预览笔记') { await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(notePath)); }
                                if (pick === '可视化回放') { await vscode.commands.executeCommand('lmt.visualizeCurrent'); }
                            });
                    } catch (e: any) {
                        vscode.window.showWarningMessage(`AI 自动整理失败: ${e.message}`, '重试归因')
                            .then(p => { if (p) { void vscode.commands.executeCommand('lmt.analyze', qid); } });
                    }
                });
            vscode.window.showErrorMessage(
                `❌ ${label} · ${qid}. ${title || slug}${brief}（已记入错题集，AI 整理中…）`, '查看详情', '可视化回放')
                .then(async pick => {
                    if (pick === '查看详情') { log(ctx).show(); }
                    if (pick === '可视化回放') { void vscode.commands.executeCommand('lmt.visualizeCurrent'); }
                });
        } else {
            vscode.window.showErrorMessage(
                `❌ ${label} · ${qid}. ${title || slug}${brief}（已记入错题集；未配置 LLM，跳过自动整理）`, '查看详情', '可视化回放', '配置 AI')
                .then(async pick => {
                    if (pick === '查看详情') { log(ctx).show(); }
                    if (pick === '可视化回放') { void vscode.commands.executeCommand('lmt.visualizeCurrent'); }
                    if (pick === '配置 AI') { void vscode.commands.executeCommand('lmt.configAi'); }
                });
        }
    });

    // —— 重置代码区（↩️ CodeLens / 编辑器右上角按钮）：code=start~end 之间恢复初始模板，题干/用例不动 ——
    const resetProblem = vscode.commands.registerCommand('lmt.resetProblem', async () => {
        const g = await problemFileGuards();
        if (!g) { return; }
        const fsPath = g.doc.uri.fsPath;
        const guess = guessProblemFromFileName(fsPath);
        let slug = guess?.slug ?? '';
        if (!slug) {
            const qid = guess?.qid ?? lcMarkerQid(fsPath) ?? 0;
            if (qid > 0) {
                try { slug = (await allQuestions(ctx)).get(qid)?.slug ?? ''; } catch { /* 走下面的提示 */ }
            }
        }
        if (!slug) {
            vscode.window.showWarningMessage('认不出这道题（文件名没有 slug，题号也反查不到），无法拉初始模板。');
            return;
        }
        const who = guess?.qid ? `${guess.qid}. ${slug}` : slug;
        const ok = await vscode.window.showWarningMessage(
            `重置 ${who} 的代码区？当前解法会被丢弃，恢复成初始模板（题干与用例不动，重置后 Cmd+Z 可撤销）`, '重置');
        if (ok !== '重置') { return; }
        try {
            const qd = await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: `错题本: 拉取初始模板 ${who}…` },
                () => fetchQuestionDetail(slug, cookieOf() || undefined));
            const text = g.doc.getText();
            const next = resetCodeRegion(text, qd.python3);
            if (next === undefined) {
                vscode.window.showWarningMessage('文件里没有成对的 # @lc code=start/end 标记，无法定位代码区（老散文件不支持重置）。');
                return;
            }
            if (next === text) {
                vscode.window.showInformationMessage('代码已经是初始模板，无需重置。');
                return;
            }
            const edit = new vscode.WorkspaceEdit();
            edit.replace(g.doc.uri, new vscode.Range(g.doc.positionAt(0), g.doc.positionAt(text.length)), next);
            await vscode.workspace.applyEdit(edit);
            await g.doc.save();
            vscode.window.showInformationMessage(`已重置为初始模板（${path.basename(fsPath)}，Cmd+Z 可撤销）`);
        } catch (e: any) {
            vscode.window.showErrorMessage(`重置失败: ${e.message}`);
        }
    });

    // ================= 题单（我的题单：导入 / 新建 / 加题 / 移除 / 重命名 / 删除） =================
    // —— 导入题单：两步引导。第 1 步选内容来源（剪贴板带识别预览 / 文件），第 2 步命名 ——
    // 识别：题号 / 中英文题名 / slug / URL / markdown 列表表格 / JSON 数组 / 一行连排（顿号·序号·空格分隔），逐行混贴皆可
    const importList = vscode.commands.registerCommand('lmt.importList', async () => {
        const pickFileText = async (): Promise<string | undefined> => {
            const picks = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: '导入题单文件', filters: { '题单文件': ['txt', 'md', 'json', 'csv'] } });
            return picks?.length ? fs.readFileSync(picks[0].fsPath, 'utf8') : undefined;
        };

        let metas: QMetaLite[] = [];
        try { metas = [...(await allQuestions(ctx)).values()]; } catch { /* 离线容忍 */ }
        if (metas.length === 0) {
            try {
                metas = await vscode.window.withProgress(
                    { location: vscode.ProgressLocation.Notification, title: '错题本: 首次拉取全量题库（约 1-2 MB）…' },
                    () => allQuestions(ctx, true).then(m => [...m.values()]));
            } catch (e: any) {
                const fix = await vscode.window.showErrorMessage(
                    `拉取题库失败（导入需要题号↔题名对照）: ${e.message}——检查网络后点「重试」，或稍后再来导入`, '重试');
                if (fix === '重试') { return void vscode.commands.executeCommand('lmt.importList'); }
                return;
            }
        }

        let err = '';
        let goFile = false;
        while (true) {
            // —— 第 1 步：内容从哪来 ——
            let text: string;
            if (goFile) {
                goFile = false;
                text = (await pickFileText()) ?? '';
                if (!text.trim()) { return; }
            } else {
                const clip = (await vscode.env.clipboard.readText()).trim();
                const items: vscode.QuickPickItem[] = [];
                if (clip) {
                    const head = clip.replace(/\s+/g, ' ');
                    items.push({
                        label: '$(clipboard) 用剪贴板内容',
                        description: `能识别 ${parseListInput(clip, metas).slugs.length} 题`,
                        detail: head.slice(0, 60) + (head.length > 60 ? '…' : '')
                    });
                }
                items.push({ label: '$(file) 从文件导入', detail: 'txt / md / json / csv，每行一题' });
                const pick = await vscode.window.showQuickPick(items, {
                    placeHolder: `${err}第 1 步（共 2 步）· 题单内容从哪来？（题号 / 中文题名 / slug / URL 混贴皆可）`
                });
                if (!pick) { return; }
                text = pick.label.includes('剪贴板') ? clip : ((await pickFileText()) ?? '');
                if (!text.trim()) { return; }
            }

            const { slugs, unresolved } = parseListInput(text, metas);
            if (slugs.length === 0) {
                // 报错自带引导三件套：读到了什么 → 认什么格式 → 下一步怎么办；「从文件导入」一键直达文件选择
                const lines = text.split(/\r?\n/).filter(l => l.trim()).length;
                const head = text.trim().replace(/\s+/g, ' ');
                const fix = await vscode.window.showWarningMessage(
                    `一题都没对上——读到的是「${head.slice(0, 36)}${head.length > 36 ? '…' : ''}」（${lines} 行，题库 ${metas.length} 题）。` +
                    '认这些格式：每行一题的 题号 / 完整中文题名 / slug / 题目链接（markdown 前缀、表格竖线自动剥掉），' +
                    '或一整行连排（两数之和、三数之和 / 1. 两数之和 2. 三数之和）。把清单复制成每行一题后重试，或「从文件导入」。', '📂 从文件导入');
                if (fix === '📂 从文件导入') { goFile = true; }
                err = '上次内容一题没对上（读到的内容与支持格式见刚才的通知）。';
                continue;
            }

            // —— 第 2 步：命名 ——
            const stamp = new Date().toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
            const name = await vscode.window.showInputBox({
                prompt: `第 2 步（共 2 步）· 识别 ${slugs.length} 题${unresolved.length ? `（另有 ${unresolved.length} 行未识别）` : ''}——输入题单名称`,
                value: `导入题单 ${stamp}`
            });
            if (name === undefined) { return; }
            const finalName = name.trim() || `导入题单 ${stamp}`;
            const lists = loadLists(storageDir);
            lists.push({ ...newList(finalName), items: slugs });
            saveLists(storageDir, lists);
            tree.refresh();
            vscode.window.showInformationMessage(
                `题单「${finalName}」已导入：识别 ${slugs.length} 题${unresolved.length ? `，未识别 ${unresolved.length} 行（如 "${unresolved[0].slice(0, 30)}"）` : ''}——在「我的题单」里查看`);
            return;
        }
    });

    // 题单内容只来源于导入（不再提供新建空题单/逐题加题的入口）；管理仅保留重命名/删除/单题移除。

    // —— 从题单移除 / 重命名 / 删除题单 ——
    const removeFromList = vscode.commands.registerCommand('lmt.removeFromList', async (item?: TreeEntry) => {
        const slug = item?.meta?.slug; const listId = item?.meta?.listId;
        if (!slug || !listId) { return; }
        const lists = loadLists(storageDir);
        const L = lists.find(x => x.id === listId);
        if (!L) { return; }
        L.items = L.items.filter(s => s !== slug);
        saveLists(storageDir, lists);
        tree.refresh();
    });
    const renameList = vscode.commands.registerCommand('lmt.renameList', async (item?: TreeEntry) => {
        const listId = item?.meta?.listId;
        if (!listId) { return; }
        const lists = loadLists(storageDir);
        const L = lists.find(x => x.id === listId);
        if (!L) { return; }
        const name = await vscode.window.showInputBox({ prompt: '题单新名称', value: L.name });
        if (!name || !name.trim()) { return; }
        L.name = name.trim();
        saveLists(storageDir, lists);
        tree.refresh();
    });
    const deleteList = vscode.commands.registerCommand('lmt.deleteList', async (item?: TreeEntry) => {
        const listId = item?.meta?.listId; const listName = item?.meta?.listName;
        if (!listId) { return; }
        const ok = await vscode.window.showWarningMessage(`删除题单「${listName}」？（只删题单本身，不动错题记录）`, '删除');
        if (ok !== '删除') { return; }
        saveLists(storageDir, loadLists(storageDir).filter(x => x.id !== listId));
        tree.refresh();
    });

    // —— 强制刷新全量题库缓存（树里「题库未缓存」占位节点点击也会到这）——
    const fetchAllQuestions = vscode.commands.registerCommand('lmt.fetchAllQuestions', async () => {
        try {
            await vscode.window.withProgress(
                { location: vscode.ProgressLocation.Notification, title: '错题本: 拉取全量题库…' },
                () => allQuestions(ctx, true));
            tree.refresh();
            vscode.window.showInformationMessage('全量题库缓存已更新。');
        } catch (e: any) {
            vscode.window.showErrorMessage(`题库拉取失败: ${e.message}`);
        }
    });

    // —— 打开题目（浏览器直达题目页）——
    const openProblem = vscode.commands.registerCommand('lmt.openProblem', async (item?: TreeEntry & { slug?: string }) => {
        const slug = item?.meta?.slug;
        if (!slug) { return; }
        await vscode.env.openExternal(vscode.Uri.parse(`https://leetcode.cn/problems/${slug}/`));
    });

    const refreshTree = vscode.commands.registerCommand('lmt.refreshTree', () => { void refreshFavorites(); tree.refresh(); });
    const refreshFavoritesCmd = vscode.commands.registerCommand('lmt.refreshFavorites', () => refreshFavorites());

    // —— 配置题目目录：原生目录选择器（选 leetcode/editor/cn 的上一层）——
    const configProblemsDir = vscode.commands.registerCommand('lmt.configProblemsDir', async () => {
        const pick = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectMany: false,
            defaultUri: vscode.Uri.file(problemsRoot()),
            openLabel: '选为题目根目录'
        });
        if (!pick?.[0]) { return; }
        const root = pick[0].fsPath;
        await vscode.workspace.getConfiguration('lmt').update('problemsDir', root, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(
            `题目目录已设置：${path.join(root, 'leetcode', 'editor', 'cn')}（新题目生成在这里；已有文件不会自动搬家）`);
        refreshOverviews();
    });

    // —— 配置 AI（归因）：三步引导（端点 → Key → 模型），写全局设置 ——
    const configAi = vscode.commands.registerCommand('lmt.configAi', async () => {
        const cfg = vscode.workspace.getConfiguration('lmt');
        const baseUrl = await vscode.window.showInputBox({
            title: '配置 AI 归因（1/3）：API 端点（OpenAI 兼容，自动拼 /chat/completions）',
            value: cfg.get<string>('aiBaseUrl') || 'https://open.bigmodel.cn/api/paas/v4',
            ignoreFocusOut: true
        });
        if (baseUrl === undefined) { return; }
        const apiKey = await vscode.window.showInputBox({
            title: '配置 AI 归因（2/3）：API Key', password: true,
            value: cfg.get<string>('aiApiKey') || '', placeHolder: 'sk-…', ignoreFocusOut: true
        });
        if (apiKey === undefined) { return; }
        const model = await vscode.window.showInputBox({
            title: '配置 AI 归因（3/3）：模型名',
            value: cfg.get<string>('aiModel') || '', placeHolder: '例如 glm-4.6', ignoreFocusOut: true
        });
        if (model === undefined) { return; }
        const target = vscode.ConfigurationTarget.Global;
        await cfg.update('aiBaseUrl', baseUrl.trim(), target);
        await cfg.update('aiApiKey', apiKey.trim(), target);
        await cfg.update('aiModel', model.trim(), target);
        if (aiConfigured()) {
            vscode.window.showInformationMessage(`AI 归因已配置 ✓（${model.trim() || '默认模型'}）。提交失败会自动整理错因。`, '立即批量归因')
                .then(p => { if (p === '立即批量归因') { void vscode.commands.executeCommand('lmt.analyzeAll'); } });
        } else {
            vscode.window.showWarningMessage('三项配置不全，AI 归因仍未启用（点概览「AI 归因 · 未配置」可补全）。');
        }
        refreshOverviews();
    });

    // —— 配置错题 md 目录：直接选目录；旧 Obsidian 配置（vault+子目录）会自动沿用 ——
    const configNotesDir = vscode.commands.registerCommand('lmt.configNotesDir', async () => {
        const cfg = vscode.workspace.getConfiguration('lmt');
        const cur = notesDir();
        const dir = await vscode.window.showOpenDialog({
            canSelectFolders: true, canSelectMany: false,
            defaultUri: vscode.Uri.file(cur || path.join(os.homedir(), 'Documents')),
            title: cur ? `当前错题目录：${cur}（选择新目录更换）` : '选择错题 md 笔记的存放目录',
            openLabel: '选为错题目录'
        });
        if (!dir?.[0]) { return; }
        await cfg.update('notesDirPath', dir[0].fsPath, vscode.ConfigurationTarget.Global);
        vscode.window.showInformationMessage(`错题目录已设置：${dir[0].fsPath}`);
        refreshOverviews();
    });

    // —— 自定义 AI 归因提示词：设置里编辑 / 复制内置默认 / 恢复默认 ——
    const configAiPrompt = vscode.commands.registerCommand('lmt.configAiPrompt', async () => {
        const cfg = vscode.workspace.getConfiguration('lmt');
        const custom = (cfg.get<string>('aiPrompt') ?? '').trim();
        const pick = await vscode.window.showQuickPick([
            { label: '✏️ 在设置中编辑', description: '打开 lmt.aiPrompt（留空 = 使用内置默认提示词）' },
            { label: '📋 复制内置默认提示词', description: '粘贴到 lmt.aiPrompt 上修改即可完全自定义归因行为' },
            ...(custom ? [{ label: '♻️ 恢复内置默认', description: '清空自定义提示词' }] : [])
        ], { placeHolder: custom ? `当前：自定义提示词（${custom.length} 字）` : '当前：内置默认提示词' });
        if (!pick) { return; }
        if (pick.label.startsWith('✏️')) {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'lmt.aiPrompt');
        } else if (pick.label.startsWith('📋')) {
            await vscode.env.clipboard.writeText(DEFAULT_AI_PROMPT);
            vscode.window.showInformationMessage('内置默认提示词已复制，粘贴到 lmt.aiPrompt 中修改即可（注意保留要求输出 JSON 的部分）。');
        } else {
            await cfg.update('aiPrompt', '', vscode.ConfigurationTarget.Global);
            vscode.window.showInformationMessage('已恢复内置默认提示词。');
        }
        refreshOverviews();
    });

    ctx.subscriptions.push(recordResult, analyze, analyzeAll, sync, debugCurrent, visualizeCurrent, refreshCookie, exportNotes, openDashboard, openProblem, startProblem, submit, resetProblem, refreshTree, refreshFavoritesCmd,
        importList, removeFromList, renameList, deleteList, fetchAllQuestions, configProblemsDir, configAi, configNotesDir, configAiPrompt);
}

export function deactivate() { }
