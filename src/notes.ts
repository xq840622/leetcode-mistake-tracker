import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Rec, Attempt, isMistake, isSolved, mistakeCount, ERROR_TYPE_LABEL, STATUS_LABEL, diffKey } from './store';

const GEN_BEGIN = '<!--lmt:generated-->';
const GEN_END = '<!--/lmt:generated-->';

export interface NotesCfg { dir: string; }

/** 错题 md 目录：新键 lmt.notesDirPath；未配置时兼容旧 Obsidian 配置（vault + 子目录拼成一个普通目录） */
export function notesDir(): string {
    const cfg = vscode.workspace.getConfiguration('lmt');
    const cur = cfg.get<string>('notesDirPath') ?? '';
    if (cur) { return cur; }
    const legacyVault = cfg.get<string>('obsidianVaultPath') ?? '';
    if (!legacyVault) { return ''; }
    const legacySub = cfg.get<string>('obsidianSubdir') ?? 'LeetCode 错题本';
    return legacySub ? path.join(legacyVault, legacySub) : legacyVault;
}

/** 自动导出用的静默目录：配置存在且目录可用才返回，否则不打断用户 */
export function silentNotesDir(): string | undefined {
    const dir = notesDir();
    return dir && fs.existsSync(dir) ? dir : undefined;
}

/** 导出目录：配置有就直接用；没有则弹「选择文件夹」并记住 */
export async function resolveNotesDir(): Promise<string | undefined> {
    const cur = notesDir();
    if (cur && fs.existsSync(cur)) { return cur; }
    const dir = await vscode.window.showOpenDialog({
        canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
        title: '选择错题 md 笔记的存放目录（会记住，之后自动导出到这里）'
    });
    if (!dir || dir.length === 0) { return undefined; }
    await vscode.workspace.getConfiguration('lmt').update('notesDirPath', dir[0].fsPath, vscode.ConfigurationTarget.Global);
    return dir[0].fsPath;
}

function fmtTs(ts: number): string {
    const d = new Date(ts);
    const p = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function diffLabel(diff: string): string {
    const k = diffKey(diff);
    return k === 'EASY' ? '简单' : k === 'MEDIUM' ? '中等' : k === 'HARD' ? '困难' : diff;
}

export function renderNote(rec: Rec, prevContent?: string): string {
    const solved = isSolved(rec);
    const status = solved ? 'AC' : '未通过';
    const sorted = [...rec.attempts].sort((a, b) => a.ts - b.ts);

    const fm = [
        '---',
        `qid: ${rec.qid}`,
        `slug: ${rec.slug}`,
        `title: ${rec.title}`,
        `difficulty: ${rec.difficulty}`,
        `status: ${status}`,
        `attempts: ${rec.attempts.length}`,
        `mistakes: ${mistakeCount(rec)}`,
        `errorTypes: [${rec.errorTypes.map(e => JSON.stringify(e)).join(', ')}]`,
        `updated: ${new Date().toISOString().slice(0, 10)}`,
        'tags: [leetcode]',
        '---'
    ].join('\n');

    const head = [
        `# ${rec.qid}. ${rec.title}`,
        '',
        `- 链接: https://leetcode.cn/problems/${rec.slug}/`,
        `- 难度: ${diffLabel(rec.difficulty)}`,
        `- 提交次数: ${rec.attempts.length}（失败 ${mistakeCount(rec)} 次） · ${isMistake(rec) ? '⚠️ 错题' : '一次通过'}`,
        rec.errorTypes.length ? `- 错误类型: ${rec.errorTypes.map(e => ERROR_TYPE_LABEL[e] ?? e).join('、')}` : '',
        ''
    ].filter(x => x !== '').join('\n');

    const aiBlock = rec.ai
        ? [
            `## AI 归因（${fmtTs(rec.ai.ts)}）`,
            '',
            `- **类型**: ${ERROR_TYPE_LABEL[rec.ai.type] ?? rec.ai.type}`,
            `- **摘要**: ${rec.ai.summary}`
        ]
        : [];

    const timeline = [
        '## 提交时间线',
        '',
        '| 时间 | 结果 | 语言 | 耗时 |',
        '|---|---|---|---|',
        ...sorted.map((a: Attempt) =>
            `| ${fmtTs(a.ts)} | ${a.status === 'AC' ? '✅ AC' : `❌ ${STATUS_LABEL[a.status] ?? a.status}`} | ${a.lang ?? ''} | ${a.runtime ?? ''} |`)
    ];

    const generated = ['', ...aiBlock, '', ...timeline, ''].join('\n');

    const codeBlock = rec.codeSnapshot
        ? ['## 最新代码', '', '```python', rec.codeSnapshot, '```'].join('\n')
        : '';

    // 复盘区：upsert 时保留用户已写的复盘
    let review = ['## 复盘（自己写）', '', '- '].join('\n');
    if (prevContent) {
        const idx = prevContent.indexOf('## 复盘');
        if (idx >= 0) { review = prevContent.slice(idx); }
    }

    return `${fm}\n\n${head}\n${GEN_BEGIN}\n${generated}\n${GEN_END}\n\n${codeBlock}\n\n${review}\n`;
}

export function noteFilePath(cfg: NotesCfg, rec: Rec): string {
    const safeTitle = (rec.title || rec.slug).replace(/[\\/:*?"<>|#^[\]]/g, '').trim();
    return path.join(cfg.dir, `${rec.qid}.${safeTitle}.md`);
}

export async function exportRecord(cfg: NotesCfg, rec: Rec): Promise<string> {
    const file = noteFilePath(cfg, rec);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : undefined;
    fs.writeFileSync(file, renderNote(rec, prev), 'utf8');
    return file;
}
