// 统一「题单」树：我的题单（LeetCode 收藏夹/自建题单）· 收藏的题单 · 导入题单 · 热题 100 · 难度分类 · 全部题目
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Rec, isSolved, isMistake, mistakeCount, diffKey } from './store';
import { loadLists, QMetaLite } from './lists';
import { FavFolder, FavQuestion } from './leetcode';

interface Top100Item { qid: number; slug: string; title: string; difficulty: string; group: string; }

/** dashboard 只用到 data()（热题 100 明细）与 refresh() */
export interface ListsData { data(): Top100Item[]; refresh(): void; }

export type EntryKind = 'section' | 'list' | 'favList' | 'group' | 'difficulty' | 'range' | 'problem' | 'placeholder';

export interface EntryMeta {
    kind: EntryKind;
    qid?: number;
    slug?: string;
    section?: 'mine' | 'collected' | 'imports' | 'hot100' | 'difficulty' | 'all';
    listId?: string;
    listName?: string;
    favSlug?: string;
    difficulty?: 'EASY' | 'MEDIUM' | 'HARD';
    rangeFrom?: number;
    rangeTo?: number;
    cmd?: string; // placeholder 节点点击触发的命令
}

/** 由 extension.ts 注入的远端题单异步加载器（拉完写缓存并 refresh 树） */
export interface TreeHooks {
    ensureFolders(): void;
    ensureItems(favSlug: string): void;
}

export class TreeEntry extends vscode.TreeItem {
    constructor(label: string, collapsibleState: vscode.TreeItemCollapsibleState, public meta?: EntryMeta) {
        super(label, collapsibleState);
    }
}

const DIFF_LABEL: Record<string, string> = { EASY: '简单', MEDIUM: '中等', HARD: '困难' };
const DIFF_COLOR: Record<string, string> = {
    EASY: 'testing.iconPassed', MEDIUM: 'editorWarning.foreground', HARD: 'testing.iconFailed'
};

/** 全部题目按题号分块（每块 ~100 题）的区间划分，纯函数便于自测 */
export function rangesOf(metas: QMetaLite[], size = 100): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    for (let i = 0; i < metas.length; i += size) {
        out.push([metas[i].qid, metas[Math.min(i + size, metas.length) - 1].qid]);
    }
    return out;
}

export class ProblemListsTree implements vscode.TreeDataProvider<TreeEntry>, ListsData {
    private _onDidChange = new vscode.EventEmitter<void>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private store: { load(): Rec[] }, private storageDir: string, private hooks?: TreeHooks) { }

    refresh(): void { this._onDidChange.fire(); }
    getTreeItem(el: TreeEntry): vscode.TreeItem { return el; }

    /** 热题 100 明细（随插件打包） */
    data(): Top100Item[] {
        const file = path.join(__dirname, '..', 'data', 'top100.json');
        return JSON.parse(fs.readFileSync(file, 'utf8')) as Top100Item[];
    }

    /** 全量题库元数据：直接同步读 globalStorage 缓存文件（由 allQuestions() 维护，7 天刷新） */
    private allMetas(): QMetaLite[] {
        try {
            const f = path.join(this.storageDir, 'allQuestions.json');
            if (fs.existsSync(f)) {
                const arr = JSON.parse(fs.readFileSync(f, 'utf8')) as Array<[number, string, string, string]>;
                return arr.filter(a => Number.isFinite(a[0]) && a[1])
                    .map(a => ({ qid: a[0], slug: a[1], title: a[2], difficulty: a[3] }));
            }
        } catch { /* 缓存损坏按无缓存处理 */ }
        return [];
    }

    private placeholder(label: string, cmd: string): TreeEntry {
        const node = new TreeEntry(label, vscode.TreeItemCollapsibleState.None, { kind: 'placeholder', cmd });
        node.iconPath = new vscode.ThemeIcon('zap');
        node.command = { command: cmd, title: label };
        return node;
    }

    /** LeetCode 侧题单缓存（favorites.json，由 extension.ts 的 ensureFolders 维护） */
    private favFolders(): { created: FavFolder[]; collected: FavFolder[] } | undefined {
        try {
            const f = path.join(this.storageDir, 'favorites.json');
            if (fs.existsSync(f)) {
                const o = JSON.parse(fs.readFileSync(f, 'utf8'));
                if (o && Array.isArray(o.created) && Array.isArray(o.collected)) {
                    return { created: o.created, collected: o.collected };
                }
            }
        } catch { /* 缓存损坏按无缓存处理 */ }
        return undefined;
    }

    /** 单个题单的题目缓存（favItems.json: { [favSlug]: { at, questions } }，懒加载） */
    private favItems(favSlug: string): FavQuestion[] | undefined {
        try {
            const f = path.join(this.storageDir, 'favItems.json');
            if (fs.existsSync(f)) {
                const o = JSON.parse(fs.readFileSync(f, 'utf8'));
                const it = o?.[favSlug];
                if (it && Array.isArray(it.questions)) { return it.questions; }
            }
        } catch { /* 缓存损坏按无缓存处理 */ }
        return undefined;
    }

    getChildren(el?: TreeEntry): TreeEntry[] {
        const recs = new Map(this.store.load().map(r => [r.qid, r] as const));
        // 统一的题目节点：本地做过显示状态，没做过显示难度（LeetCode 侧题单可再参考服务端进度）；点击 = 本地打开/生成题目文件
        const problemNode = (m: QMetaLite, inList?: { id: string; name: string }, serverStatus?: string): TreeEntry => {
            const node = new TreeEntry(`${m.qid}. ${m.title}`, vscode.TreeItemCollapsibleState.None,
                { kind: 'problem', qid: m.qid, slug: m.slug, ...(inList ? { listId: inList.id, listName: inList.name } : {}) });
            const rec = recs.get(m.qid);
            if (!rec) {
                if (serverStatus === 'SOLVED') {
                    node.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
                    node.description = '远端已过';
                } else if (serverStatus === 'ATTEMPTED') {
                    node.iconPath = new vscode.ThemeIcon('warning', new vscode.ThemeColor('editorWarning.foreground'));
                    node.description = `远端尝试过${DIFF_LABEL[diffKey(m.difficulty)] ? ' · ' + DIFF_LABEL[diffKey(m.difficulty)] : ''}`;
                } else {
                    node.iconPath = new vscode.ThemeIcon('circle-outline');
                    node.description = `未做${DIFF_LABEL[diffKey(m.difficulty)] ? ' · ' + DIFF_LABEL[diffKey(m.difficulty)] : ''}`;
                }
            } else if (isSolved(rec)) {
                node.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
                node.description = isMistake(rec) ? `❌${mistakeCount(rec)} 后 AC` : '一次通过';
            } else {
                node.iconPath = new vscode.ThemeIcon('error', new vscode.ThemeColor('testing.iconFailed'));
                node.description = `❌ ${mistakeCount(rec)} 次`;
            }
            node.contextValue = inList ? 'problemInList' : 'problem';
            node.command = { command: 'lmt.startProblem', title: '打开题目文件', arguments: [{ meta: { kind: 'problem', qid: m.qid, slug: m.slug } } as TreeEntry] };
            return node;
        };

        if (!el) {
            const lists = loadLists(this.storageDir);
            const metas = this.allMetas();
            const fav = this.favFolders();
            const hasCookie = !!vscode.workspace.getConfiguration('lmt').get<string>('leetcodeCookie');
            const top100 = this.data();
            const topDone = top100.filter(t => { const r = recs.get(t.qid); return r && isSolved(r); }).length;
            const n = (d: string) => metas.filter(m => diffKey(m.difficulty) === d).length;

            const mine = new TreeEntry('我的题单', vscode.TreeItemCollapsibleState.Expanded, { kind: 'section', section: 'mine' });
            mine.iconPath = new vscode.ThemeIcon('checklist');
            mine.description = fav ? `${fav.created.length} 个题单` : (hasCookie ? '未加载' : '需登录');
            mine.tooltip = 'LeetCode 账号里的题单（收藏夹/自建），随同步自动更新';

            const collected = new TreeEntry('收藏的题单', vscode.TreeItemCollapsibleState.Collapsed, { kind: 'section', section: 'collected' });
            collected.iconPath = new vscode.ThemeIcon('star-half');
            collected.description = fav?.collected.length ? `${fav.collected.length} 个` : (hasCookie ? '未加载' : '需登录');
            collected.tooltip = '在 LeetCode 收藏的他人/企业/官方题单';

            const imports = new TreeEntry('导入题单', vscode.TreeItemCollapsibleState.Collapsed, { kind: 'section', section: 'imports' });
            imports.iconPath = new vscode.ThemeIcon('download');
            imports.description = lists.length ? `${lists.length} 个` : '空 · 点标题栏导入';

            const hot = new TreeEntry('热题 100', vscode.TreeItemCollapsibleState.Collapsed, { kind: 'section', section: 'hot100' });
            hot.iconPath = new vscode.ThemeIcon('flame');
            hot.description = `${topDone}/100`;

            const diff = new TreeEntry('难度分类', vscode.TreeItemCollapsibleState.Collapsed, { kind: 'section', section: 'difficulty' });
            diff.iconPath = new vscode.ThemeIcon('list-unordered');
            diff.description = metas.length ? `简 ${n('EASY')} · 中 ${n('MEDIUM')} · 困 ${n('HARD')}` : '题库未缓存';

            const all = new TreeEntry('全部题目', vscode.TreeItemCollapsibleState.Collapsed, { kind: 'section', section: 'all' });
            all.iconPath = new vscode.ThemeIcon('library');
            all.description = metas.length ? `${metas.length} 题` : '题库未缓存';
            return [mine, collected, imports, hot, diff, all];
        }

        const meta: EntryMeta = el.meta ?? { kind: 'placeholder' }; // 无 meta 的节点走不到任何分支
        // LeetCode 侧题单（我的/收藏的）公共渲染：folders → 题单节点（题目懒加载）
        const favSection = (folders: FavFolder[] | null): TreeEntry[] => {
            const hasCookie = !!vscode.workspace.getConfiguration('lmt').get<string>('leetcodeCookie');
            if (!hasCookie) {
                return [this.placeholder('未配置 Cookie——LeetCode 题单需登录，点此一键配置', 'lmt.refreshCookie')];
            }
            if (!folders) {
                this.hooks?.ensureFolders();
                return [this.placeholder('正在加载 LeetCode 题单…（没出现点此重试）', 'lmt.refreshTree')];
            }
            if (folders.length === 0) {
                return [this.placeholder('LeetCode 侧没有题单——Cookie 可能已过期，点此续期', 'lmt.refreshCookie')];
            }
            return folders.map(f => {
                const items = this.favItems(f.slug);
                const node = new TreeEntry(f.name, vscode.TreeItemCollapsibleState.Collapsed,
                    { kind: 'favList', favSlug: f.slug, listName: f.name });
                node.contextValue = 'favList';
                node.iconPath = new vscode.ThemeIcon(
                    f.favoriteType === 'SMART_LIST' ? 'sparkle' : f.isPublic ? 'globe' : 'cloud');
                if (items) {
                    const done = items.filter(q => { const r = recs.get(q.qid); return r && isSolved(r); }).length;
                    node.description = `${done}/${items.length}`;
                } else {
                    node.description = '展开加载';
                }
                return node;
            });
        };
        if (meta.kind === 'section' && meta.section === 'mine') {
            return favSection(this.favFolders()?.created ?? null);
        }
        if (meta.kind === 'section' && meta.section === 'collected') {
            return favSection(this.favFolders()?.collected ?? null);
        }
        if (meta.kind === 'section' && meta.section === 'imports') {
            const lists = loadLists(this.storageDir);
            if (lists.length === 0) {
                return [this.placeholder('没有题单——复制题单文本后点上方 ⬇ 导入', 'lmt.importList')];
            }
            const bySlug = new Map(this.allMetas().map(m => [m.slug, m] as const));
            return lists.map(L => {
                const node = new TreeEntry(L.name, vscode.TreeItemCollapsibleState.Collapsed, { kind: 'list', listId: L.id, listName: L.name });
                node.contextValue = 'list';
                node.iconPath = new vscode.ThemeIcon('bookmark');
                const done = L.items.filter(s => { const m = bySlug.get(s); const r = m && recs.get(m.qid); return r && isSolved(r); }).length;
                node.description = `${done}/${L.items.length}`;
                return node;
            });
        }
        if (meta.kind === 'section' && meta.section === 'hot100') {
            const items = this.data();
            const groups: string[] = [];
            for (const it of items) { if (!groups.includes(it.group)) { groups.push(it.group); } }
            return groups.map(g => {
                const sub = items.filter(i => i.group === g);
                const done = sub.filter(i => recs.get(i.qid) && isSolved(recs.get(i.qid)!)).length;
                const node = new TreeEntry(`${g}`, vscode.TreeItemCollapsibleState.Collapsed, { kind: 'group' });
                node.description = `${done}/${sub.length}`;
                return node;
            });
        }
        if (meta.kind === 'section' && meta.section === 'difficulty') {
            const metas = this.allMetas();
            if (metas.length === 0) { return [this.placeholder('题库未缓存——点击拉取全量题库', 'lmt.fetchAllQuestions')]; }
            return (['EASY', 'MEDIUM', 'HARD'] as const).map(d => {
                const node = new TreeEntry(DIFF_LABEL[d], vscode.TreeItemCollapsibleState.Collapsed, { kind: 'difficulty', difficulty: d });
                node.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(DIFF_COLOR[d]));
                node.description = `${metas.filter(m => diffKey(m.difficulty) === d).length} 题`;
                return node;
            });
        }
        if (meta.kind === 'section' && meta.section === 'all') {
            const metas = [...this.allMetas()].sort((a, b) => a.qid - b.qid);
            if (metas.length === 0) { return [this.placeholder('题库未缓存——点击拉取全量题库', 'lmt.fetchAllQuestions')]; }
            const search = this.placeholder(`🔍 搜索全部 ${metas.length} 题（编号/题名/slug）`, 'lmt.startProblem');
            const ranges = rangesOf(metas).map(([from, to]) => {
                const node = new TreeEntry(`${from} – ${to}`, vscode.TreeItemCollapsibleState.Collapsed, { kind: 'range', rangeFrom: from, rangeTo: to });
                node.iconPath = new vscode.ThemeIcon('symbol-numeric');
                node.description = `${metas.filter(m => m.qid >= from && m.qid <= to).length} 题`;
                return node;
            });
            return [search, ...ranges];
        }
        if (meta.kind === 'list') {
            const L = loadLists(this.storageDir).find(x => x.id === meta.listId);
            if (!L) { return []; }
            const bySlug = new Map(this.allMetas().map(m => [m.slug, m] as const));
            return L.items.map(slug => {
                const m = bySlug.get(slug);
                if (m) { return problemNode(m, { id: L.id, name: L.name }); }
                // 题库缓存里没有（新题/缓存过期）：照样能打开（startProblem 只需要 slug）
                const node = new TreeEntry(slug, vscode.TreeItemCollapsibleState.None,
                    { kind: 'problem', qid: 0, slug, listId: L.id, listName: L.name });
                node.contextValue = 'problemInList';
                node.description = '题库外';
                node.command = { command: 'lmt.startProblem', title: '打开题目文件', arguments: [{ meta: { kind: 'problem', slug } } as TreeEntry] };
                return node;
            });
        }
        if (meta.kind === 'favList') {
            const items = this.favItems(meta.favSlug ?? '');
            if (!items) {
                this.hooks?.ensureItems(meta.favSlug ?? '');
                return [this.placeholder('正在加载题目…（没出现点此重试）', 'lmt.refreshTree')];
            }
            if (items.length === 0) { return [new TreeEntry('（空题单）', vscode.TreeItemCollapsibleState.None, { kind: 'placeholder' })]; }
            return items.map(q => problemNode(
                { qid: q.qid, slug: q.slug, title: q.title || q.slug, difficulty: q.difficulty }, undefined, q.status));
        }
        if (meta.kind === 'group') {
            return this.data().filter(i => i.group === el.label).map(i => problemNode(i));
        }
        if (meta.kind === 'difficulty') {
            return [...this.allMetas()].filter(m => diffKey(m.difficulty) === meta.difficulty)
                .sort((a, b) => a.qid - b.qid).map(m => problemNode(m));
        }
        if (meta.kind === 'range') {
            return [...this.allMetas()].filter(m => m.qid >= (meta.rangeFrom ?? 0) && m.qid <= (meta.rangeTo ?? 0))
                .sort((a, b) => a.qid - b.qid).map(m => problemNode(m));
        }
        return [];
    }
}
