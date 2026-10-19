// 自测用的 vscode API 桩：out/*.js 在纯 node 环境下只用到这几个调用
const workspace = {
    getConfiguration: (section) => ({
        get: (key) => {
            if (section === 'lmt' && key === 'problemsDir') { return process.env.LMT_TEST_PROBLEMS_ROOT || ''; }
            if (section === 'lmt' && key === 'leetcodeCookie') { return process.env.LMT_TEST_COOKIE || ''; }
            if (section === 'lmt' && key === 'aiPrompt') { return process.env.LMT_TEST_AI_PROMPT || ''; }
            if (section === 'labuladong-leetcode' && key === 'workspaceFolder') { return ''; }
            return undefined;
        }
    }),
    workspaceFolders: [],
    onDidSaveTextDocument: () => ({ dispose() { } }),
    onDidChangeActiveTextEditor: () => ({ dispose() { } })
};
const CodeLens = class { constructor(range, command) { this.range = range; this.command = command; } };
const Range = class { constructor(a, b, c, d) { this.start = { line: a, character: b }; this.end = { line: c, character: d }; } };
module.exports = {
    languages: { registerCodeLensProvider: () => ({ dispose() { } }) },
    CodeLens,
    Range,
    workspace,
    window: {
        createOutputChannel: () => ({ appendLine() { }, show() { }, clear() { }, append() { }, hide() { }, dispose() { } }),
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        showQuickPick: async () => undefined,
        showInputBox: async () => undefined,
        withProgress: async (_l, fn) => fn({ report() { } }),
        createStatusBarItem: () => ({ show() { }, hide() { }, dispose() { } }),
        activeTextEditor: undefined
    },
    commands: { registerCommand: () => ({ dispose() { } }), executeCommand: async () => undefined },
    debug: {
        onDidStartDebugSession: () => ({ dispose() { } }),
        onDidTerminateDebugSession: () => ({ dispose() { } }),
        registerDebugAdapterTrackerFactory: () => ({ dispose() { } }),
        activeDebugSession: undefined,
        startDebugging: async () => true
    },
    EventEmitter: class { event() { return () => { }; } fire() { } dispose() { } },
    TreeItem: class { constructor(label, collapsibleState) { this.label = label; this.collapsibleState = collapsibleState; } },
    TreeItemCollapsibleState: { None: 0, Collapsed: 1, Expanded: 2 },
    ThemeIcon: class { constructor() { } },
    ThemeColor: class { constructor() { } },
    Uri: { file: (f) => ({ fsPath: f }), parse: (f) => ({ toString: () => f }) },
    ViewColumn: { One: 1, Beside: 2 },
    ProgressLocation: { Notification: 15 },
    ConfigurationTarget: { Global: 1 },
    env: { openExternal: async () => undefined, clipboard: { writeText: async () => undefined } }
};
