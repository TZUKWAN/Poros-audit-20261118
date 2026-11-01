const endpoint = document.querySelector("#endpoint"); const token = document.querySelector("#token");
chrome.storage.local.get({ endpoint: "http://127.0.0.1:4320/api/host-context", token: "" }).then((config) => { endpoint.value = config.endpoint; token.value = config.token; });
document.querySelector("#save").addEventListener("click", () => chrome.storage.local.set({ endpoint: endpoint.value, token: token.value }));
