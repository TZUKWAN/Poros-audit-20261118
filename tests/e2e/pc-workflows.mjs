import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, appendFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileFixtures } from "./pc-fixtures.mjs";

export async function runPcWorkflows({ browser, base, api, login, db, restart, modelFixture }) {
  const evidence = process.env.POROS_PC_EVIDENCE || ".audit/evidence/pc";
  await mkdir(evidence, { recursive: true });
  await writeFile(path.join(evidence, "browser.log"), "");
  const mark = async (id, detail) => {
    const event = JSON.stringify({ id, mode: "DSH model protocol fixture", detail });
    console.log(event);
    await appendFile(path.join(evidence, "browser.log"), event + "\n");
  };
  const screenshot = async (page, name) => {
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      true,
      "page has horizontal overflow",
    );
    await page.screenshot({ path: path.join(evidence, name + ".png"), fullPage: true });
  };
  const nonce = randomUUID().slice(0, 8);
  const projectName = "PC 验收项目 " + nonce;
  const agentName = "PC 文档 Agent " + nonce;
  const pages = await Promise.all([
    browser.newPage({ viewport: { width: 1920, height: 1080 }, acceptDownloads: true }),
    browser.newPage({ viewport: { width: 1366, height: 768 }, acceptDownloads: true }),
    browser.newPage({ viewport: { width: 1366, height: 768 }, acceptDownloads: true }),
  ]);
  const [admin, reviewer, employee] = pages;
  const errors = [];
  pages.forEach((page) => {
    page.on("pageerror", (e) => errors.push(e.message));
    page.setDefaultTimeout(20000);
  });
  const btn = (page, name) => page.getByRole("button", { name, exact: true });
  const tab = async (page, name) => {
    await page.getByRole("tab", { name, exact: true }).click();
  };
  const wait = (page, text, timeout = 20000) =>
    page.getByText(text, { exact: false }).first().waitFor({ timeout });
  const uiLogin = async (page, role, account = `${role}@a.test`, password = `${role}-pass-123`) => {
    await page.goto(base);
    await page.getByLabel("组织 ID").fill("org-a");
    await page.getByLabel("邮箱", { exact: true }).fill(account);
    await page.getByLabel("密码", { exact: true }).fill(password);
    await btn(page, "登录").click();
    await page.getByRole("heading", { name: "Poros 工作台" }).waitFor();
  };
  const token = await login("admin");
  const reviewerToken = await login("reviewer");
  const employeeToken = await login("employee");
  const unassigned = await login("builder");
  const crossOrg = await login("outsider", "org-b");
  const createProjectMember = async (member, role) => {
    await admin.getByLabel("组织成员").selectOption(member);
    await admin.getByLabel("项目角色").selectOption(role);
    await btn(admin, "保存项目权限").click();
    await wait(admin, "项目权限已保存");
    await admin
      .getByText(member + " · " + (role === "VIEWER" ? "只读成员" : "协作者"), { exact: true })
      .waitFor();
  };
  const decide = async (text, decision) => {
    await tab(reviewer, "审批与规则");
    await btn(reviewer, "刷新").click();
    const approval = reviewer
      .locator("article")
      .filter({ hasText: text })
      .filter({ has: btn(reviewer, decision) })
      .first();
    await approval.getByRole("button", { name: decision, exact: true }).click();
    await wait(reviewer, "审批决定已记录");
    await approval
      .getByRole("button", { name: decision, exact: true })
      .waitFor({ state: "hidden" });
  };
  const latestTask = async (userToken, query) => {
    const r = await api("GET", "/api/tasks?q=" + encodeURIComponent(query), userToken);
    assert.equal(r.status, 200, r.text);
    const id = r.json.tasks[0]?.id;
    assert.ok(id, `missing durable task ${query}`);
    return id;
  };
  try {
    await Promise.all([
      uiLogin(admin, "admin"),
      uiLogin(reviewer, "reviewer"),
      uiLogin(employee, "employee"),
    ]);
    assert.equal(await reviewer.getByRole("tab", { name: "审批与规则" }).isVisible(), true);
    assert.equal(await employee.getByRole("tab", { name: "审批与规则" }).isVisible(), true);
    assert.equal(await employee.getByLabel("Agent", { exact: true }).inputValue(), "");
    assert.equal(await employee.getByLabel("任务", { exact: true }).isVisible(), true);
    assert.equal(await employee.getByLabel("任务项目").isVisible(), false);
    await tab(admin, "设置");
    await admin.getByRole("heading", { name: "组织账号管理" }).waitFor();
    await tab(employee, "设置");
    await employee.getByRole("heading", { name: "个人集成设置" }).waitFor();
    assert.equal(await employee.getByRole("heading", { name: "组织账号管理" }).count(), 0);
    assert.equal((await api("GET", "/api/members", employeeToken)).status, 403);
    const memberEmail = `pc-${nonce}@a.test`,
      memberPassword = "Fixture-Initial-" + nonce;
    await admin.getByLabel("成员邮箱").fill(memberEmail);
    await admin.getByLabel("新账号初始密码").fill(memberPassword);
    await btn(admin, "保存组织成员").click();
    await wait(admin, "成员已保存");
    const lifecycle = await browser.newPage({ viewport: { width: 1366, height: 768 } });
    await uiLogin(lifecycle, "employee", memberEmail, memberPassword);
    const sessionToken = await lifecycle.evaluate(() => localStorage.getItem("poros-token"));
    await btn(lifecycle, "退出").click();
    await btn(lifecycle, "登录").waitFor();
    assert.equal((await api("GET", "/api/auth/me", sessionToken)).status, 401);
    await uiLogin(lifecycle, "employee", memberEmail, memberPassword);
    const revoked = await lifecycle.evaluate(() => localStorage.getItem("poros-token"));
    await btn(admin, "停用成员 " + memberEmail).click();
    await btn(admin, "确认").click();
    await wait(admin, "账号已停用");
    assert.equal((await api("GET", "/api/auth/me", revoked)).status, 401);
    assert.ok(
      (
        await db.membership.findUnique({
          where: { organizationId_userId: { organizationId: "org-a", userId: memberEmail } },
        })
      ).disabledAt,
    );
    await lifecycle.close();
    await mark(
      "PC-01",
      "PC login, roles, account provision, logout and disable verified against auth API and Membership",
    );

    await tab(admin, "项目空间");
    await btn(admin, "新建项目").click();
    await admin.getByLabel("项目名称").fill(projectName);
    await admin.getByLabel("项目说明").fill("隔离验收项目");
    await btn(admin, "保存项目").click();
    await admin.getByRole("heading", { name: projectName, exact: true }).waitFor();
    await btn(admin, "编辑项目").click();
    await admin.getByLabel("项目说明").fill("编辑后的项目说明");
    await btn(admin, "保存项目").click();
    await wait(admin, "编辑后的项目说明");
    const projectId = (await api("GET", "/api/projects", token)).json.projects.find(
      (p) => p.name === projectName,
    ).id;
    assert.equal((await api("GET", `/api/projects/${projectId}`, crossOrg)).status, 403);
    assert.equal((await api("GET", `/api/projects/${projectId}`, unassigned)).status, 403);
    await btn(admin, "项目成员").click();
    await createProjectMember("employee@a.test", "VIEWER");
    const viewerUpload = await api("POST", "/api/files", employeeToken, {
      projectId,
      name: "denied.txt",
      contentBase64: "bm8=",
    });
    assert.equal(viewerUpload.status, 403);
    await createProjectMember("employee@a.test", "CONTRIBUTOR");
    await createProjectMember("reviewer@a.test", "CONTRIBUTOR");
    assert.equal((await api("GET", `/api/projects/${projectId}`, employeeToken)).status, 200);
    await mark("PC-02", {
      projectId,
      checks: "PC create, edit, actual roles and cross-project/tenant access",
    });
    await screenshot(admin, "01-project-members-1920");

    await tab(admin, "Agent 目录");
    await btn(admin, "新建 Agent").click();
    await admin.getByLabel("创建方式").selectOption("live");
    await wait(admin, "连接未验证");
    assert.equal(await btn(admin, "生成草稿").isDisabled(), true);
    await admin.getByLabel("创建方式").selectOption("manual");
    const createDialog = admin.getByRole("dialog", { name: "新建 Agent" });
    await createDialog.getByLabel("Agent 名称").fill(agentName);
    await createDialog.getByLabel("部门").fill("验收部门");
    const persona = "POROS-PC-PERSONA-" + nonce;
    await createDialog.getByLabel("角色与任务").fill(persona);
    await btn(admin, "创建草稿").click();
    await admin.getByRole("heading", { name: "Builder · " + agentName }).waitFor();
    await admin.getByLabel("输出要求").selectOption("markdown-document");
    await btn(admin, "保存草稿").click();
    await wait(admin, "最近保存变更");
    const agentId = (await api("GET", "/api/agents", token)).json.agents.find(
      (a) => a.name === agentName,
    ).id;
    assert.equal(
      (await db.agentDefinition.findUnique({ where: { id: agentId } })).draftOrigin,
      "MANUAL",
    );
    await mark(
      "PC-03",
      "Manual creation persisted in PC. Real-model generation correctly requires a verified connection; live generation not accepted",
    );
    const grant = async (kind, name) => {
      await admin.getByLabel("能力类型").selectOption(kind);
      await admin.getByLabel("能力", { exact: true }).selectOption(name);
      await admin.getByLabel("用途及授权范围").fill("PC 验收专属授权");
      await btn(admin, "保存授权").click();
      await wait(admin, "草稿授权已保存");
      await admin.getByRole("button", { name: "撤销授权 " + name, exact: true }).waitFor();
    };
    await grant("TOOL", "bash");
    await grant("MODEL", "deepseek-chat");
    const publish = async (decision) => {
      await btn(admin, "申请发布").click();
      await admin.getByRole("dialog", { name: "确认发布申请" }).waitFor();
      await btn(admin, "冻结并提交审批").click();
      await wait(admin, "已冻结，等待独立审批");
      await decide(agentName, decision);
      await tab(admin, "工作台");
      await tab(admin, "Agent 目录");
      await admin.getByRole("button", { name: new RegExp(agentName) }).click();
      await btn(admin, "编辑与测试").click();
      await admin.getByRole("heading", { name: "Builder · " + agentName }).waitFor();
    };
    await publish("批准");
    await admin.getByLabel("角色与任务").fill("发布与回滚验收的新 Persona");
    await btn(admin, "保存草稿").click();
    await wait(admin, "最近保存变更");
    await publish("拒绝");
    await publish("批准");
    await admin.getByLabel("回滚目标版本").selectOption("1");
    await btn(admin, "回滚到选中版本").click();
    await wait(admin, "已回滚到 v1");
    const release = await db.agentDefinition.findUnique({
      where: { id: agentId },
      include: { versions: { orderBy: { version: "asc" } } },
    });
    assert.equal(release.currentVersion, 1);
    assert.deepEqual(
      release.versions.map((v) => Boolean(v.approvedAt)),
      [true, false, true],
    );
    assert.equal(release.versions[0].manifest.config.persona, persona);
    assert.equal(
      release.versions[0].manifest.grants.find((g) => g.name === "bash").scopeNote,
      "PC 验收专属授权",
    );
    await screenshot(admin, "02-builder-and-versions-1920");
    await mark("PC-07", { agentId, approved: [1, 3], rejected: 2, rollback: 1 });
    const conflictInput = "浏览器未保存的修改 " + nonce;
    await admin.getByLabel("角色与任务").fill(conflictInput);
    const concurrent = await api("PATCH", `/api/agents/${agentId}/draft`, token, {
      config: { persona: "另一位编辑者保存 " + nonce },
    });
    assert.equal(concurrent.status, 200, concurrent.text);
    await btn(admin, "保存草稿").click();
    await wait(admin, "草稿保存发生冲突");
    assert.equal(await admin.getByLabel("角色与任务").inputValue(), conflictInput);
    await btn(admin, "采用当前已保存版本").click();
    assert.equal(await admin.getByLabel("角色与任务").inputValue(), "另一位编辑者保存 " + nonce);
    await mark(
      "IX-01",
      "Concurrent draft save rejected with HTTP409; local input preserved and current saved version explicitly adopted",
    );

    await tab(admin, "项目空间");
    await admin.getByRole("button", { name: new RegExp(projectName) }).click();
    await btn(admin, "关联 Agent").click();
    await admin.getByLabel("选择 Agent").selectOption(agentId);
    await btn(admin, "关联到项目").click();
    await btn(admin, "确认").click();
    await wait(admin, "已关联 Agent");
    assert.equal(
      (
        await api("POST", "/api/tasks", employeeToken, {
          agentId,
          prompt: "unscoped",
          consent: ["bash"],
        })
      ).status,
      403,
    );
    assert.equal(
      (
        await api("POST", "/api/tasks", employeeToken, {
          agentId,
          projectId,
          prompt: "missing tool consent",
        })
      ).status,
      403,
    );
    await btn(admin, "文件").click();
    const files = fileFixtures(nonce);
    for (const [name, buffer, marker] of files) {
      await admin
        .getByLabel("上传文件")
        .setInputFiles({ name, mimeType: "application/octet-stream", buffer });
      await admin.getByLabel("文件分类").fill("验收资料");
      await admin.getByLabel("来源 URL").fill("https://example.com/poros-pc-fixture");
      await btn(admin, "上传").click();
      await btn(admin, "预览 " + name).click();
      const dialog = admin.getByRole("dialog", { name });
      await dialog.getByText(marker, { exact: false }).waitFor();
      if (name.endsWith(".xlsx"))
        await dialog.getByText("工作表：项目核验", { exact: false }).waitFor();
      await dialog.getByRole("button", { name: "关闭" }).click();
    }
    const fileResults = await api("GET", "/api/files?projectId=" + projectId, token);
    assert.equal(fileResults.json.files.length, 4);
    assert.equal((await api("GET", "/api/files?projectId=" + projectId, unassigned)).status, 403);
    const downloaded = admin.waitForEvent("download");
    await btn(admin, "下载 brief.md").click();
    const download = await downloaded;
    assert.deepEqual(await readFile(await download.path()), files[0][1]);
    await screenshot(admin, "03-files-1920");
    await btn(admin, "处理文件 brief.md").click();
    assert.equal(await admin.getByLabel("任务项目").inputValue(), projectId);
    assert.equal(await admin.getByLabel("Agent", { exact: true }).inputValue(), "");
    await wait(admin, "已提取文字");
    await admin.getByLabel("任务", { exact: true }).fill("从项目文件开始的草稿 " + nonce);
    await btn(admin, "个人连接").click();
    await admin
      .getByRole("dialog", { name: "当前账号的个人连接" })
      .getByRole("heading", { name: "Kdocs 金山文档" })
      .waitFor();
    await btn(admin, "返回当前工作").click();
    assert.equal(
      await admin.getByLabel("任务", { exact: true }).inputValue(),
      "从项目文件开始的草稿 " + nonce,
    );
    await admin.reload();
    assert.equal(
      await admin.getByLabel("任务", { exact: true }).inputValue(),
      "从项目文件开始的草稿 " + nonce,
    );
    assert.equal(await admin.getByLabel("任务项目").inputValue(), projectId);
    await wait(admin, "已提取文字");
    await btn(admin, "返回项目").click();
    await admin.getByRole("heading", { name: projectName, exact: true }).waitFor();
    await mark(
      "IX-02",
      "File entry carries exact project and file; explicit assistant selection, in-context settings and draft survive reload; return opens the same project",
    );

    const submit = async (prompt, pins = []) => {
      await tab(employee, "工作台");
      await btn(employee, "新建工作").click();
      await employee.locator("summary").filter({ hasText: "项目与文件" }).click();
      await employee.getByLabel("任务项目").selectOption(projectId);
      await employee.getByLabel("Agent", { exact: true }).selectOption(agentId);
      await employee.getByLabel("任务", { exact: true }).fill(prompt);
      if (pins.length) {
        for (const name of pins) {
          const listed = await api(
            "GET",
            `/api/files?projectId=${projectId}&q=${encodeURIComponent(name)}`,
            employeeToken,
          );
          assert.equal(listed.status, 200, listed.text);
          const file = listed.json.files.find((f) => f.name === name);
          await employee.getByLabel("按名称搜索可引用文件").fill(name);
          await employee.getByLabel("任务输入文件").selectOption(file.id);
          await btn(employee, "添加输入文件").click();
        }
      }
      await employee.getByRole("checkbox", { name: /同意本次使用/ }).check();
      await btn(employee, "开始工作").click();
      await wait(employee, "正在等待独立审批");
      assert.equal(await employee.getByLabel("任务", { exact: true }).isVisible(), true);
      await employee.locator("summary").filter({ hasText: "查看执行过程与证据" }).click();
      return latestTask(employeeToken, prompt);
    };
    const approveTask = async (taskId, decision = "批准") => {
      const all = await api("GET", "/api/approvals", reviewerToken);
      const pending = all.json.approvals.find(
        (a) => a.subjectId === taskId && a.decision === "PENDING",
      );
      assert.ok(pending, "expected pending independent task approval");
      // Locate the structured approval by checking its task link. The baseline test also uses this reviewer.
      await tab(reviewer, "审批与规则");
      await btn(reviewer, "刷新").click();
      const approval = reviewer.locator(`article[data-approval-id="${pending.id}"]`);
      const response = reviewer.waitForResponse(
        (r) =>
          r.request().method() === "POST" &&
          r.url().endsWith(`/api/approvals/${pending.id}/decision`),
      );
      await approval.getByRole("button", { name: decision, exact: true }).click();
      const decisionResponse = await response;
      assert.equal(decisionResponse.status(), 200, await decisionResponse.text());
      await wait(reviewer, "审批决定已记录");
      await approval.waitFor({ state: "hidden" });
    };
    const finish = async (taskId, userToken) => {
      const r = await api("GET", `/api/tasks/${taskId}`, userToken);
      assert.equal(r.status, 200, r.text);
      assert.ok(r.json.runs[0]?.finishedAt, r.text);
      return r.json.runs[0];
    };
    const firstPrompt = "PC 文件与执行验收 " + nonce;
    const firstId = await submit(firstPrompt, ["brief.md", "policy.docx", "table.xlsx"]);
    await btn(employee, "查看审批申请").click();
    await employee.getByRole("heading", { name: "我的审批申请" }).waitFor();
    assert.equal(await btn(employee, "批准").count(), 0);
    await wait(employee, "当前显示所选请求的审批记录");
    await btn(employee, "返回原工作").click();
    await wait(employee, "正在等待独立审批");
    await employee.locator("summary").filter({ hasText: "查看执行过程与证据" }).click();
    await approveTask(firstId);
    await employee.getByText("已结束", { exact: true }).waitFor({ timeout: 45000 });
    const firstRun = await finish(firstId, employeeToken);
    assert.equal(firstRun.status, "UNVERIFIED");
    for (const [, , marker] of files.slice(0, 3))
      assert.ok(firstRun.output.includes(marker), firstRun.output);
    assert.ok(firstRun.output.includes(persona), firstRun.output);
    assert.equal(firstRun.fileUses.length, 3);
    assert.ok(firstRun.fileUses.every((u) => /^[a-f0-9]{64}$/.test(u.digest) && u.chars > 0));
    assert.equal(firstRun.artifact.name, `poros-${firstRun.id}.md`);
    const tool = employee.getByText("dsh.tool_result", { exact: true });
    await tool.waitFor();
    assert.ok((await tool.locator("..").textContent()).includes("POROS-DSH-REAL-EXEC"));
    const artifact = employee.waitForEvent("download");
    await btn(employee, "下载产物").click();
    assert.equal(
      (await readFile(await (await artifact).path(), "utf8")).trim(),
      firstRun.output.trim(),
    );
    assert.equal(
      (await api("POST", `/api/tasks/${firstId}/accept`, employeeToken, { runId: firstRun.id }))
        .status,
      409,
    );
    assert.equal((await api("GET", `/api/tasks/${firstId}`, unassigned)).status, 403);
    await mark(
      "PC-04",
      "Rolled-back Persona reached DSH model request; Markdown policy persisted an actual downloadable artifact",
    );
    await mark("PC-05", {
      allowed: "bash actual output",
      denied: "missing task consent HTTP403",
      runId: firstRun.id,
    });
    await mark("PC-08", {
      read: ["md", "docx", "xlsx", "pdf"],
      modelTransportRefs: firstRun.fileUses.map((u) => u.ref),
      runId: firstRun.id,
    });
    await employee.locator("summary").filter({ hasText: "查看文件来源" }).click();
    await btn(employee, "预览引用文件 brief.md").click();
    await employee
      .getByRole("dialog", { name: "brief.md" })
      .getByText(files[0][2], { exact: false })
      .waitFor();
    await btn(employee, "返回结果").click();
    await screenshot(employee, "04-run-with-files-1366");
    await employee.locator("summary").filter({ hasText: "查看文件来源" }).click();

    const originalWorkUrl = employee.url();
    await employee.locator("summary").filter({ hasText: "评价这次结果" }).click();
    await employee.getByLabel("本次评价").selectOption("NEEDS_CHANGES");
    await employee.getByLabel("本次结果意见").fill("只调整本次简报，不增加长期规则");
    await btn(employee, "保存本次评价").click();
    await wait(employee, "本次评价已记录");
    assert.equal(await db.runFeedback.count({ where: { runId: firstRun.id } }), 1);
    assert.equal(await db.judgmentRule.count({ where: { sourceRunId: firstRun.id } }), 0);
    assert.equal((await finish(firstId, employeeToken)).status, "UNVERIFIED");
    await btn(employee, "修改此结果").click();
    const revisionPrompt = "把这份简报改为三点结论 " + nonce;
    await employee.getByLabel("任务", { exact: true }).fill(revisionPrompt);
    await employee.getByRole("checkbox", { name: /同意本次使用/ }).check();
    await btn(employee, "发送修改要求").click();
    await wait(employee, "正在等待独立审批");
    const revisedId = await latestTask(employeeToken, revisionPrompt);
    const originalTask = await db.task.findUniqueOrThrow({ where: { id: firstId } });
    const revisedTask = await db.task.findUniqueOrThrow({ where: { id: revisedId } });
    assert.equal(revisedTask.conversationId, originalTask.conversationId);
    assert.equal(revisedTask.parentRunId, firstRun.id);
    assert.equal(revisedTask.intent, "REVISION");
    assert.equal(revisedTask.turn, 2);
    await employee.locator("summary").filter({ hasText: "查看执行过程与证据" }).click();
    await approveTask(revisedId);
    await employee.getByText("已结束", { exact: true }).waitFor({ timeout: 45000 });
    const revisedRun = await finish(revisedId, employeeToken);
    assert.equal(revisedRun.artifact.revisionOfId, firstRun.artifact.id);
    assert.equal(
      (await db.task.findUniqueOrThrow({ where: { id: revisedId } })).contextSnapshot.entries[0]
        .output,
      firstRun.output,
    );
    for (const [, , marker] of files.slice(0, 3))
      assert.ok(revisedRun.output.includes(marker), revisedRun.output);
    assert.equal((await finish(firstId, employeeToken)).output, firstRun.output);
    const revisedWorkUrl = employee.url();
    assert.equal(
      new URL(revisedWorkUrl).hash.split("?")[0],
      new URL(originalWorkUrl).hash.split("?")[0],
    );
    await employee.reload();
    assert.equal(employee.url(), revisedWorkUrl);
    await employee.getByText(revisionPrompt, { exact: true }).waitFor();
    await btn(employee, "查看第 1 条结果与过程").click();
    await mark("IX-03", {
      conversationId: originalTask.conversationId,
      original: firstRun.id,
      revised: revisedRun.id,
      feedbackIndependent: true,
      priorOutputReachedContext: true,
      artifactRevisionLinked: true,
      stableReloadUrl: true,
    });
    await screenshot(employee, "08-continuous-work-1366");

    await btn(employee, "建议今后遵循").click();
    await employee.getByLabel("纠正说明").fill("验证将明确纠正关联到这次运行。");
    await employee.getByLabel("检查文本").fill("POROS-DSH-OK");
    await btn(employee, "提交纠正").click();
    await wait(employee, "纠正已关联原始运行");
    const correction = await db.judgmentRule.findFirst({ where: { sourceRunId: firstRun.id } });
    assert.equal(correction.sourceEvidence.originalOutput, firstRun.output);
    assert.equal(correction.sourceEvidence.taskId, firstId);
    assert.equal(correction.sourceEvidence.agentVersion, 1);
    await screenshot(employee, "05-correction-1366");
    await btn(employee, "完成").click();
    await decide(correction.rule, "批准");
    await mark("PC-10", { ruleId: correction.id, runId: firstRun.id, originalOutputStored: true });
    const nextPrompt = "PC 判断规则执行 " + nonce;
    const next = await submit(nextPrompt);
    await approveTask(next);
    await employee.getByText("已结束", { exact: true }).waitFor({ timeout: 45000 });
    const nextRun = await finish(next, employeeToken);
    assert.equal(nextRun.applications.find((a) => a.ruleId === correction.id).evaluation, "PASS");
    assert.equal(nextRun.status, "UNVERIFIED");
    await mark("PC-11", {
      ruleId: correction.id,
      runId: nextRun.id,
      mechanical: "PASS",
      runStatus: "UNVERIFIED",
    });
    await mark("PC-16", {
      taskId: firstId,
      runId: firstRun.id,
      verified:
        "PC action flow with real DSH, S3, project RBAC, independent approval and correction",
    });

    const cancelled = await submit("PC 取消 " + nonce);
    await btn(employee, "取消").click();
    await wait(employee, "取消请求已提交");
    await employee.getByText("已结束", { exact: true }).waitFor();
    assert.equal((await db.task.findUnique({ where: { id: cancelled } })).status, "CANCELLED");
    await tab(admin, "项目空间");
    await admin.getByRole("button", { name: new RegExp(projectName) }).click();
    await btn(admin, "文件").click();
    await admin.getByLabel("上传文件").setInputFiles({
      name: "invalid.pdf",
      mimeType: "application/pdf",
      buffer: Buffer.from("not a PDF body"),
    });
    await btn(admin, "上传").click();
    await btn(admin, "预览 invalid.pdf").waitFor();
    await tab(employee, "工作台");
    await btn(employee, "新建工作").click();
    await employee.locator("summary").filter({ hasText: "项目与文件" }).click();
    await employee.getByLabel("任务项目").selectOption(projectId);
    await employee.getByLabel("Agent", { exact: true }).selectOption(agentId);
    await employee.getByLabel("任务", { exact: true }).fill("PC 失败与重试 " + nonce);
    const badFile = (
      await api("GET", `/api/files?projectId=${projectId}&q=invalid.pdf`, employeeToken)
    ).json.files[0];
    await employee.getByLabel("任务输入文件").selectOption(badFile.id);
    const failedPreview = employee.waitForResponse((response) =>
      response.url().endsWith(`/api/files/${badFile.id}/preview`),
    );
    await btn(employee, "添加输入文件").click();
    const previewFailure = await failedPreview;
    assert.equal(previewFailure.status(), 422);
    await wait(employee, (await previewFailure.json()).error);
    assert.equal(await btn(employee, "开始工作").isDisabled(), true);
    // The form rejects unreadable input; the API still exercises runtime failure and controlled retry.
    const badAdmission = await api(
      "POST",
      "/api/tasks",
      employeeToken,
      {
        agentId,
        projectId,
        prompt: "PC 失败与重试 " + nonce,
        fileIds: [badFile.id],
        consent: ["bash"],
      },
      randomUUID(),
    );
    assert.equal(badAdmission.status, 202, badAdmission.text);
    const bad = badAdmission.json.taskId;
    await employee.goto(base + "#/work/" + badAdmission.json.conversationId);
    await wait(employee, "正在等待独立审批");
    await employee.locator("summary").filter({ hasText: "查看执行过程与证据" }).click();
    await approveTask(bad);
    await employee.getByText("已结束", { exact: true }).waitFor({ timeout: 45000 });
    assert.equal((await finish(bad, employeeToken)).failureCode, "FILE_READ_FAILED");
    await employee.getByRole("checkbox", { name: /同意重试使用/ }).check();
    await btn(employee, "重试").click();
    await wait(employee, "已提交重试");
    await approveTask(bad);
    await employee.getByText("已结束", { exact: true }).waitFor({ timeout: 45000 });
    const retryRecord = await api("GET", `/api/tasks/${bad}`, employeeToken);
    assert.equal(retryRecord.json.task.attempts, 2);
    assert.deepEqual(
      retryRecord.json.runs.map((run) => run.failureCode),
      ["FILE_READ_FAILED", "FILE_READ_FAILED"],
    );
    await employee.getByLabel("历史运行").selectOption(retryRecord.json.runs[1].id);
    await wait(employee, retryRecord.json.runs[1].id);
    await mark("PC-09", {
      cancelled,
      retried: bad,
      attempts: 2,
      fault: "FILE_READ_FAILED",
      transport: "durable SSE and PC cancellation/retry/history",
    });

    await tab(employee, "工作台");
    await btn(employee, "新建工作").click();
    await employee.getByLabel("任务", { exact: true }).fill("连接恢复后继续的原要求 " + nonce);
    await btn(employee, "个人连接").click();
    const modelPanel = employee
      .getByRole("heading", { name: "大模型 API", exact: true })
      .locator("../..");
    await modelPanel.getByLabel("API Base URL").fill(modelFixture.baseUrl);
    await modelPanel.getByLabel("模型 ID").fill(modelFixture.model);
    await modelPanel.getByLabel("模型 API Key").fill("invalid-contract-key");
    await modelPanel.getByRole("button", { name: "保存连接" }).click();
    await modelPanel.getByText("已保存，请测试连接").waitFor();
    await modelPanel.getByRole("button", { name: "测试连接" }).click();
    await modelPanel.getByText("HTTP 401", { exact: false }).waitFor();
    const checked = await api("GET", "/api/settings/integrations", employeeToken);
    assert.equal(checked.json.connections[0].verified, false);
    assert.equal(checked.json.connections[0].testCode, "AUTH_REJECTED");
    await screenshot(employee, "06-model-error-1366");
    await modelPanel.getByLabel("模型 API Key").fill(modelFixture.key);
    await modelPanel.getByRole("button", { name: "保存连接" }).click();
    await modelPanel.getByText("已保存，请测试连接").waitFor();
    assert.equal(await modelPanel.getByLabel("模型 API Key").inputValue(), "");
    await modelPanel.getByRole("button", { name: "测试连接" }).click();
    await modelPanel.getByText("已验证", { exact: true }).waitFor();
    await modelPanel.getByRole("button", { name: "断开" }).click();
    await modelPanel.getByText("未配置", { exact: true }).waitFor();
    await btn(employee, "返回当前工作").click();
    assert.equal(
      await employee.getByLabel("任务", { exact: true }).inputValue(),
      "连接恢复后继续的原要求 " + nonce,
    );
    await mark(
      "PC-13",
      "Browser checks actual 401 display, credential replacement, verification with a wire fixture and disconnect; API adds 403/429/503/timeout",
    );

    await tab(admin, "能力中心");
    await wait(admin, "kdocs.read");
    await wait(admin, "ima.search");
    await wait(admin, "web.fetch");
    const createCapability = async (kind, name) => {
      await btn(admin, "注册能力版本").click();
      const dialog = admin.getByRole("dialog", { name: "注册能力版本" });
      await dialog.getByLabel("能力类型").selectOption(kind);
      await dialog.getByLabel("注册名称").fill(name);
      await dialog.getByLabel("用途说明").fill("通过项目目录授权的验收能力");
      await dialog.getByLabel("使用范围").selectOption(projectId);
      if (kind === "SKILL")
        await dialog.getByLabel("Skill 指令").fill("优先列出真实文档来源和批准者。");
      else
        await dialog
          .getByLabel("知识文件", { exact: true })
          .selectOption(fileResults.json.files.find((file) => file.name === "brief.md").id);
      await dialog.getByRole("button", { name: "保存能力版本" }).click();
      await dialog.waitFor({ state: "hidden" });
      await wait(admin, name);
    };
    const skill = "pc-skill-" + nonce,
      knowledge = "pc-knowledge-" + nonce;
    await createCapability("SKILL", skill);
    await createCapability("KNOWLEDGE", knowledge);
    const registered = await db.capabilityDefinition.findMany({ where: { projectId } });
    assert.deepEqual(registered.map((r) => r.name).sort(), [skill, knowledge].sort());
    const unauthorizedCatalog = await api("GET", "/api/capabilities", unassigned);
    assert.ok(!unauthorizedCatalog.json.capabilities.some((row) => row.name === skill));
    await screenshot(admin, "07-capabilities-1920");
    await mark("PC-12", {
      catalog: ["Kdocs MCP", "IMA", "TinyFish", skill, knowledge],
      browser: "project-scoped registry and role boundaries",
      liveVendors: "BLOCKED: no authorized credentials",
    });

    await tab(admin, "Agent 目录");
    await admin.getByRole("button", { name: new RegExp(agentName) }).click();
    await btn(admin, "编辑与测试").click();
    await admin.getByLabel("测试项目").selectOption(projectId);
    await admin.getByLabel("测试任务").fill("PC 草稿运行验收 " + nonce);
    await admin.getByRole("checkbox", { name: /同意本次使用/ }).check();
    await btn(admin, "运行草稿测试").click();
    await wait(admin, "正在等待独立审批");
    const draft = await latestTask(token, "PC 草稿运行验收 " + nonce);
    await approveTask(draft);
    await admin.getByText("已结束", { exact: true }).waitFor({ timeout: 45000 });
    const draftRun = await finish(draft, token);
    assert.equal(draftRun.modelId, "poros-stub");
    assert.equal(draftRun.status, "UNVERIFIED");
    assert.equal((await db.task.findUnique({ where: { id: draft } })).agentVersionId, null);
    await mark("PC-06", { draft, runId: draftRun.id, model: "poros-stub", outcome: "UNVERIFIED" });

    // Cancelled metadata fixtures exercise history pagination without pretending to run 20 models.
    await db.task.createMany({
      data: Array.from({ length: 20 }, (_, index) => ({
        organizationId: "org-a",
        projectId,
        agentVersionId: originalTask.agentVersionId,
        conversationId: originalTask.conversationId,
        turn: index + 3,
        intent: "FOLLOW_UP",
        title: "Cancelled pagination fixture",
        prompt: "Cancelled pagination fixture " + index,
        status: "CANCELLED",
        createdBy: "employee@a.test",
        executionSnapshot: originalTask.executionSnapshot,
      })),
    });
    await employee.goto(base + "#/work/" + originalTask.conversationId + "?task=" + firstId);
    await employee.getByRole("heading", { name: "已定位到第 1 条请求" }).waitFor();
    await employee.getByText(firstRun.id, { exact: false }).first().waitFor();
    assert.equal(await employee.getByLabel("任务详情").count(), 1);
    await mark(
      "IX-04",
      "A stable request link opens the original real result beyond the latest 20 turns; one active result/SSE view",
    );

    await restart();
    await employee.reload();
    await employee.getByRole("heading", { name: "Poros 工作台" }).waitFor();
    await employee.getByRole("button", { name: new RegExp(firstPrompt) }).click();
    await employee.getByText(files[0][2], { exact: false }).first().waitFor();
    assert.equal((await finish(firstId, employeeToken)).id, firstRun.id);
    await btn(employee, "新建工作").click();
    const draftInput = employee.getByLabel("任务", { exact: true });
    await draftInput.fill("浏览任务时保留这段文字");
    await employee.getByRole("button", { name: new RegExp(firstPrompt) }).click();
    await btn(employee, "新建工作").click();
    assert.equal(await draftInput.inputValue(), "浏览任务时保留这段文字");
    await mark("PC-14", {
      taskId: firstId,
      runId: firstRun.id,
      serviceRestart: true,
      browserReload: true,
    });

    await tab(admin, "项目空间");
    await admin.getByRole("button", { name: new RegExp(projectName) }).click();
    await btn(admin, "项目成员").click();
    await btn(admin, "移除项目成员 employee@a.test").click();
    await btn(admin, "确认").click();
    await wait(admin, "项目权限已移除");
    assert.equal((await api("GET", `/api/tasks/${firstId}`, employeeToken)).status, 403);
    assert.equal((await api("GET", `/api/tasks/${firstId}`, crossOrg)).status, 404);
    await btn(admin, "操作审计").click();
    await wait(admin, "移除项目成员");
    await btn(admin, "归档项目").click();
    await btn(admin, "确认").click();
    await wait(admin, "已归档 · 只读");
    assert.ok((await db.project.findUnique({ where: { id: projectId } })).archivedAt);
    assert.equal((await api("GET", `/api/tasks/${firstId}`, token)).status, 200);
    await mark("PC-15", {
      denied: ["cross-org 404", "same-org unassigned 403", "post-revocation 403"],
      archivePreservedData: true,
    });
    assert.deepEqual(errors, []);
  } catch (error) {
    for (const [index, page] of pages.entries())
      await page
        .screenshot({ path: path.join(evidence, `failure-${index}.png`), fullPage: true })
        .catch(() => {});
    throw error;
  } finally {
    await Promise.all(pages.map((p) => p.close()));
  }
}
