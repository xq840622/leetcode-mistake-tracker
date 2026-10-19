// 我的题单：存储 + 导入解析。
// 刻意用 globalStorage 下的 JSON 文件而非 globalState，方便用户备份/手工编辑，也便于自测。
import * as fs from 'fs';
import * as path from 'path';

export interface ProblemList {
    id: string;
    name: string;
    items: string[]; // slug 列表（保持导入顺序，去重）
    createdAt: number;
}

export interface QMetaLite { qid: number; slug: string; title: string; difficulty: string; }

const fileOf = (dir: string) => path.join(dir, 'problemLists.json');

export function loadLists(dir: string): ProblemList[] {
    try {
        if (fs.existsSync(fileOf(dir))) {
            const arr = JSON.parse(fs.readFileSync(fileOf(dir), 'utf8')) as ProblemList[];
            return Array.isArray(arr) ? arr.filter(l => l && l.id && Array.isArray(l.items)) : [];
        }
    } catch { /* 文件损坏视为空，下次保存自动修复 */ }
    return [];
}

export function saveLists(dir: string, lists: ProblemList[]): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(fileOf(dir), JSON.stringify(lists, null, 1), 'utf8');
}

export function newList(name: string): ProblemList {
    return { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name, items: [], createdAt: Date.now() };
}

/** 归一化比较键：去大小写、去所有标点空白（中英文题名 / slug 的 "two-sum" vs "Two Sum" 都能对上） */
const normKey = (s: string) => s.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]/g, '');

interface MetaIndex {
    bySlug: Map<string, string>;   // slug(lower) → slug
    byQid: Map<number, string>;    // qid → slug
    byNorm: Map<string, string>;   // normKey(title) / normKey(slug) → slug
}

function buildIndex(metas: QMetaLite[]): MetaIndex {
    const idx: MetaIndex = { bySlug: new Map(), byQid: new Map(), byNorm: new Map() };
    for (const m of metas) {
        idx.bySlug.set(m.slug.toLowerCase(), m.slug);
        if (!idx.byQid.has(m.qid)) { idx.byQid.set(m.qid, m.slug); }
        for (const k of [normKey(m.title), normKey(m.slug)]) {
            if (k && !idx.byNorm.has(k)) { idx.byNorm.set(k, m.slug); }
        }
    }
    return idx;
}

function resolveOne(line: string, idx: MetaIndex): string | undefined {
    // URL：https://leetcode.cn/problems/two-sum/ → two-sum
    const u = line.match(/leetcode\.cn\/problems\/([a-z0-9-]+)/i);
    if (u) { return idx.bySlug.get(u[1].toLowerCase()); }
    // 裸题号
    if (/^\d+$/.test(line)) { return idx.byQid.get(Number(line)); }
    // 裸 slug
    if (/^[a-z0-9]+(?:-[a-z0-9]+)+$/i.test(line)) { return idx.bySlug.get(line.toLowerCase()); }
    // 题名（中文原名，或英文题名≈slug 去连字符）
    return idx.byNorm.get(normKey(line));
}

/**
 * 解析用户导入的题单文本。逐行识别（也支持整体是 JSON 数组）：
 *   "1. 两数之和" / "1、两数之和"  题号+题名（题名优先，题名对不上再信题号）
 *   "15"                           裸题号
 *   "two-sum"                      slug
 *   "Two Sum"                      英文题名
 *   "https://leetcode.cn/problems/two-sum/"  URL
 *   markdown 列表前缀 / 表格竖线 / # 标题 / 分隔线 自动忽略或剥掉
 *   一行连排多题也能拆开："两数之和、三数之和" / "1. 两数之和 2. 接雨水" / "146 206 25"
 *   （从聊天窗口 / PDF 复制时常丢换行变成一整行，按顿号 / 连写序号 / 空格切开逐段识别）
 */
export function parseListInput(text: string, metas: QMetaLite[]): { slugs: string[]; unresolved: string[] } {
    const idx = buildIndex(metas);
    const slugs: string[] = [];
    const unresolved: string[] = [];
    const push = (slug: string | undefined, raw: string) => {
        if (slug && !slugs.includes(slug)) { slugs.push(slug); } else if (!slug) { unresolved.push(raw); }
    };

    // 整体是 JSON 数组：元素可为 数字 / 字符串 / {qid|slug|title}
    const trimmed = text.trim();
    if (trimmed.startsWith('[')) {
        try {
            const arr = JSON.parse(trimmed);
            if (Array.isArray(arr)) {
                for (const el of arr) {
                    if (typeof el === 'number') { push(idx.byQid.get(el), String(el)); continue; }
                    if (typeof el === 'string') { push(resolveOne(el.trim(), idx), el); continue; }
                    if (el && typeof el === 'object') {
                        const o = el as Record<string, unknown>;
                        const qid = Number(o.qid ?? o.questionId ?? o.frontendQuestionId ?? 0);
                        const slug = typeof o.slug === 'string' ? o.slug
                            : typeof o.titleSlug === 'string' ? o.titleSlug
                            : qid ? idx.byQid.get(qid)
                            : typeof (o.title ?? o.translatedTitle) === 'string' ? idx.byNorm.get(normKey(String(o.title ?? o.translatedTitle)))
                            : undefined;
                        push(slug ? idx.bySlug.get(slug.toLowerCase()) ?? slug : undefined, JSON.stringify(o));
                    }
                }
                return { slugs, unresolved };
            }
        } catch { /* 不是 JSON 就走逐行 */ }
    }

    // 单段识别（题号+题名 / 裸题号 / slug / 题名 / URL），能对上返回 true
    const resolveLine = (line: string): boolean => {
        // "12. 标题" / "12、标题" / "12) 标题" / "12 标题"：题名能对上就信题名（作者的序号可能是列表编号不是题号），否则信题号
        const m = line.match(/^(\d+)\s*[.、)]?\s*(.*)$/);
        if (m) {
            const rest = m[2].trim();
            const byTitle = rest ? idx.byNorm.get(normKey(rest)) : undefined;
            if (byTitle) { push(byTitle, line); return true; }
            const byId = idx.byQid.get(Number(m[1]));
            if (byId) { push(byId, line); return true; }
            if (!rest) { return false; } // "12." 纯编号且对不上题号
            // 题号对不上：继续按整行解析（可能整行其实是别的格式）
        }
        const slug = resolveOne(line, idx);
        if (slug) { push(slug, line); return true; }
        return false;
    };

    // 纯装饰段：难度词（markdown 表格的难度列）与残破符号，切开时直接丢弃不计未识别
    const DECOR = /^(简单|中等|困难|easy|medium|hard)$/i;
    for (const raw of text.split(/\r?\n/)) {
        // 剥掉 markdown 列表前缀 / 表格竖线；跳过标题行与分隔线
        const line = raw.trim().replace(/\|/g, ' ').replace(/^[-*+]\s+/, '').trim();
        if (!line || /^#{1,6}\s/.test(line) || /^[-=_*]{3,}$/.test(line)) { continue; }
        // 一行连排多题 → 切段：顿号/分号；连写的「N.」序号 ≥2 个；无英文字母的行按空白（保护 "Two Sum" 不被拆坏）
        let parts: string[] = [];
        if (/[、；;]/.test(line)) { parts = line.split(/[、；;]+/); }
        else if ((line.match(/\d+\s*[.、)]\s*\S/g) ?? []).length >= 2) { parts = line.split(/(?=\d+\s*[.、)])/); }
        else if (!/[a-z]/i.test(line) && /\s/.test(line)) { parts = line.split(/\s+/); }
        parts = parts.map(p => p.replace(/^[-–—·，,。]+/, '').replace(/[-–—·，,。]+$/, '').trim())
            .filter(p => p && !DECOR.test(p) && !/^[-–—*·.。]+$/.test(p));
        if (parts.length <= 1) {
            if (!resolveLine(line)) { unresolved.push(raw.trim()); }
            continue;
        }
        let hit = false;
        const misses: string[] = [];
        for (const p of parts) { if (resolveLine(p)) { hit = true; } else { misses.push(p); } }
        // 全段都对不上：整行原样报未识别（「N 行未匹配」保持按行计数的直觉）；部分对上才按段报
        if (hit) { unresolved.push(...misses); } else { unresolved.push(raw.trim()); }
    }
    return { slugs, unresolved };
}
