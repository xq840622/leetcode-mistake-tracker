import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { QuestionDetail } from './leetcode';

/**
 * 原生打开题目：拉题面/模板/示例用例 → 生成 labuladong 兼容格式的本地 .py 文件。
 * 目录结构与 labuladong 完全一致（<root>/leetcode/editor/cn + common/node.py），
 * 因此 🐞 调试与 🔍 可视化驱动开箱即用；没有 labuladong 也能自举。
 */

/** 题目文件根目录（leetcode/ 的上一层）：优先级 lmt.problemsDir > ~/（固定默认，不随当前窗口的工作区漂移；首次「打开题目」时整条目录链自动创建） */
export function problemsRoot(): string {
    const custom = vscode.workspace.getConfiguration('lmt').get<string>('problemsDir') ?? '';
    if (custom) { return custom; }
    return path.join(os.homedir());
}

/**
 * 独立化迁移（activate 时跑一次）：lmt.problemsDir 未设置而机器上存在 labuladong 工作区目录时，
 * 把该目录接管为 lmt.problemsDir（写入用户设置），已有题目文件原地继续可用；
 * 此后本插件不再读 labuladong 的任何配置。
 */
export async function adoptProblemsRoot(ctx: vscode.ExtensionContext): Promise<void> {
    if (ctx.globalState.get('lmt.rootAdopted')) { return; }
    await ctx.globalState.update('lmt.rootAdopted', 1);
    const cfg = vscode.workspace.getConfiguration('lmt');
    if (cfg.get<string>('problemsDir')) { return; }
    const lbWs = vscode.workspace.getConfiguration('labuladong-leetcode').get<string>('workspaceFolder') ?? '';
    if (!lbWs || !fs.existsSync(path.join(lbWs, 'leetcode', 'editor', 'cn'))) { return; }
    await cfg.update('problemsDir', lbWs, vscode.ConfigurationTarget.Global);
    void vscode.window.showInformationMessage(
        `错题本已接管题目目录：${lbWs}（独立运行，不依赖 labuladong；可在设置 lmt.problemsDir 修改）`);
}

export function cnDirOf(root: string): string { return path.join(root, 'leetcode', 'editor', 'cn'); }

/** 内置 ListNode/TreeNode（与 labuladong common/node.py 同源），让自建目录也能跑链表/树题 */
const NODE_PY = `from typing import List


class ListNode:
    def __init__(self, x, next_node=None):
        self.val = x
        self.next = next_node

    @staticmethod
    def create_head(nums: List[int]):
        if len(nums) == 0 or nums is None:
            return None
        head = ListNode(nums[0])
        p = head
        for i in range(1, len(nums)):
            p.next = ListNode(nums[i])
            p = p.next
        return head

    @staticmethod
    def print(head: 'ListNode'):
        p = head
        while p:
            arrow = ' -> ' if p.next else ''
            print(p.val, end=arrow)
            p = p.next
        print()

from typing import List, Union


class TreeNode:
    def __init__(self, x):
        self.val = x
        self.left = None
        self.right = None

    @staticmethod
    def create_root(nums: List[Union[int, None]]):
        if len(nums) == 0 or nums is None:
            return None
        root = TreeNode(nums[0])
        nodes = [root]
        i = 1
        while i < len(nums):
            node = nodes.pop(0)
            if nums[i] is not None:
                node.left = TreeNode(nums[i])
                nodes.append(node.left)
            i += 1
            if i < len(nums) and nums[i] is not None:
                node.right = TreeNode(nums[i])
                nodes.append(node.right)
            i += 1
        return root
`;

/** 确保题目目录与 common/node.py 就绪，返回 cn 目录 */
export function ensureDirs(): string {
    const root = problemsRoot();
    const cn = cnDirOf(root);
    fs.mkdirSync(cn, { recursive: true });
    const common = path.join(root, 'leetcode', 'editor', 'common');
    const nodePy = path.join(common, 'node.py');
    if (!fs.existsSync(nodePy)) {
        fs.mkdirSync(common, { recursive: true });
        fs.writeFileSync(nodePy, NODE_PY, 'utf8');
    }
    return cn;
}

/** 题目描述 HTML → 可读纯文本（docstring 用，粗转换足够） */
export function htmlToText(html: string): string {
    let s = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/(p|div|li|pre|tr|h[1-6])>/gi, '\n')
        .replace(/<li[^>]*>/gi, '• ')
        .replace(/<[^>]+>/g, '');
    s = s.replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&le;/g, '≤').replace(/&ge;/g, '≥').replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'").replace(/&times;/g, '×').replace(/&divide;/g, '÷')
        .replace(/&minus;/g, '-').replace(/&amp;/g, '&');
    s = s.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return s;
}

/** 从 python3 模板签名数参数个数（不含 self）；数不出返回 0 */
export function parseParamCount(python3: string): number {
    const m = /def\s+\w+\s*\(([^)]*)\)/.exec(python3);
    if (!m) { return 0; }
    let inner = m[1];
    if (/^\s*self\s*(,|$)/.test(inner)) { inner = inner.replace(/^\s*self\s*,?/, ''); }
    if (!inner.trim()) { return 0; }
    // 按顶层逗号切（注解里没有嵌套逗号：List[int]、dict[str, int] 有！按括号深度切）
    let depth = 0; const parts: string[] = []; let cur = '';
    for (const ch of inner) {
        if ('([{'.includes(ch)) { depth++; }
        if (')]}'.includes(ch)) { depth--; }
        if (ch === ',' && depth === 0) { parts.push(cur); cur = ''; } else { cur += ch; }
    }
    if (cur.trim()) { parts.push(cur); }
    return parts.filter(p => p.trim()).length;
}

const MAX_CASES = 8;

/** exampleTestcases（每参数一行）按参数个数分组 → 每个 case 一行「字面 \n 分隔参数」（lcpr case 块格式） */
export function casesOf(qd: QuestionDetail): string[] {
    const n = parseParamCount(qd.python3);
    const src = qd.exampleTestcases?.trim() || qd.sampleTestCase?.trim() || '';
    if (!src || n <= 0) { return []; }
    const lines = src.split('\n').map(x => x.trim()).filter(x => x !== '');
    if (lines.length < n || lines.length % n !== 0) {
        // 对不齐（个别题示例带空行/多行参数）：退回 sampleTestCase 一个 case
        const sample = qd.sampleTestCase?.trim();
        if (sample && sample.split('\n').filter(x => x.trim()).length === n) {
            return [sample.split('\n').map(x => x.trim()).join('\\n')];
        }
        return [];
    }
    const cases: string[] = [];
    for (let i = 0; i < lines.length && cases.length < MAX_CASES; i += n) {
        cases.push(lines.slice(i, i + n).join('\\n'));
    }
    return cases;
}

/** 组装 labuladong 兼容的题目文件内容 */
export function buildFileContent(qd: QuestionDetail): string {
    const desc = htmlToText(qd.descHtml).slice(0, 2600);
    const parts: string[] = [
        '#',
        `# @lc app=leetcode.cn id=${qd.frontendId} lang=python3`,
        '# @lcpr version=30404',
        '#',
        `# [${qd.frontendId}] ${qd.title}`,
        '#',
        ''
    ];
    if (desc) {
        parts.push('"""', desc, '"""', '');
    }
    parts.push('# @lc code=start', qd.python3.trimEnd(), '# @lc code=end', '');
    const cases = casesOf(qd);
    if (cases.length) {
        parts.push('');
        for (const c of cases) {
            parts.push('# @lcpr case=start', `# ${c}\\n`, '# @lcpr case=end', '');
        }
    }
    return parts.join('\n') + '\n';
}

/**
 * 历史文件补题干：labuladong 插件生成的老文件没有题面 docstring，打开时顺手回填。
 * 只在 code 区之前的区域没有 `"""` 时插入题面（按整行匹配 `# @lc code=start`，
 * 标记缩进在类里的更老格式则改插到文件头注释块之后），用户代码与用例块一律不动。
 */
export function backfillDesc(file: string, descHtml: string): boolean {
    let text: string;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return false; }
    if (!descHtml) { return false; }
    const desc = htmlToText(descHtml).slice(0, 2600);
    if (!desc) { return false; }
    const lines = text.split('\n');
    const markerIdx = lines.findIndex(l => l.trim() === '# @lc code=start');
    const scope = markerIdx >= 0 ? lines.slice(0, markerIdx) : lines;
    if (scope.some(l => l.includes('"""'))) { return false; } // 已有题干（或头部本就有 docstring）
    let at = markerIdx;               // 标准格式：插在 code 区起点之前
    if (markerIdx < 0) {
        at = 0;                       // 无 @lc 标记的散文件：作为模块 docstring 放最前
    } else if (/^\s+/.test(lines[markerIdx])) {
        at = 0;                       // labuladong 老格式：标记缩进在类里 → 插到文件头注释块之后
        while (at < lines.length && lines[at].startsWith('#')) { at++; }
    }
    lines.splice(at, 0, '"""', desc, '"""', '');
    fs.writeFileSync(file, lines.join('\n'), 'utf8');
    return true;
}

/**
 * 重置代码区（CodeLens ↩️重置 / 编辑器右上角按钮用）：`# @lc code=start` ~ `end` 之间
 * 换成初始 python3 模板，题干与用例块一律不动；模板行按标记行的缩进补前缀
 * （labuladong 老格式标记缩进在类里）。找不到成对标记的老散文件返回 undefined。
 */
export function resetCodeRegion(content: string, template: string): string | undefined {
    const lines = content.split('\n');
    const start = lines.findIndex(l => l.trim() === '# @lc code=start');
    if (start < 0) { return undefined; }
    const end = lines.findIndex((l, i) => i > start && l.trim() === '# @lc code=end');
    if (end < 0) { return undefined; }
    const head = lines[start].slice(0, lines[start].indexOf('#'));
    const body = template.trimEnd().split('\n').map(l => l ? head + l : l);
    return [...lines.slice(0, start + 1), ...body, ...lines.slice(end)].join('\n');
}

/** 本地已存在该题文件则直接用（缺题干的历史文件顺手补写）；否则按详情生成。返回文件绝对路径。 */
export function openOrCreate(qd: QuestionDetail, slug: string): string {
    const cn = ensureDirs();
    let file = path.join(cn, `${qd.frontendId}.${slug}.py`);
    if (fs.existsSync(file)) {
        backfillDesc(file, qd.descHtml);
        return file;
    }
    // 兼容旧文件名风格（无题号前缀）
    const alt = path.join(cn, `${slug}.py`);
    if (fs.existsSync(alt)) {
        backfillDesc(alt, qd.descHtml);
        return alt;
    }
    fs.writeFileSync(file, buildFileContent(qd), 'utf8');
    return file;
}

/** 列出题目目录里的 .py 文件（绝对路径，按 mtime 倒序） */
export function listProblemFiles(): string[] {
    try {
        const cn = cnDirOf(problemsRoot());
        return fs.readdirSync(cn)
            .filter(f => f.endsWith('.py'))
            .map(f => ({ f: path.join(cn, f), t: fs.statSync(path.join(cn, f)).mtimeMs }))
            .sort((a, b) => b.t - a.t).map(x => x.f);
    } catch { return []; }
}
