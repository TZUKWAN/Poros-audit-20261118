chrome.runtime.onInstalled.addListener(() => chrome.contextMenus.create({ id: "send-selection", title: "发送选中文本到场景工作台", contexts: ["selection"] }));
chrome.contextMenus.onClicked.addListener(async (info) => {
  if (info.menuItemId !== "send-selection" || !info.selectionText) return;
  const config = await chrome.storage.local.get({ endpoint: "http://127.0.0.1:4320/api/host-context", token: "" });
  await fetch(config.endpoint, { method: "POST", headers: { "content-type": "application/json", "x-scenario-host-token": config.token }, body: JSON.stringify({ kind: "browser", origin: info.pageUrl || "browser", label: "浏览器选中文本", content: info.selectionText }) });
});
