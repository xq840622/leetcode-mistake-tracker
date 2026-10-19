import * as vscode from 'vscode';

export interface AiResult {
    type: 'syntax' | 'boundary' | 'complexity' | 'logic' | 'other';
    summary: string;
    fixHint: string;
}

export const DEFAULT_AI_PROMPT = `你是一名严谨的算法刷题教练，负责对学生失败的提交做错误归因。输入包含：题目信息、失败时的代码、失败信息（可能有 RE 完整栈 / WA 的输入·输出·期望三件套），可能还有后来通过的代码。

【任务】定位真正的致错原因，输出错误类别、一句话诊断、一句话修复方向。

【类别判定】按顺序检查，命中即停：
1. syntax —— 语言用法 / API / 类型错误、编译不过、低级笔误（漏冒号、括号不配、变量名写错、多打字符）
2. complexity —— 思路正确但复杂度超标导致超时 / 超内存（含常数过大）
3. boundary —— 算法框架正确，只漏了特定情形：空输入 / 单元素 / 两元素、重复值、溢出、负数与 0、区间端点
4. logic —— 算法思路本身错误：贪心策略错、状态转移方程错、搜索剪枝错、问题不变量理解错
5. other —— 以上都不是（如题目理解偏差、I/O 格式、判题环境差异）

【判定要点】
- 有 WA 判定详情时：先拿出错用例手工代入失败代码，定位第一个出错位置，再归类
- 有「后来通过的代码」时：对比两版差异，第一个语义级差异就是归因对象
- boundary 与 logic 的分界：只补个别情形就能对 = boundary；整体策略要换 = logic
- syntax 与 logic 的分界：代码明显没写完 / 笔误 = syntax；写完整但方法错 = logic

【输出】只输出一个 JSON 对象，不要任何其他文字，不要 markdown 代码块包裹：
{
  "type": "syntax|boundary|complexity|logic|other 之一",
  "summary": "一句话说明错在哪（中文，≤80字）：定位到具体变量/条件/分支，说清为什么错，不给出正确答案",
  "fixHint": "一句话修复方向（中文，≤80字）：指路不代劳，不写完整正确代码"
}`;

/** 实际生效的 system 提示词：lmt.aiPrompt 配了非空值则整体替换（仍需要求输出同结构 JSON，否则解析不了） */
export function systemPrompt(): string {
    const custom = (vscode.workspace.getConfiguration('lmt').get<string>('aiPrompt') ?? '').trim();
    return custom || DEFAULT_AI_PROMPT;
}

/** LLM 是否已配置齐（baseUrl + apiKey + model）——提交失败时据此决定要不要自动整理 */
export function aiConfigured(): boolean {
    const cfg = vscode.workspace.getConfiguration('lmt');
    return !!(cfg.get<string>('aiBaseUrl') && cfg.get<string>('aiApiKey') && cfg.get<string>('aiModel'));
}

export async function analyzeWithAi(
    problemDesc: string, code: string, failInfo: string, acCode = ''
): Promise<AiResult> {
    const cfg = vscode.workspace.getConfiguration('lmt');
    const base = (cfg.get<string>('aiBaseUrl') ?? '').replace(/\/+$/, '');
    const key = cfg.get<string>('aiApiKey') ?? '';
    const model = cfg.get<string>('aiModel') ?? '';
    if (!base || !key || !model) {
        const pick = await vscode.window.showWarningMessage(
            'AI 归因需要配置 baseURL / apiKey / model（OpenAI 兼容格式，默认端点为智谱）。',
            '打开设置');
        if (pick === '打开设置') {
            await vscode.commands.executeCommand('workbench.action.openSettings', 'lmt.ai');
        }
        throw new Error('AI 未配置');
    }

    const codeSection = code
        ? `## 我失败时的代码\n\`\`\`\n${code}\n\`\`\``
        : '## 我失败时的代码\n（未能取到提交代码，请依据失败状态与题目推断最可能的错误类别）';
    const acSection = acCode
        ? `\n\n## 后来通过的代码（对照两版差异归因）\n\`\`\`\n${acCode}\n\`\`\``
        : '';
    const user = `## 题目\n${problemDesc}\n\n${codeSection}\n\n## 失败信息\n${failInfo || '（未提供，请从代码与题目推断最可能的错误）'}${acSection}`;

    const res = await fetch(`${base}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
        body: JSON.stringify({
            model,
            temperature: 0.2,
            max_tokens: 4096,
            messages: [
                { role: 'system', content: systemPrompt() },
                { role: 'user', content: user }
            ]
        })
    });
    if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`AI HTTP ${res.status}: ${text.slice(0, 200)}`);
    }
    const body = await res.json() as any;
    const content: string = body?.choices?.[0]?.message?.content ?? '';
    return parseAiResult(content);
}

export function parseAiResult(content: string): AiResult {
    // 兼容 ```json 包裹与前后闲话
    const m = content.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            const obj = JSON.parse(m[0]);
            const type = (['syntax', 'boundary', 'complexity', 'logic', 'other'] as const)
                .includes(obj.type) ? obj.type : 'other';
            return {
                type,
                summary: String(obj.summary ?? '').slice(0, 200),
                fixHint: String(obj.fixHint ?? '').slice(0, 200)
            };
        } catch { /* fallthrough */ }
    }
    return { type: 'other', summary: content.slice(0, 200) || 'AI 返回无法解析', fixHint: '' };
}
