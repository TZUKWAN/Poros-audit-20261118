/** Readiness includes authenticated S3 policy; anonymous success is a failure. */
const endpoint = process.env.S3_ENDPOINT || "http://127.0.0.1:59000";
let ready = false;
for (let i = 0; i < 60; i++) {
  try {
    const response = await fetch(endpoint + "/", { signal: AbortSignal.timeout(1000) });
    await response.body?.cancel();
    if (response.status === 403) {
      ready = true;
      break;
    }
    if (response.status === 200) throw new Error("S3 anonymous access is enabled");
  } catch (error) {
    if (error.message === "S3 anonymous access is enabled") throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
}
if (!ready) throw new Error("Authenticated S3 did not become ready");
console.log("S3 ready; anonymous access denied with403");
