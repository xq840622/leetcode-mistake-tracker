/**
 * Cookie 一键续期：解析粘贴内容 → 验证 → 同时更新 lmt.leetcodeCookie 与 labuladong 会话文件。
 * 纯逻辑模块（不依赖 vscode），可离线单测。
 */
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface ParsedCookie {
    sessionId: string;      // LEETCODE_SESSION 的值
    csrf: string;           // csrftoken 的值
    full: string;           // 规范化后的完整 cookie 串（两个字段按顺序拼接）
}

export interface SessionInfo {
    login: string;          // 用户名（来自 JWT payload）
    expiresAt: number | undefined;  // 过期时间（unix 秒）
}

/** 从任意粘贴文本（整段 cookie 或 cURL 命令）中提取两个字段；缺一返回 undefined */
export function parseCookieString(text: string): ParsedCookie | undefined {
    const sess = /LEETCODE_SESSION=([^;'"&\s]+)/.exec(text);
    const csrf = /(?:^|;|\s)csrftoken=([^;'"&\s]+)/.exec(text);
    if (!sess || !csrf) { return undefined; }
    return { sessionId: sess[1], csrf: csrf[1], full: `csrftoken=${csrf[1]}; LEETCODE_SESSION=${sess[1]};` };
}

/** 解码 LEETCODE_SESSION（自定义 JWT：payload 带 username / expired_time_） */
export function decodeSession(sessionId: string): SessionInfo {
    try {
        const payload = sessionId.split('.')[1] ?? '';
        const json = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
        return {
            login: json.username || json.login || '',
            expiresAt: json.expired_time_ ?? json.exp ?? undefined
        };
    } catch {
        return { login: '', expiresAt: undefined };
    }
}

/** 在线验证 cookie 是否有效（返回用户名；无效返回 undefined） */
export async function verifyCookie(full: string): Promise<string | undefined> {
    const res = await fetch('https://leetcode.cn/graphql/', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Referer': 'https://leetcode.cn',
            'User-Agent': 'Mozilla/5.0 leetcode-mistake-tracker',
            'Cookie': full
        },
        body: JSON.stringify({ query: 'query { user { username } }', variables: {} })
    });
    if (!res.ok) { throw new Error(`leetcode.cn 返回 HTTP ${res.status}`); }
    const body = await res.json() as { data?: { user?: { username?: string } } };
    return body.data?.user?.username || undefined;
}

/** labuladong 插件（ccagml 系）的会话文件路径 */
export function labuladongUserFile(): string {
    return path.join(os.homedir(), '.lcpr', 'leetcode.cn', 'user.json');
}

/** 合并式更新 labuladong 会话文件（保留 hash/paid 等旧字段） */
export function writeLabuladongSession(file: string, parsed: ParsedCookie, info: SessionInfo): void {
    let old: Record<string, unknown> = {};
    try { old = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 首次登录无旧文件 */ }
    const next = {
        ...old,
        login: info.login || old.login || '',
        name: info.login || old.name || '',
        cookie: parsed.full,
        sessionId: parsed.sessionId,
        sessionCSRF: parsed.csrf
    };
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(next, null, 2), 'utf8');
}
