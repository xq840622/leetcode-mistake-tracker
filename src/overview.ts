import * as vscode from 'vscode';
import { Rec, isMistake, ERROR_TYPE_LABEL, mistakeCount } from './store';
import { parseCookieString, decodeSession } from './cookie';
import { problemsRoot } from './problems';
import { aiConfigured } from './ai';
import { notesDir } from './notes';

/** 侧边栏平级视图（与「题单」并列）：概览 / 记录与整理 / 设置，共用一套行渲染 */
export type OverviewView = 'overview' | 'records' | 'settings';

export class OverviewTree implements vscode.TreeDataProvider<vscode.TreeItem> {
    private _onDidChange = new vscode.EventEmitter<vscode.TreeItem | undefined>();
    readonly onDidChangeTreeData = this._onDidChange.event;

    constructor(private store: { load(): Rec[] }, private lastSync: () => number | undefined, private version = '', private cookieDead: () => boolean = () => false, private view: OverviewView = 'overview') { }

    refresh(): void { this._onDidChange.fire(undefined); }

    getTreeItem(el: vscode.TreeItem): vscode.TreeItem { return el; }

    getChildren(): vscode.TreeItem[] {
        const recs = this.store.load();
        switch (this.view) {
            case 'records': return this.recordRows(recs);
            case 'settings': return this.settingRows();
            default: return this.overviewRows(recs);
        }
    }

    /** 概览：错题率 + Cookie 登录态 + 最近错题 */
    private overviewRows(recs: Rec[]): vscode.TreeItem[] {
        const wrong = recs.filter(isMistake).length;
        const rate = recs.length ? `错题率 ${Math.round(wrong / recs.length * 100)}%（${wrong}/${recs.length}）· 点击打开仪表盘` : '错题率（暂无记录）· 刷一题或点「同步」导入历史';
        const rows: vscode.TreeItem[] = [
            this.row(this.version ? `错题本 v${this.version}` : 'LeetCode 错题本', 'graph', rate, 'lmt.openDashboard'),
            this.cookieRow()
        ];
        const mistakes = recs.filter(isMistake)
            .sort((a, b) => Math.max(...b.attempts.map(x => x.ts)) - Math.max(...a.attempts.map(x => x.ts)))
            .slice(0, 5);
        if (mistakes.length) {
            const head = new vscode.TreeItem('最近错题');
            head.description = `${wrong} 题待复盘`;
            head.collapsibleState = vscode.TreeItemCollapsibleState.None;
            rows.push(head);
            for (const m of mistakes) {
                const et = m.errorTypes.length ? ERROR_TYPE_LABEL[m.errorTypes[m.errorTypes.length - 1]] ?? '其他' : '未归因';
                const item = this.row(`${m.qid}. ${m.title || m.slug || ''}`, 'error', `${et} · 错 ${mistakeCount(m)} 次`, 'lmt.openProblem');
                item.command = { command: 'lmt.openProblem', title: '打开题目', arguments: [{ meta: { kind: 'problem', qid: m.qid, slug: m.slug } }] };
                rows.push(item);
            }
        }
        return rows;
    }

    /** Cookie 登录态一行：剩余天数 / 过期 / 服务端作废 / 未配置 */
    private cookieRow(): vscode.TreeItem {
        const ck = vscode.workspace.getConfiguration('lmt').get<string>('leetcodeCookie') || '';
        const parsed = parseCookieString(ck);
        if (!parsed) { return this.row('Cookie 未配置', 'warning', '点此一键配置（粘贴浏览器 Cookie）', 'lmt.refreshCookie'); }
        if (this.cookieDead()) { return this.row('Cookie 已失效（服务端作废）', 'error', '同步/提交都会失败——点此重新粘贴一份', 'lmt.refreshCookie'); }
        const info = decodeSession(parsed.sessionId);
        if (!info.expiresAt) { return this.row('Cookie 已配置', 'key', '点此一键续期', 'lmt.refreshCookie'); }
        const days = Math.floor((info.expiresAt * 1000 - Date.now()) / 86400_000);
        const until = new Date(info.expiresAt * 1000).toLocaleDateString('zh-CN');
        if (days <= 0) { return this.row('Cookie 已过期', 'warning', `已于 ${until} 过期，点此续期（约每月一次）`, 'lmt.refreshCookie'); }
        return this.row(`Cookie 剩 ${days} 天`, days <= 5 ? 'warning' : 'key', `有效期至 ${until}，点此一键续期`, 'lmt.refreshCookie');
    }

    /** 记录与整理：同步 / AI 归因 / 导出错题 md */
    private recordRows(recs: Rec[]): vscode.TreeItem[] {
        const rows: vscode.TreeItem[] = [];

        // 同步 / 自动记录状态
        const ls = this.lastSync();
        const m = vscode.workspace.getConfiguration('lmt').get<number>('autoSyncMinutes') ?? 0;
        if (m > 0) {
            rows.push(this.row(`自动记录 · 每 ${m} 分钟`, 'sync', ls ? relTime(ls) : '等待首次同步（点此手动全量同步）', 'lmt.sync'));
        } else {
            rows.push(this.row('自动记录 · 未开启', 'warning', '点此手动同步；设置 lmt.autoSyncMinutes 可开启定时', 'lmt.sync'));
        }

        // AI 归因进度
        const wrongs = recs.filter(isMistake);
        const attributed = wrongs.filter(r => r.ai).length;
        if (wrongs.length > 0) {
            const pending = wrongs.length - attributed;
            rows.push(this.row(`AI 归因 ${attributed}/${wrongs.length} 题`, 'sparkle',
                pending > 0 ? `剩 ${pending} 题待归因，点此批量分析（同步后也会自动归因）` : '全部错题已归因 ✓', 'lmt.analyzeAll'));
        }

        // 导出错题 markdown
        rows.push(this.row('导出错题 md', 'output', recs.length ? `${recs.length} 条记录待导出` : '还没有记录', 'lmt.exportNotes'));
        return rows;
    }

    /** 设置：AI / 题目目录 / 错题目录 */
    private settingRows(): vscode.TreeItem[] {
        const aiDone = aiConfigured();
        return [
            this.row(aiDone ? 'AI 归因 · 已配置' : 'AI 归因 · 未配置', aiDone ? 'sparkle' : 'warning',
                aiDone ? '点此修改端点 / Key / 模型' : '点此三步配置（端点+Key+模型），之后失败提交自动整理错因', 'lmt.configAi'),
            this.row('AI 提示词', 'note', (() => {
                const custom = (vscode.workspace.getConfiguration('lmt').get<string>('aiPrompt') ?? '').trim();
                return custom ? `自定义（${custom.length} 字） · 点此查看/恢复` : '内置默认 · 点此自定义（可先复制默认再改）';
            })(), 'lmt.configAiPrompt'),
            this.row('题目目录', 'folder', `${problemsRoot()}/leetcode/editor/cn · 点此更换（已有文件不搬家）`, 'lmt.configProblemsDir'),
            this.row('错题目录', 'notebook', (() => {
                const dir = notesDir();
                return dir ? `${dir} · 点此更换` : '未指定 · 点此选择 md 笔记目录';
            })(), 'lmt.configNotesDir')
        ];
    }

    private row(label: string, icon: string, desc: string, command?: string): vscode.TreeItem {
        const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon(icon);
        item.description = desc;
        if (command) { item.command = { command, title: label }; }
        return item;
    }
}

function relTime(ts: number): string {
    const s = Math.floor((Date.now() - ts) / 1000);
    if (s < 60) { return `上次同步: ${s} 秒前`; }
    if (s < 3600) { return `上次同步: ${Math.floor(s / 60)} 分钟前`; }
    if (s < 86400) { return `上次同步: ${Math.floor(s / 3600)} 小时前`; }
    return `上次同步: ${Math.floor(s / 86400)} 天前`;
}
