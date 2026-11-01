// VS Code extensions load through the CommonJS extension host.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const vscode = require("vscode");
function activate(context) {
  const disposable = vscode.commands.registerCommand("piScenario.sendSelection", async () => {
    const editor = vscode.window.activeTextEditor;
    const content = editor?.document.getText(editor.selection) || editor?.document.getText() || "";
    if (!content.trim()) { vscode.window.showWarningMessage("没有可发送的文本"); return; }
    const endpoint = vscode.workspace.getConfiguration("piScenario").get("hostEndpoint", "http://127.0.0.1:4320/api/host-context");
    const token = vscode.workspace.getConfiguration("piScenario").get("hostToken", "");
    const response = await fetch(endpoint, { method: "POST", headers: { "content-type": "application/json", "x-scenario-host-token": token }, body: JSON.stringify({ kind: "note", origin: editor?.document.uri.toString() || "vscode", label: "VS Code 选中文本", content }) });
    if (!response.ok) throw new Error(`Host Bridge HTTP ${response.status}`);
    vscode.window.showInformationMessage("已发送到场景工作台上下文");
  });
  context.subscriptions.push(disposable);
}
function deactivate() {}
module.exports = { activate, deactivate };
