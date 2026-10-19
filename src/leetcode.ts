import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { Attempt, Store, normStatus } from './store';

const GQL = 'https://leetcode.cn/graphql/';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) leetcode-mistake-tracker/0.1';

interface QMeta { qid: number; slug: string; title: string; difficulty: string; }

async function gql(query: string, variables: Record<string, unknown>, cookie?: string): Promise<any> {
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        'Referer': 'https://leetcode.cn',
        'User-Agent': UA
    };
    if (cookie) { headers['Cookie'] = cookie; }
    const res = await fetch(GQL, {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables })
    });
    if (!res.ok) { throw new Error(`graphql HTTP ${res.status}`); }
    const body = await res.json() as { data?: any; errors?: Array<{ message: string }> };
    if (body.errors && !body.data) {
        throw new Error('graphql: ' + body.errors.map(e => e.message).join('; '));
    }
    return body.data;
}

let channel: vscode.OutputChannel | undefined;
export function log(ctx: vscode.ExtensionContext): vscode.OutputChannel {
    if (!channel) {
        channel = vscode.window.createOutputChannel('LeetCode 错题本');
        ctx.subscriptions.push(channel);
    }
    return channel;
}

/** 全量题库元数据（无 cookie 可用），缓存 7 天 */
export async function allQuestions(ctx: vscode.ExtensionContext, force = false): Promise<Map<number, QMeta>> {
    const cacheFile = path.join(ctx.globalStorageUri.fsPath, 'allQuestions.json');
    if (!force && fs.existsSync(cacheFile)) {
        const st = fs.statSync(cacheFile);
        if (Date.now() - st.mtimeMs < 7 * 86400_000) {
            const arr = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as Array<[number, string, string, string]>;
            return new Map(arr.map(a => [a[0], { qid: a[0], slug: a[1], title: a[2], difficulty: a[3] }]));
        }
    }
    const data = await gql(`{ allQuestions { questionFrontendId titleSlug translatedTitle difficulty } }`, {});
    const map = new Map<number, QMeta>();
    for (const q of data.allQuestions) {
        const qid = Number(q.questionFrontendId);
        if (!Number.isFinite(qid) || !q.titleSlug) { continue; } // LCCI 面试题等无前端题号的条目
        map.set(qid, {
            qid, slug: q.titleSlug,
            title: q.translatedTitle || q.titleSlug, difficulty: q.difficulty
        });
    }
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify([...map].map(([qid, m]) => [qid, m.slug, m.title, m.difficulty])), 'utf8');
    return map;
}

/** 某题「自己的」提交列表（含失败提交与提交 id）；无 cookie / 未做过时返回空 */
export async function fetchSubmissions(slug: string, cookie: string, limit = 20): Promise<Attempt[]> {
    const data = await gql(
        `query sub($slug: String!, $limit: Int!) {
            submissionList(offset: 0, limit: $limit, questionSlug: $slug) {
                submissions { id statusDisplay lang runtime timestamp }
            }
        }`, { slug, limit }, cookie);
    const subs = data?.submissionList?.submissions ?? [];
    return subs.map((s: any) => ({
        id: s.id != null ? String(s.id) : undefined,
        ts: Number(s.timestamp) * 1000,
        status: normStatus(s.statusDisplay),
        lang: s.lang,
        runtime: s.runtime ?? undefined
    }));
}

export interface SubmissionDetail { code?: string; status?: string; lang?: string; runtime?: string; memory?: string; }

/** 单次提交详情（最重要的字段：提交的代码原文）。注意：leetcode.cn 的 SubmissionDetail 没有
 *  runtimeError/fullCompileError 等字段（那是美站 schema），查了会整条 400——错误详情一律走 fetchVerdict。 */
export async function fetchSubmissionDetail(id: string, cookie: string): Promise<SubmissionDetail> {
    const data = await gql(
        `query sd($id: ID!) {
            submissionDetail(submissionId: $id) { code statusDisplay lang runtime memory }
        }`, { id }, cookie);
    const d = data?.submissionDetail;
    return d ? {
        code: d.code, status: normStatus(d.statusDisplay), lang: d.lang,
        runtime: d.runtime, memory: d.memory
    } : {};
}

/** 判定详情（REST check 接口，字段是 snake_case）：对已完结的历史提交同样有效，RE 栈 / WA 用例三件套都在这里 */
export async function fetchVerdict(id: string, cookie: string): Promise<{ brief?: string; failInfo?: string }> {
    const res = await fetch(`https://leetcode.cn/submissions/detail/${id}/check/`, {
        headers: { 'Cookie': cookie, 'Referer': 'https://leetcode.cn', 'User-Agent': 'Mozilla/5.0 lmt' }
    });
    const c: any = await res.json().catch(() => ({}));
    return c && (c.state === 'SUCCESS' || c.status_code != null) ? verdictDetail(c) : {};
}

/* ==================== 原生打开题目 / 提交（不依赖 labuladong） ==================== */

export interface QuestionDetail {
    questionId: string;        // 内部 ID（提交用，与 frontendId 不同）
    frontendId: string;
    title: string;             // 中文题名
    difficulty: string;
    descHtml: string;          // 题目描述（HTML）
    python3: string;           // python3 代码模板
    exampleTestcases: string;  // 官方示例用例：每个参数一行，case 间靠参数个数分组
    sampleTestCase: string;
}

/** 题目详情：题面、代码模板、示例用例（免费题无需 cookie；会员题需带 VIP cookie 才有题面/模板） */
export async function fetchQuestionDetail(slug: string, cookie?: string): Promise<QuestionDetail> {
    const data = await gql(
        `query qd($slug: String!) { question(titleSlug: $slug) {
            questionId questionFrontendId title translatedTitle difficulty
            content translatedContent exampleTestcases sampleTestCase isPaidOnly
            codeSnippets { lang langSlug code }
        } }`, { slug }, cookie);
    const q = data?.question;
    if (!q) { throw new Error(`leetcode.cn 上找不到题目: ${slug}`); }
    if (q.isPaidOnly && !(q.translatedContent || q.content) && !cookie) {
        throw new Error('这是会员题，拉取题面需要 Cookie（VIP 账号请先「一键续期 Cookie」）');
    }
    const py3 = (q.codeSnippets ?? []).find((s: any) => s.langSlug === 'python3');
    return {
        questionId: String(q.questionId ?? ''),
        frontendId: String(q.questionFrontendId ?? ''),
        title: q.translatedTitle || q.title || slug,
        difficulty: q.difficulty ?? '',
        descHtml: q.translatedContent || q.content || '',
        python3: py3?.code ?? '',
        exampleTestcases: q.exampleTestcases ?? '',
        sampleTestCase: q.sampleTestCase ?? ''
    };
}

/** 把题目提交到 leetcode.cn（REST 端点，请求构造与 labuladong 插件同款）。返回 submissionId。 */
export async function submitCode(
    slug: string, questionId: string, code: string, lang: string, cookie: string
): Promise<number> {
    const csrf = /(?:^|;|\s)csrftoken=([^;]+)/.exec(cookie)?.[1] ?? '';
    if (!csrf) { throw new Error('COOKIE_EXPIRED'); }
    const res = await fetch(`https://leetcode.cn/problems/${slug}/submit/`, {
        method: 'POST',
        headers: {
            'Cookie': cookie,
            'X-CSRFToken': csrf,
            'X-Requested-With': 'XMLHttpRequest',
            'x-csrftoken': csrf,
            'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:123.0) Gecko/20100101 Firefox/123.0',
            'Referer': `https://leetcode.cn/problems/${slug}/`,
            'Origin': 'https://leetcode.cn/',
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({ lang, question_id: Number(questionId), test_mode: false, judge_type: 'large', typed_code: code })
    });
    if (res.status === 403) { throw new Error('COOKIE_EXPIRED'); } // User is not authenticated
    if (res.status === 429) { throw new Error('提交太频繁，等几秒再试'); }
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || !body.submission_id) {
        throw new Error(body.error ? String(body.error) : `提交失败 HTTP ${res.status}`);
    }
    return body.submission_id;
}

export interface SubmitOutcome {
    statusCode: number; runtime?: string; memory?: string;
    brief?: string;    // 通知用的一行摘要（RE 栈末行 / WA 用例对比 / 状态文案）
    failInfo?: string; // 完整失败详情：RE 栈 / CE 全文 / WA 出错用例三件套，入错题本供 AI 归因与复盘
}

/**
 * 从判定响应（check 接口）或 submissionDetail 里提取失败详情。纯函数便于自测。
 * 优先级：RE/CE 错误全文 > WA 出错用例三件套 > 仅有状态文案。
 */
export function verdictDetail(c: Record<string, any>): { brief?: string; failInfo?: string } {
    const msg = String(c.status_msg ?? c.statusDisplay ?? '').trim();
    const full = String(c.full_runtime_error || c.runtime_error || c.full_compile_error || c.compile_error || '').trim();
    if (full) {
        const lastLine = full.split(/\r?\n/).map(s => s.trim()).filter(Boolean).pop() ?? '';
        return { brief: lastLine.slice(0, 120), failInfo: `${msg || '错误'}\n${full}` };
    }
    const lt = c.last_testcase ?? {};
    const inp = String(c.input ?? lt.input ?? '').trim();
    if (inp) {
        const arr = (v: any) => Array.isArray(v) ? v.join('\n') : (v == null ? '' : String(v));
        const out = arr(c.code_answer) || arr(c.code_output) || arr(lt.output);
        const exp = arr(c.expected_code_answer) || arr(c.expected_output) || arr(lt.expected_output);
        const nth = c.total_correct != null ? `第 ${Number(c.total_correct) + 1} 个用例` : '某用例';
        const one = (s: string) => s.replace(/\s*\n\s*/g, ' ⏎ ').slice(0, 60);
        return {
            brief: `${nth}：输入 ${one(inp)} → 得到 ${one(out || '（空）')}（期望 ${one(exp || '（空）')}）`.slice(0, 160),
            failInfo: `${msg || '答案错误'}（${nth}）\n输入:\n${inp}\n期望输出:\n${exp || '（空）'}\n实际输出:\n${out || '（空）'}`
        };
    }
    return msg ? { brief: msg, failInfo: msg } : {};
}

/** 轮询提交判定结果直到终态（state=SUCCESS）。失败时带回详细错误。 */
export async function waitSubmission(
    submissionId: number, cookie: string, onPoll?: (round: number) => void
): Promise<SubmitOutcome> {
    for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 1200));
        onPoll?.(i);
        try {
            const res = await fetch(`https://leetcode.cn/submissions/detail/${submissionId}/check/`, {
                headers: { 'Cookie': cookie, 'Referer': 'https://leetcode.cn', 'User-Agent': 'Mozilla/5.0 lmt' }
            });
            const c: any = await res.json().catch(() => ({}));
            if (c.state === 'SUCCESS') {
                return {
                    statusCode: Number(c.status_code ?? 0),
                    runtime: c.status_runtime, memory: c.status_memory,
                    ...verdictDetail(c)
                };
            }
            if (c.state === 'FAILURE') { throw new Error(c.error_msg || '提交被判定失败'); }
        } catch (e: any) {
            if (String(e.message).includes('判定失败')) { throw e; }
            // 网络抖动：继续下一轮
        }
    }
    throw new Error('等待判定结果超时（可在网页查看提交记录）');
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 按 slug 列表增量同步：不再要求本地已有种子记录，新题自动入库（串行 + 限流） */
export async function syncSlugs(
    ctx: vscode.ExtensionContext, store: Store, slugs: string[],
    onProgress?: (msg: string, inc: number) => void
): Promise<{ added: number; checked: number }> {
    const cookie = vscode.workspace.getConfiguration('lmt').get<string>('leetcodeCookie') ?? '';
    if (!cookie) { throw new Error('未配置 leetcode.cn Cookie'); }
    // 预检登录态：cookie 服务端作废时 submissionList 会静默返回空，必须在这里显式报错
    const who = await gql('{ user { username } }', {}, cookie);
    if (!who?.user?.username) { throw new Error('COOKIE_EXPIRED'); }
    const uniq = [...new Set(slugs.map(s => (s || '').trim()).filter(Boolean))];
    let added = 0;
    let rev: Map<string, QMeta> | undefined; // slug → 元数据
    const metaFor = async (slug: string): Promise<QMeta | undefined> => {
        if (!rev) {
            const m = await allQuestions(ctx);
            rev = new Map([...m.values()].map(x => [x.slug, x]));
        }
        return rev.get(slug);
    };
    for (let i = 0; i < uniq.length; i++) {
        const slug = uniq[i];
        onProgress?.(`${slug} (${i + 1}/${uniq.length})`, 100 / uniq.length);
        try {
            const attempts = await fetchSubmissions(slug, cookie);
            if (attempts.length === 0) { continue; } // 没提交过：不入库，避免污染错题率分母
            const old = store.load().find(r => r.slug === slug);
            const meta = await metaFor(slug).catch(() => undefined);
            const qid = old?.qid ?? meta?.qid ?? 0;
            if (!qid) { log(ctx).appendLine(`sync ${slug}: 题库缓存里找不到题号，跳过`); continue; }
            const before = old?.attempts.length ?? 0;
            const merged = store.upsert({
                qid, slug,
                title: meta?.title ?? old?.title ?? '',
                difficulty: meta?.difficulty ?? old?.difficulty ?? '',
                attempts, errorTypes: []
            });
            added += Math.max(0, merged.attempts.length - before);
        } catch (e: any) {
            log(ctx).appendLine(`sync ${slug} 失败: ${e.message}`);
        }
        await sleep(300);
    }
    return { added, checked: uniq.length };
}

/* ==================== LeetCode 侧题单（收藏夹 / VIP 自建题单） ==================== */

export interface FavFolder {
    slug: string;          // 收藏夹 slug（favoriteSlug，拉题目用）
    name: string;
    favoriteType: string;  // NORMAL 自建 / SMART_LIST 智能题库 / COMPANY_FAVORITE 企业题单
    isPublic: boolean;
}

export interface FavQuestion {
    qid: number; slug: string; title: string;
    difficulty: string;    // EASY / MEDIUM / HARD
    status?: string;       // 服务端进度：SOLVED / ATTEMPTED / TO_DO
    paidOnly?: boolean;
}

/** 我创建的题单（含默认「我的收藏」）+ 收藏的他人题单（企业/官方）。需 Cookie。 */
export async function fetchMyFavorites(cookie: string): Promise<{ created: FavFolder[]; collected: FavFolder[] }> {
    const data = await gql(
        `query { myCreatedFavoriteList { totalLength favorites { name slug isPublicFavorite favoriteType } }
                 myCollectedFavoriteList { totalLength favorites { name slug isPublicFavorite favoriteType } } }`, {}, cookie);
    const map = (arr: any): FavFolder[] => (arr ?? [])
        .filter((f: any) => f && f.slug)
        .map((f: any) => ({ slug: f.slug, name: f.name || f.slug, favoriteType: f.favoriteType ?? 'NORMAL', isPublic: !!f.isPublicFavorite }));
    return { created: map(data?.myCreatedFavoriteList?.favorites), collected: map(data?.myCollectedFavoriteList?.favorites) };
}

/** 题单内的题目（保持网页端自排序；一次返回全量，totalLength>200 的极端题单靠 hasMore 翻页，暂不处理） */
export async function fetchFavoriteQuestions(favSlug: string, cookie: string): Promise<FavQuestion[]> {
    const data = await gql(
        `query fq($s: String!) { favoriteQuestionList(favoriteSlug: $s, sortBy: {sortField: CUSTOM, sortOrder: ASCENDING}, version: "v2") {
            questions { questionFrontendId titleSlug translatedTitle title difficulty status paidOnly }
        } }`, { s: favSlug }, cookie);
    return (data?.favoriteQuestionList?.questions ?? [])
        .filter((q: any) => q && q.titleSlug)
        .map((q: any) => ({
            qid: Number(q.questionFrontendId) || 0, slug: q.titleSlug,
            title: q.translatedTitle || q.title || q.titleSlug, difficulty: q.difficulty ?? '',
            status: q.status || undefined, paidOnly: !!q.paidOnly
        }));
}

/** 根据文件名猜题号；vscode-leetcode 系插件默认文件名形如 "1.two-sum.py"，labuladong 默认 "two-sum.py"（qid=0 待反查） */
export function guessProblemFromFileName(fileName: string): { qid: number; slug: string } | undefined {
    const base = path.basename(fileName).replace(/\.[^.]+$/, '').trim();
    const m = base.match(/^(\d+)[.\-]\s*([a-z0-9\-]+)/i);
    if (m) { return { qid: Number(m[1]), slug: m[2] }; }
    const n = base.match(/^(\d+)$/);
    if (n) { return { qid: Number(n[1]), slug: '' }; }
    const s = base.match(/^([a-z0-9]+(?:-[a-z0-9]+)+)$/i);
    if (s) { return { qid: 0, slug: s[1].toLowerCase() }; }
    return undefined;
}

export function guessProblemFromEditor(editor: vscode.TextEditor | undefined): { qid: number; slug: string } | undefined {
    return editor ? guessProblemFromFileName(editor.document.fileName) : undefined;
}

/** 按 slug 在题库元数据中反查（labuladong 默认文件名无题号前缀时用） */
export async function findBySlug(ctx: vscode.ExtensionContext, slug: string): Promise<QMeta | undefined> {
    const map = await allQuestions(ctx);
    for (const m of map.values()) { if (m.slug === slug) { return m; } }
    return undefined;
}
