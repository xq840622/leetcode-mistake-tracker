import * as vscode from 'vscode';
import { log } from './leetcode';
import { driverDoneLine } from './debug';

const norm = (p: string | undefined) => p?.replace(/^\/private\//, '/');

/**
 * Python Tutor 式"执行录像"：复用 debugpy（DAP），断在求解方法入口后逐步 next，
 * 每步抓一份 栈帧+局部变量（容器展开一层） 快照，全部步骤交给 webview 回放。
 */

export interface VizVar { name: string; value: string; children?: VizVar[]; }
export interface VizFrame { name: string; line: number; locals: VizVar[]; }
export interface VizStep { line: number; frames: VizFrame[]; output?: string; }

const MAX_STEPS = 150;
const STEP_TIMEOUT_MS = 8_000;   // 单步等 stopped 的上限（正常 <300ms）
const DEADLINE_MS = 45_000;      // 整次录制的墙钟上限
const INIT_TIMEOUT_MS = 10_000;  // 等初始断点命中的上限
const REQ_TIMEOUT_MS = 5_000;    // 单个 DAP 请求的上限——任何一个卡死都不许吊死整个录制

/** customRequest + 超时：卡住的请求会抛错并指名是哪个命令，而不是无限等 */
async function req(out: vscode.OutputChannel, session: vscode.DebugSession, cmd: string, args: any, ms = REQ_TIMEOUT_MS): Promise<any> {
    let timer: NodeJS.Timeout | undefined;
    try {
        return await Promise.race([
            session.customRequest(cmd, args),
            new Promise<never>((_, rej) => { timer = setTimeout(() => rej(new Error(`${cmd} 请求无响应(${ms}ms)`)), ms); })
        ]);
    } finally { if (timer) { clearTimeout(timer); } }
}

/** customRequest 返回体兼容 body 包裹与裸体两种形态 */
function pick<T>(resp: any, key: string): T[] {
    const a = resp?.[key];
    if (Array.isArray(a)) { return a; }
    const b = resp?.body?.[key];
    return Array.isArray(b) ? b : [];
}

const CONTAINER_RE = /^([[{]|list\(|dict\(|set\(|tuple\(|defaultdict|deque|counter\()/i;
const interesting = (name: string) => !name.startsWith('__') && !['self', 'return'].includes(name);

async function readVariables(session: vscode.DebugSession, ref: number, out: vscode.OutputChannel, depth = 0): Promise<VizVar[]> {
    if (!ref || depth > 1) { return []; }
    let vars: any[] = [];
    try {
        const resp = await req(out, session, 'variables', { variablesReference: ref });
        vars = pick<any>(resp, 'variables');
    } catch { return []; }
    const items: VizVar[] = [];
    for (const v of vars.slice(0, 24)) {
        const value = String(v.value ?? '');
        const item: VizVar = { name: String(v.name ?? ''), value };
        if (v.variablesReference > 0 && CONTAINER_RE.test(value) && depth === 0) {
            item.children = await readVariables(session, v.variablesReference, out, depth + 1);
        }
        items.push(item);
    }
    return items;
}

async function captureStep(session: vscode.DebugSession, threadId: number, solutionPath: string, out: vscode.OutputChannel): Promise<VizStep> {
    const st = await req(out, session, 'stackTrace', { threadId, startFrame: 0, levels: 30 });
    const stackFrames = pick<any>(st, 'stackFrames');
    const frames: VizFrame[] = [];
    for (const f of stackFrames) {
        const p = norm(f?.source?.path);
        if (p !== norm(solutionPath)) { continue; } // 只展示题目文件自己的帧
        const scopesResp = await req(out, session, 'scopes', { frameId: f.id });
        const scopes = pick<any>(scopesResp, 'scopes');
        const localScope = scopes.find((s: any) => /local/i.test(String(s?.name ?? ''))) ?? scopes[0];
        let locals: VizVar[] = [];
        if (localScope?.variablesReference) {
            const raw = await readVariables(session, localScope.variablesReference, out);
            locals = raw.filter(v => interesting(v.name));
        }
        frames.push({ name: String(f.name ?? ''), line: f.line ?? 0, locals });
    }
    return { line: frames[0]?.line ?? stackFrames[0]?.line ?? 0, frames };
}

/** 找求解方法体的第一条可执行语句行（断点要下在这里：def 行停在"类定义"时刻，不是调用时刻） */
export function findBodyLine(text: string): number | undefined {
    const lines = text.split('\n');
    let inCode = false;
    let defAt = -1;
    for (let i = 0; i < lines.length; i++) {
        const s = lines[i];
        if (s.includes('@lc code=start')) { inCode = true; continue; }
        if (s.includes('@lc code=end')) { inCode = false; continue; }
        if ((inCode || defAt < 0) && /^\s*def\s+\w+\s*\(/.test(s) && defAt < 0) { defAt = i; continue; }
        if (defAt >= 0 && (inCode || true)) {
            const t = s.trim();
            if (!t || t.startsWith('#') || t.startsWith('"""') || t.startsWith("'''")) { continue; }
            if (/^\s+/.test(s)) { return i + 1; } // 缩进更深的第一条语句 = 方法调用时最先执行的行
            return undefined; // def 后直接顶格 = 空方法体
        }
    }
    return undefined;
}

/** 监听 debugpy 的 stopped/terminated 事件（被动旁观，不干扰正常调试） */
export class VizEventBus {
    private emitter = new vscode.EventEmitter<'stopped' | 'ended'>();
    private sessionEnded = new vscode.EventEmitter<vscode.DebugSession | undefined>();
    registered = false;

    register(ctx: vscode.ExtensionContext): void {
        if (this.registered) { return; }
        this.registered = true;
        const factory: vscode.DebugAdapterTrackerFactory = {
            createDebugAdapterTracker: () => ({
                onDidSendMessage: (msg: any) => {
                    if (msg?.event === 'stopped') { this.emitter.fire('stopped'); }
                    else if (msg?.event === 'terminated' || msg?.event === 'exited') { this.emitter.fire('ended'); }
                }
            })
        };
        ctx.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('debugpy', factory));
        // 第二信号源：会话整体结束（tracker 万一没生效也能兜住）
        ctx.subscriptions.push(vscode.debug.onDidTerminateDebugSession(s => {
            this.emitter.fire('ended');
            this.sessionEnded.fire(s);
        }));
    }

    /** 必须在发出 continue/next 请求之前调用：等到下一个 stopped/ended 或超时 */
    waitStep(timeoutMs: number): Promise<'stopped' | 'ended' | 'timeout'> {
        return new Promise(resolve => {
            let settled = false;
            const done = (v: 'stopped' | 'ended' | 'timeout') => {
                if (settled) { return; }
                settled = true;
                clearTimeout(timer);
                d1.dispose(); d2.dispose();
                resolve(v);
            };
            const timer = setTimeout(() => done('timeout'), timeoutMs);
            const d1 = this.emitter.event(k => done(k));
            const d2 = this.sessionEnded.event(() => done('ended'));
        });
    }
}

export interface RecordResult { steps: VizStep[]; resultsText: string; diag: string[]; }

/** 录制主流程：launch → 方法体首行下断 → 逐步录制 case 1 → 续跑完全部用例并读回结果。 */
export async function recordSteps(
    ctx: vscode.ExtensionContext,
    bus: VizEventBus,
    opts: { driverPath: string; solutionPath: string; solutionText: string; launchConfig: vscode.DebugConfiguration }
): Promise<RecordResult> {
    const out = log(ctx);
    const diag: string[] = [];
    const say = (m: string) => { const l = `viz: ${m}`; out.appendLine(l); diag.push(l); };
    const solutionPath = norm(opts.solutionPath) ?? opts.solutionPath;
    const steps: VizStep[] = [];
    const t0 = Date.now();
    const finish = async (resultsText = ''): Promise<RecordResult> => {
        // 只有确实还有活动会话时才发停止命令，否则 VSCode 会弹"Debug session not found"
        if (vscode.debug.activeDebugSession) {
            try { await vscode.commands.executeCommand('workbench.action.debug.stop'); } catch { /* ignore */ }
        }
        say(`结束，共 ${steps.length} 步，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return { steps, resultsText, diag };
    };
    try {
        // 只认"本次启动"的那个会话：先订阅启动事件再 launch，避免抓到上次残留的僵尸会话
        const started = new Promise<vscode.DebugSession | undefined>(resolve => {
            const d = vscode.debug.onDidStartDebugSession(s => { d.dispose(); resolve(s); });
            setTimeout(() => { d.dispose(); resolve(undefined); }, 15_000);
        });
        const ok = await vscode.debug.startDebugging(undefined, opts.launchConfig);
        if (!ok) { throw new Error('调试会话启动失败'); }
        const session = await started;
        if (!session) { throw new Error('调试会话启动后未收到会话事件'); }

        const th = await req(out, session, 'threads', {});
        const threadId = pick<any>(th, 'threads')[0]?.id;
        if (threadId === undefined) { throw new Error('拿不到线程'); }

        const bpLine = findBodyLine(opts.solutionText);
        if (!bpLine) { throw new Error('没找到方法体首行（空方法或非标准题目文件）'); }
        await req(out, session, 'setBreakpoints', {
            source: { path: opts.solutionPath }, lines: [bpLine], breakpoints: [{ line: bpLine }]
        });
        // 程序启动后本来就在跑，会自己撞上断点——不需要（也不能）对运行中的线程发 continue
        say(`断点下在方法体第 ${bpLine} 行，等待程序命中`);
        const first = await bus.waitStep(INIT_TIMEOUT_MS);
        if (first === 'ended') { throw new Error('程序直接跑完了，没断到方法（断点没绑上？）'); }
        if (first === 'timeout') { throw new Error(`等断点命中超时（${INIT_TIMEOUT_MS / 1000}s）`); }
        say('已断到方法体，开始逐步录制');

        // —— 阶段一：逐步录制，直到方法返回（题目文件的帧消失）——
        for (let i = 0; i < MAX_STEPS && Date.now() - t0 < DEADLINE_MS; i++) {
            let s: VizStep;
            try { s = await captureStep(session, threadId, solutionPath, out); }
            catch (e: any) { say(`第 ${i + 1} 步抓取失败: ${e.message}`); break; }
            if (s.frames.length === 0) { say(`方法已返回（录到 ${steps.length} 步），转入结果采集`); break; }
            steps.push(s);
            if (i % 10 === 0 || i < 3) { say(`step ${i + 1}: line=${s.line} vars=${s.frames[0]?.locals.length ?? 0}`); }
            const wait = bus.waitStep(STEP_TIMEOUT_MS);
            try { await req(out, session, 'next', { threadId }); }
            catch (e: any) { say(`next 失败: ${e.message}`); break; }
            const r = await wait;
            if (r !== 'stopped') {
                say(r === 'ended' ? '程序执行完毕' : `单步等待超时，录到 ${steps.length} 步`);
                steps.push({ line: steps[steps.length - 1]?.line ?? 0, frames: [],
                    output: r === 'ended' ? '✅ 程序执行完毕' : `（单步等待超时，录到 ${steps.length} 步为止）` });
                break;
            }
        }

        // —— 阶段二：在驱动"写结果"的行下断点，续跑完全部用例，读回每个用例的返回值 ——
        const resultsText = await collectResults(session, bus, threadId, opts.driverPath, t0, out, say);
        return finish(resultsText);
    } catch (e: any) {
        say(`⚠ ${e.message}`);
        if (steps.length === 0) { throw e; }
        steps.push({ line: steps[steps.length - 1]?.line ?? 0, frames: [], output: `（录制中止: ${e.message}）` });
    }
    return finish();
}

/** 断点设在驱动最后一行（print 完成提示）：跑到那里时 RESULTS 必然完整，一次 evaluate 拿全部用例结果 */
async function collectResults(
    session: vscode.DebugSession, bus: VizEventBus, threadId: number,
    driverPath: string, t0: number, out: vscode.OutputChannel, say: (m: string) => void
): Promise<string> {
    let resultsText = '';
    try {
        const dline = driverDoneLine();
        if (dline <= 0) { return ''; }
        await req(out, session, 'setBreakpoints', {
            source: { path: driverPath }, lines: [dline], breakpoints: [{ line: dline }]
        });
        // 当前线程处于 stopped；continue 跑完剩余用例，直到命中完成行或程序结束
        for (let round = 0; round < 6 && Date.now() - t0 < DEADLINE_MS + 20_000; round++) {
            const wait = bus.waitStep(INIT_TIMEOUT_MS);
            try { await req(out, session, 'continue', { threadId }); }
            catch { break; }
            const r = await wait;
            if (r !== 'stopped') { break; } // 程序已结束（无 case 或断点没绑上）
            const st = await req(out, session, 'stackTrace', { threadId, startFrame: 0, levels: 5 });
            const top = pick<any>(st, 'stackFrames')[0];
            if (norm(top?.source?.path) === norm(driverPath) && top?.line === dline) {
                try {
                    const ev = await req(out, session, 'evaluate', { expression: 'RESULTS', frameId: top.id });
                    resultsText = String(ev?.result ?? ev?.body?.result ?? resultsText);
                } catch { /* 读不到就保留空 */ }
                break;
            }
        }
        say(`用例结果采集${resultsText ? '完成' : '为空'}`);
    } catch (e: any) {
        say(`结果采集失败（不影响回放）: ${e.message}`);
    }
    return resultsText;
}

/* ============================ 回放 Webview ============================ */

function esc(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* —— Python 语法高亮（跨行状态机：正确处理三引号字符串/注释/前缀字符串），在扩展侧一次分词 —— */
const PY_KW = new Set(['and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match', 'case']);
const PY_CTL = new Set(['if', 'elif', 'else', 'for', 'while', 'return', 'try', 'except', 'finally', 'with', 'break', 'continue', 'pass', 'raise', 'yield', 'and', 'or', 'not', 'in', 'is', 'lambda', 'assert', 'async', 'await', 'del', 'match', 'case']);
const PY_CONST = new Set(['True', 'False', 'None']);
const PY_BUILTIN = new Set(['abs', 'all', 'any', 'bin', 'bool', 'bytearray', 'bytes', 'callable', 'chr', 'classmethod', 'complex', 'dict', 'dir', 'divmod', 'enumerate', 'eval', 'filter', 'float', 'format', 'frozenset', 'getattr', 'hasattr', 'hash', 'hex', 'id', 'input', 'int', 'isinstance', 'issubclass', 'iter', 'len', 'list', 'map', 'max', 'min', 'next', 'object', 'oct', 'open', 'ord', 'pow', 'print', 'property', 'range', 'repr', 'reversed', 'round', 'set', 'setattr', 'slice', 'sorted', 'staticmethod', 'str', 'sum', 'super', 'tuple', 'type', 'vars', 'zip']);

export function highlightPython(code: string): string[] {
    const lines: string[] = [];
    let buf = '';
    let tri = '';          // 当前所处的三引号 ('"""' / "'''")，空 = 不在
    let afterDef = '';     // 刚遇到 def/class，下一个标识符按函数/类名上色
    const n = code.length;
    const emit = (cls: string, text: string) => {
        if (!text) { return; }
        const parts = text.split('\n');
        for (let k = 0; k < parts.length; k++) {
            if (k > 0) { lines.push(buf); buf = ''; }
            if (parts[k]) { buf += `<span class="tk-${cls}">${esc(parts[k])}</span>`; }
        }
    };
    const plain = (text: string) => {
        const parts = text.split('\n');
        for (let k = 0; k < parts.length; k++) {
            if (k > 0) { lines.push(buf); buf = ''; }
            buf += esc(parts[k]);
        }
    };
    let i = 0;
    while (i < n) {
        const c = code[i];
        if (c === '\n') { lines.push(buf); buf = ''; i++; continue; }
        if (tri) {
            const end = code.indexOf(tri, i);
            if (end === -1) { emit('str', code.slice(i)); i = n; }
            else { emit('str', code.slice(i, end + 3)); i = end + 3; tri = ''; }
            continue;
        }
        if (c === ' ' || c === '\t') { plain(c); i++; continue; }
        if (c === '#') {
            const nl = code.indexOf('\n', i);
            const seg = nl === -1 ? code.slice(i) : code.slice(i, nl);
            emit('com', seg); i += seg.length; continue;
        }
        const tri3 = code.substr(i, 3);
        if (tri3 === '"""' || tri3 === "'''") { tri = tri3; emit('str', tri3); i += 3; continue; }
        if (c === '"' || c === "'") {
            const q = c; let j = i + 1;
            while (j < n && code[j] !== q && code[j] !== '\n') { j += code[j] === '\\' ? 2 : 1; }
            const seg = code.slice(i, code[j] === q ? j + 1 : j);
            emit('str', seg); i += seg.length; continue;
        }
        if (/[\d.]/.test(c)) {
            const numM = /^(?:0[xXbBoO][0-9a-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?|\.\d[\d_]*)/.exec(code.slice(i, i + 40));
            if (numM) { emit('num', numM[0]); i += numM[0].length; continue; }
        }
        const idM = /^[A-Za-z_]\w*/.exec(code.slice(i, i + 80));
        if (idM) {
            const w = idM[0];
            if (/^[rRbBuUfF]{1,3}$/.test(w)) {   // 字符串前缀：r'...' f"..." rb'...'
                const after = code[i + w.length];
                if (after === '"' || after === "'") { emit('str', w); i += w.length; continue; }
            }
            if (w === 'def' || w === 'class') { afterDef = w; emit('ctl', w); }
            else if (afterDef && /^[A-Za-z_]\w*$/.test(w)) { emit(afterDef === 'def' ? 'fn' : 'cls', w); afterDef = ''; }
            else if (w === 'self' || w === 'cls') { emit('self', w); }
            else if (PY_CONST.has(w)) { emit('cst', w); }
            else if (PY_CTL.has(w)) { emit('ctl', w); }
            else if (PY_KW.has(w)) { emit('kw', w); }
            else if (PY_BUILTIN.has(w)) { emit('blt', w); }
            else { plain(w); }
            i += w.length; continue;
        }
        if (c === '@' && /^[A-Za-z_]/.test(code[i + 1] ?? '')) {
            const dM = /^@\w+(?:\.\w+)*/.exec(code.slice(i, i + 60));
            if (dM) { emit('dec', dM[0]); i += dM[0].length; continue; }
        }
        const opM = /^(?:->|:=|\*\*|\/\/|==|!=|<=|>=|[-+*/%=<>!&|^~.,:;(){}\[\]])/.exec(code.slice(i, i + 3));
        if (opM) { emit('op', opM[0]); afterDef = ''; i += opM[0].length; continue; }
        plain(c); afterDef = ''; i++;
    }
    lines.push(buf);
    return lines;
}

export function renderVizHtml(steps: VizStep[], code: string, title: string, resultsText = '', diag: string[] = []): string {
    const hl = highlightPython(code);
    const lnw = String(hl.length).length + 4;   // 行号栏宽度按位数自适应（ch 单位，含 ▶ 标记位）
    const js = `
const steps = ${JSON.stringify(steps).replace(/</g, '\\u003c')};
const hlLines = ${JSON.stringify(hl).replace(/</g, '\\u003c')};
const resultsText = ${JSON.stringify(resultsText).replace(/</g, '\\u003c')};
const wesc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/* 明暗主题探测：读编辑器背景亮度，亮色主题切 light 配色 */
(function () {
    const v = getComputedStyle(document.documentElement).getPropertyValue('--vscode-editor-background').trim();
    let lum = 0.4;
    const m = v.match(/rgba?\\(([^)]+)\\)/);
    if (m) { const p = m[1].split(',').map(Number); lum = (0.2126 * p[0] + 0.7152 * p[1] + 0.0722 * p[2]) / 255; }
    else if (/^#[0-9a-fA-F]{6}/.test(v)) { const r = parseInt(v.slice(1, 3), 16), g = parseInt(v.slice(3, 5), 16), b = parseInt(v.slice(5, 7), 16); lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255; }
    if (lum > 0.5) { document.body.classList.add('light'); }
})();

let cur = 0, timer = null;
const slider = document.getElementById('slider');
const codeEl = document.getElementById('code');
const framesEl = document.getElementById('frames');
const infoEl = document.getElementById('info');
const playBtn = document.getElementById('play');

codeEl.innerHTML = hlLines.map((h, i) =>
    '<div class="line" data-n="' + (i + 1) + '"><span class="ln">' + (i + 1) + '</span><span class="src">' + (h || ' ') + '</span></div>'
).join('');
const lineEls = Array.from(codeEl.children);

function typeOf(v) {
    const s = String(v).trim();
    if (s.startsWith('[')) return 'list';
    if (s.startsWith('{')) return 'dict';
    if (s.startsWith('(')) return 'tuple';
    if (/^([rbu]|rb|br|fr|rf|f)?['"']/i.test(s)) return 'str';
    if (s === 'True' || s === 'False') return 'bool';
    if (s === 'None') return 'none';
    if (/^-?\\d/.test(s)) return (s.includes('.') || /[eE][+-]?\\d/.test(s)) && !/^0[xX]/.test(s) ? 'float' : 'int';
    if (/^(list|dict|set|tuple|defaultdict|deque|Counter)\\(/i.test(s)) return 'obj';
    if (s.startsWith('<')) return 'obj';
    return 'val';
}

function framesHtml(s, prev) {
    if (!s.frames.length) {
        const ok = /✅|执行完毕/.test(s.output || '');
        return '<div class="finish' + (ok ? ' ok' : '') + '">' + wesc(s.output || '（无用户帧）') + '</div>';
    }
    const FC = ['f0', 'f1', 'f2', 'f3'];
    let h = '';
    s.frames.forEach((f, fi) => {
        const pf = prev && prev.frames[fi];
        const prevMap = new Map((pf ? pf.locals : []).map(v => [v.name, v.value]));
        h += '<div class="frame ' + FC[fi % 4] + '"><div class="fhead"><span class="dot"></span><span class="fname">' + wesc(f.name) + '()</span><span class="fline">第 ' + f.line + ' 行</span></div><div class="vars">';
        if (!f.locals.length) { h += '<div class="dim">尚无局部变量</div>'; }
        else {
            h += f.locals.map(v => {
                const pv = prevMap.get(v.name);
                const isNew = pf && pv === undefined;
                const chg = pf && pv !== undefined && pv !== v.value;
                const t = typeOf(v.value);
                let inner = '<span class="bdg b-' + t + '">' + t + '</span><span class="vtxt v-' + t + '">' + wesc(v.value) + '</span>';
                if (v.children && v.children.length) {
                    inner += '<div class="kids">' + v.children.map(c => {
                        const ct = typeOf(c.value);
                        return '<div class="kid"><span class="kn">' + wesc(c.name) + '</span><span class="bdg b-' + ct + '">' + ct + '</span><span class="vtxt v-' + ct + '">' + wesc(c.value) + '</span></div>';
                    }).join('') + '</div>';
                }
                return '<div class="var' + (chg ? ' chg' : '') + (isNew ? ' new' : '') + '"><span class="vn">' + wesc(v.name) + '</span>' + (isNew ? '<span class="newchip">新</span>' : '') + '<span class="vv">' + inner + '</span></div>';
            }).join('');
        }
        h += '</div></div>';
    });
    return h;
}

function syncSlider() {
    slider.value = cur;
    const pct = steps.length > 1 ? (cur / (steps.length - 1)) * 100 : 0;
    slider.style.background = 'linear-gradient(90deg, var(--acc) ' + pct + '%, rgba(128,128,128,.35) ' + pct + '%)';
}

function apply() {
    const s = steps[cur];
    for (const el of lineEls) { el.classList.toggle('cur', Number(el.dataset.n) === s.line); }
    const curEl = lineEls[s.line - 1];
    if (curEl && curEl.scrollIntoView) { curEl.scrollIntoView({ block: 'nearest' }); }
    framesEl.innerHTML = framesHtml(s, steps[cur - 1]);
    infoEl.textContent = '第 ' + (cur + 1) + ' / ' + steps.length + ' 步 · 行 ' + s.line;
    syncSlider();
}

function stop() { if (timer) { clearInterval(timer); timer = null; playBtn.textContent = '▶'; } }
playBtn.onclick = () => {
    if (timer) { stop(); return; }
    if (cur >= steps.length - 1) { cur = 0; apply(); }
    playBtn.textContent = '⏸';
    timer = setInterval(() => { if (cur < steps.length - 1) { cur++; apply(); } else { stop(); } }, 500);
};
slider.max = steps.length - 1;
slider.addEventListener('input', () => { stop(); cur = Number(slider.value); apply(); });
const go = d => { stop(); const t = cur + d; if (t >= 0 && t < steps.length) { cur = t; apply(); } };
document.getElementById('prev').onclick = () => go(-1);
document.getElementById('next').onclick = () => go(1);
document.getElementById('first').onclick = () => { stop(); cur = 0; apply(); };
document.getElementById('last').onclick = () => { stop(); cur = steps.length - 1; apply(); };
document.addEventListener('keydown', e => {
    if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
    else if (e.code === 'Space') { e.preventDefault(); playBtn.click(); }
    else if (e.key === 'Home') { stop(); cur = 0; apply(); }
    else if (e.key === 'End') { stop(); cur = steps.length - 1; apply(); }
});

/* 用例结果：[{'case': 1, 'value': ..., 'ms': ...}, ...] 解析成表格 */
(function () {
    const el = document.getElementById('resultsBody');
    if (!el) { return; }
    const re = /'case':\\s*(\\d+),\\s*'value':\\s*(.*?),\\s*'ms':\\s*([\\d.]+)/g;
    let m, rows = '';
    while ((m = re.exec(resultsText))) { rows += '<tr><td class="rc">#' + m[1] + '</td><td class="rv v-' + typeOf(m[2]) + '">' + wesc(m[2]) + '</td><td class="rm">' + m[3] + ' ms</td></tr>'; }
    el.innerHTML = rows || '<tr><td colspan="3"><pre>' + wesc(resultsText) + '</pre></td></tr>';
})();

apply();`;
    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
* { box-sizing: border-box; }
body { font-family: var(--vscode-font-family); margin: 0; display: flex; flex-direction: column; height: 100vh; }
:root { --acc: #4ec9b0; --acc2: #4fc1ff; }
body.light { --acc: #0e8a76; --acc2: #0a66c2; }

/* —— 播放控制条 —— */
#bar { display: flex; align-items: center; gap: 8px; padding: 8px 14px; border-bottom: 1px solid var(--vscode-panel-border); flex-wrap: wrap; }
.btn { all: unset; cursor: pointer; min-width: 30px; text-align: center; padding: 4px 8px; border: 1px solid var(--vscode-panel-border); border-radius: 6px; font-size: 13px; color: var(--vscode-foreground); }
.btn:hover { background: var(--vscode-list-hoverBackground); border-color: var(--acc); }
.btn.play { background: var(--acc); color: #06110e; border-color: var(--acc); font-weight: 700; }
.btn.play:hover { filter: brightness(1.12); }
#slider { flex: 1; min-width: 120px; -webkit-appearance: none; height: 4px; border-radius: 2px; background: rgba(128,128,128,.35); outline: none; }
#slider::-webkit-slider-thumb { -webkit-appearance: none; width: 14px; height: 14px; border-radius: 50%; background: var(--acc); cursor: pointer; border: 2px solid var(--vscode-editor-background); box-shadow: 0 0 0 1px var(--acc); }
.pill { background: rgba(128,128,128,.15); color: var(--vscode-foreground); border: 1px solid var(--vscode-panel-border); border-radius: 12px; padding: 2px 12px; font-size: 12px; white-space: nowrap; }
.hint { color: var(--vscode-descriptionForeground); font-size: 11px; white-space: nowrap; }

#main { flex: 1; display: flex; overflow: hidden; min-height: 0; }
#left { flex: 1.15; min-width: 300px; overflow: auto; padding: 10px; }
#right { flex: 1; min-width: 280px; overflow: auto; padding: 12px 14px; border-left: 1px solid var(--vscode-panel-border); }
@media (max-width: 760px) {
    #main { flex-direction: column; }
    #left { max-height: 46vh; }
    #right { border-left: none; border-top: 1px solid var(--vscode-panel-border); }
}

/* —— 代码面板（语法高亮 + 当前行 + 自适应行号 + 横向滚动） —— */
#code { font-family: var(--vscode-editor-font-family, Menlo, monospace); font-size: 13px; line-height: 1.6; width: max-content; min-width: 100%; padding: 8px 0 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: rgba(128,128,128,.05); }
.line { display: flex; align-items: baseline; white-space: pre; width: max-content; min-width: 100%; padding-right: 20px; }
.line:hover { background: rgba(128,128,128,.08); }
.ln { min-width: var(--lnw); text-align: right; padding-left: 14px; padding-right: 14px; color: var(--vscode-descriptionForeground); opacity: .7; user-select: none; }
.line.cur { background: linear-gradient(90deg, color-mix(in srgb, var(--acc) 36%, transparent), transparent 88%); box-shadow: inset 4px 0 0 var(--acc); }
.line.cur .ln { color: var(--acc); opacity: 1; font-weight: 600; }
.line.cur .ln::after { content: '▶'; margin-left: 5px; font-size: 9px; }
.src { color: var(--vscode-editor-foreground, #d4d4d4); }
.tk-kw { color: #569cd6; } .tk-ctl { color: #c586c0; } .tk-fn { color: #dcdcaa; } .tk-cls { color: #4ec9b0; }
.tk-str { color: #ce9178; } .tk-num { color: #b5cea8; } .tk-com { color: #6a9955; font-style: italic; }
.tk-blt { color: #4fc1ff; } .tk-cst { color: #569cd6; } .tk-dec { color: #dcdcaa; } .tk-self { color: #569cd6; font-style: italic; } .tk-op { color: #a8a8a8; }
body.light .tk-kw { color: #0000ff; } body.light .tk-ctl { color: #af00db; } body.light .tk-fn { color: #795e26; } body.light .tk-cls { color: #267f99; }
body.light .tk-str { color: #a31515; } body.light .tk-num { color: #098658; } body.light .tk-com { color: #008000; }
body.light .tk-blt { color: #001080; } body.light .tk-cst { color: #0000ff; } body.light .tk-dec { color: #795e26; } body.light .tk-self { color: #0000ff; } body.light .tk-op { color: #1f1f1f; }

/* —— 栈帧卡片（Python Tutor 风格） —— */
.frame { border: 1px solid var(--vscode-panel-border); border-radius: 8px; margin-bottom: 12px; overflow: hidden; background: rgba(128,128,128,.04); }
.fhead { display: flex; align-items: center; gap: 8px; padding: 6px 12px; font-size: 12.5px; }
.frame.f0 .fhead { background: color-mix(in srgb, #4ec9b0 16%, transparent); }
.frame.f1 .fhead { background: color-mix(in srgb, #4fc1ff 16%, transparent); }
.frame.f2 .fhead { background: color-mix(in srgb, #c678dd 16%, transparent); }
.frame.f3 .fhead { background: color-mix(in srgb, #e5c07b 16%, transparent); }
.frame.f0 .dot { background: #4ec9b0; } .frame.f1 .dot { background: #4fc1ff; } .frame.f2 .dot { background: #c678dd; } .frame.f3 .dot { background: #e5c07b; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.fname { font-weight: 600; font-family: var(--vscode-editor-font-family, monospace); }
.fline { margin-left: auto; color: var(--vscode-descriptionForeground); font-size: 11.5px; }
.vars { padding: 6px 8px 8px; }
.var { display: grid; grid-template-columns: minmax(64px, max-content) 1fr; gap: 0 10px; align-items: baseline; padding: 3px 6px; border-radius: 5px; font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; }
.var:hover { background: rgba(128,128,128,.08); }
.vn { color: var(--acc2); font-weight: 600; word-break: break-all; }
.vv { word-break: break-word; min-width: 0; }
.vtxt { white-space: pre-wrap; }
.bdg { display: inline-block; font-size: 10px; line-height: 1.5; padding: 0 7px; border-radius: 9px; margin-right: 7px; vertical-align: baseline; font-family: var(--vscode-font-family); }
.b-list { color: #4fc1ff; background: rgba(79,193,255,.14); border: 1px solid rgba(79,193,255,.45); }
.b-dict { color: #e2a03f; background: rgba(226,160,63,.14); border: 1px solid rgba(226,160,63,.45); }
.b-tuple { color: #56d4dd; background: rgba(86,212,221,.14); border: 1px solid rgba(86,212,221,.45); }
.b-str { color: #7ec699; background: rgba(126,198,153,.14); border: 1px solid rgba(126,198,153,.45); }
.b-int, .b-float { color: #e5c07b; background: rgba(229,192,123,.14); border: 1px solid rgba(229,192,123,.45); }
.b-bool { color: #c678dd; background: rgba(198,120,221,.14); border: 1px solid rgba(198,120,221,.45); }
.b-none { color: #8c8c8c; background: rgba(140,140,140,.14); border: 1px solid rgba(140,140,140,.45); }
.b-obj, .b-val { color: #d7ba7d; background: rgba(215,186,125,.12); border: 1px solid rgba(215,186,125,.4); }
.v-list { color: #4fc1ff; } .v-dict { color: #e2a03f; } .v-tuple { color: #56d4dd; } .v-str { color: #7ec699; }
.v-int, .v-float { color: #e5c07b; } .v-bool { color: #c678dd; } .v-none { color: #8c8c8c; } .v-obj, .v-val { color: inherit; }
body.light .tk-com { color: #107510; }
body.light .v-str, body.light .b-str { color: #1a7f37; }
body.light .v-int, body.light .v-float, body.light .b-int, body.light .b-float { color: #8a6d00; }
body.light .v-list, body.light .b-list { color: #0550ae; }
body.light .v-dict, body.light .b-dict { color: #a0670a; }
body.light .v-tuple, body.light .b-tuple { color: #0a7d87; }
body.light .v-bool, body.light .b-bool { color: #8627a8; }
body.light .b-str { background: rgba(26,127,55,.08); border-color: rgba(26,127,55,.45); }
body.light .b-int, body.light .b-float { background: rgba(138,109,0,.08); border-color: rgba(138,109,0,.45); }
body.light .b-list { background: rgba(5,80,174,.08); border-color: rgba(5,80,174,.45); }
body.light .b-dict { background: rgba(160,103,10,.08); border-color: rgba(160,103,10,.45); }
body.light .b-tuple { background: rgba(10,125,135,.08); border-color: rgba(10,125,135,.45); }
body.light .b-bool { background: rgba(134,39,168,.08); border-color: rgba(134,39,168,.45); }
.kids { grid-column: 2; margin: 3px 0 4px; padding: 4px 0 2px 10px; border-left: 2px solid var(--vscode-panel-border); }
.kid { display: flex; align-items: baseline; gap: 6px; padding: 1px 0; flex-wrap: wrap; font-size: 12px; }
.kn { color: var(--vscode-descriptionForeground); }
.newchip { align-self: center; font-size: 10px; color: #4fc1ff; border: 1px solid rgba(79,193,255,.5); border-radius: 8px; padding: 0 6px; grid-row: 1; }
@keyframes chgflash { 0% { background: rgba(126,227,134,.32); } 100% { background: transparent; } }
@keyframes newflash { 0% { background: rgba(79,193,255,.32); } 100% { background: transparent; } }
.var.chg { animation: chgflash 1.2s ease-out; }
.var.new { animation: newflash 1.2s ease-out; }
.dim { color: var(--vscode-descriptionForeground); font-size: 12px; padding: 2px 6px; }

.finish { padding: 10px 14px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; color: var(--vscode-descriptionForeground); font-size: 12.5px; }
.finish.ok { border-color: rgba(126,198,153,.5); background: rgba(126,198,153,.08); color: #7ec699; }

h1 { font-size: 14px; margin: 2px 0 12px; padding-left: 10px; border-left: 3px solid var(--acc); }
.results { margin-bottom: 14px; padding: 8px 12px; border: 1px solid var(--vscode-panel-border); border-radius: 8px; background: rgba(128,128,128,.04); }
.rtitle { font-weight: 600; margin-bottom: 6px; font-size: 12.5px; }
.rtable { border-collapse: collapse; font-size: 12.5px; width: 100%; }
.rtable th { text-align: left; color: var(--vscode-descriptionForeground); font-weight: 500; padding: 2px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
.rtable td { padding: 3px 8px; vertical-align: top; }
.rtable .rc { color: var(--acc2); white-space: nowrap; }
.rtable .rv { font-family: var(--vscode-editor-font-family, monospace); word-break: break-all; }
.rtable .rm { color: var(--vscode-descriptionForeground); white-space: nowrap; }
.results pre { margin: 0; font-family: var(--vscode-editor-font-family, monospace); font-size: 12.5px; white-space: pre-wrap; word-break: break-all; }
.diag { margin-top: 16px; font-size: 12px; color: var(--vscode-descriptionForeground); }
.diag pre { font-family: var(--vscode-editor-font-family, monospace); white-space: pre-wrap; word-break: break-all; }
</style></head>
<body>
<div id="bar">
  <button id="first" class="btn" title="回到开头 (Home)">⏮</button>
  <button id="prev" class="btn" title="上一步 (←)">◀</button>
  <button id="play" class="btn play" title="自动播放 / 暂停 (空格)">▶</button>
  <button id="next" class="btn" title="下一步 (→)">▶</button>
  <button id="last" class="btn" title="跳到最后 (End)">⏭</button>
  <input type="range" id="slider" min="0" value="0">
  <span id="info" class="pill"></span>
  <span class="hint">← → 单步 · 空格 播放</span>
</div>
<div id="main">
  <div id="left"><div id="code" style="--lnw:${lnw}ch"></div></div>
  <div id="right">
    <h1>${esc(title)}</h1>
    ${resultsText ? `<div class="results"><div class="rtitle">📋 全部用例结果</div><table class="rtable"><thead><tr><th>用例</th><th>返回值</th><th>耗时</th></tr></thead><tbody id="resultsBody"></tbody></table></div>` : ''}
    <div id="frames"></div>
    ${diag.length ? `<details class="diag"><summary>诊断日志（出问题时展开截图）</summary><pre>${esc(diag.join('\n'))}</pre></details>` : ''}
  </div>
</div>
<script>${js}</script>
</body></html>`;
}
