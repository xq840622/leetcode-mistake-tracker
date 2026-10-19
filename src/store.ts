import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

export interface Attempt {
    ts: number;
    status: string; // AC | WA | TLE | MLE | RE | CE
    lang?: string;
    runtime?: string;
    note?: string;
    id?: string; // leetcode.cn 提交 id（用于去重与拉取提交代码）
    failInfo?: string; // 判定详情（RE 完整栈 / WA 出错用例三件套），实时提交时带回，供 AI 归因与复盘
}

const STATUS_CODES = ['AC', 'WA', 'TLE', 'MLE', 'RE', 'CE'];

/** 把 leetcode.cn 的 statusDisplay 归一成短码 */
export function normStatus(display: string): string {
    const s = (display || '').trim().toLowerCase();
    if (s.startsWith('accepted')) { return 'AC'; }
    if (s.includes('wrong answer')) { return 'WA'; }
    if (s.includes('time limit')) { return 'TLE'; }
    if (s.includes('memory')) { return 'MLE'; }
    if (s.includes('runtime error')) { return 'RE'; }
    if (s.includes('compile') || s.includes('syntax')) { return 'CE'; }
    return display;
}

export interface AiAnalysis {
    type: string; // syntax | boundary | complexity | logic | other
    summary: string;
    ts: number;
}

export interface Rec {
    qid: number;
    slug: string;
    title: string;
    difficulty: string;
    attempts: Attempt[];
    errorTypes: string[];
    ai?: AiAnalysis;
    codeSnapshot?: string;
}

export const STATUS_LABEL: Record<string, string> = {
    AC: '通过', WA: '答案错误', TLE: '超时', MLE: '超内存', RE: '运行错误', CE: '编译错误'
};

/** 难度归一：leetcode.cn 的 GraphQL 返回 "Easy"/"Medium"/"Hard"（词首大写），统一成大写短码再比较 */
export function diffKey(diff: string): 'EASY' | 'MEDIUM' | 'HARD' | '' {
    const s = (diff || '').trim().toUpperCase();
    return s === 'EASY' || s === 'MEDIUM' || s === 'HARD' ? s : '';
}

export const ERROR_TYPE_LABEL: Record<string, string> = {
    syntax: '语法错误', boundary: '边界条件', complexity: '复杂度超标', logic: '思路错误', other: '其他'
};

export function statusIcon(status: string): string {
    return status === 'AC' ? '✅' : '❌';
}

export function isSolved(rec: Rec): boolean {
    return rec.attempts.some(a => a.status === 'AC');
}

/** 一题是否算"错题"：从未 AC，或第一次尝试不是 AC */
export function isMistake(rec: Rec): boolean {
    if (rec.attempts.length === 0) { return false; }
    const sorted = [...rec.attempts].sort((a, b) => a.ts - b.ts);
    return sorted[0].status !== 'AC';
}

export function mistakeCount(rec: Rec): number {
    return rec.attempts.filter(a => a.status !== 'AC').length;
}

export class Store {
    private file: string;

    constructor(ctx: vscode.ExtensionContext) {
        this.file = path.join(ctx.globalStorageUri.fsPath, 'records.json');
    }

    load(): Rec[] {
        try {
            if (fs.existsSync(this.file)) {
                const recs = JSON.parse(fs.readFileSync(this.file, 'utf8')) as Rec[];
                // 迁移：0.3.0 之前同步存的是原始 statusDisplay（如 "Accepted"），归一成短码
                let dirty = false;
                for (const r of recs) {
                    for (const a of r.attempts) {
                        if (!STATUS_CODES.includes(a.status)) {
                            const n = normStatus(a.status);
                            if (n !== a.status) { a.status = n; dirty = true; }
                        }
                    }
                }
                if (dirty) { this.save(recs); }
                return recs;
            }
        } catch (e) {
            console.error('records.json parse failed', e);
        }
        return [];
    }

    save(recs: Rec[]): void {
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        fs.writeFileSync(this.file, JSON.stringify(recs, null, 1), 'utf8');
    }

    byQid(qid: number): Rec | undefined {
        return this.load().find(r => r.qid === qid);
    }

    /** 按 qid 合并；attempts 优先按提交 id 去重（无 id 时按 ts+status），并给旧记录补挂 id */
    upsert(rec: Rec): Rec {
        const recs = this.load();
        const i = recs.findIndex(r => r.qid === rec.qid);
        const keyOf = (a: Attempt) => a.id ? `i${a.id}` : `t${a.ts}|${a.status}`;
        let merged: Rec;
        if (i >= 0) {
            const old = recs[i];
            const newAttempts = [...old.attempts];
            const index = new Map(newAttempts.map((a, k) => [keyOf(a), k] as const));
            for (const a of rec.attempts) {
                const k = keyOf(a);
                const hit = index.get(k);
                if (hit !== undefined) {
                    newAttempts[hit] = { ...newAttempts[hit], ...a }; // 补挂 id / runtime 等新信息
                    continue;
                }
                // 新数据带 id、旧数据无 id 但 ts+status 相同 → 视为同一次提交
                if (a.id) {
                    const twin = newAttempts.findIndex(x => !x.id && x.ts === a.ts && x.status === a.status);
                    if (twin >= 0) { newAttempts[twin] = { ...newAttempts[twin], ...a }; index.set(k, twin); continue; }
                }
                index.set(k, newAttempts.length);
                newAttempts.push(a);
            }
            merged = {
                ...old,
                title: rec.title || old.title,
                difficulty: rec.difficulty || old.difficulty,
                slug: rec.slug || old.slug,
                attempts: newAttempts.sort((a, b) => a.ts - b.ts),
                errorTypes: [...new Set([...old.errorTypes, ...rec.errorTypes])],
                ai: rec.ai ?? old.ai,
                codeSnapshot: rec.codeSnapshot ?? old.codeSnapshot
            };
            recs[i] = merged;
        } else {
            const uniq: Attempt[] = [];
            const seen = new Set<string>();
            for (const a of [...rec.attempts].sort((x, y) => x.ts - y.ts)) {
                if (!seen.has(keyOf(a))) { seen.add(keyOf(a)); uniq.push(a); }
            }
            merged = { ...rec, attempts: uniq };
            recs.push(merged);
        }
        this.save(recs);
        return merged;
    }

    remove(qid: number): void {
        const recs = this.load().filter(r => r.qid !== qid);
        this.save(recs);
    }
}

export interface Stats {
    attempted: number;
    solved: number;
    firstTry: number;
    mistakes: number;
    mistakeRate: number;
    firstTryRate: number;
    avgAttempts: number;
    errorTypeDist: Array<{ type: string; label: string; count: number }>;
    recent: Rec[];
}
