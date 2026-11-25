const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, session } = require("electron");
const fs = require("node:fs"),
  path = require("node:path"),
  { pathToFileURL } = require("node:url");
const meta = JSON.parse(fs.readFileSync(path.join(__dirname, "app-meta.json"), "utf8"));
if (!/^poros\.[a-f0-9]{24}$/.test(meta.appId)) throw new Error("Invalid installation identity");
const headless = process.argv.includes("--poros-headless"),
  dataIndex = process.argv.indexOf("--data");
const dataRoot =
  dataIndex >= 0
    ? path.resolve(process.argv[dataIndex + 1])
    : path.join(process.env.LOCALAPPDATA || app.getPath("appData"), "PorosApps", meta.appId);
fs.mkdirSync(path.join(dataRoot, "browser"), { recursive: true, mode: 0o700 });
app.setName(meta.productName);
app.setPath("userData", path.join(dataRoot, "browser"));
app.setAppUserModelId(meta.appId);
let window,
  tray,
  runtime,
  freeEngine,
  quitting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    if (window && !headless) {
      window.show();
      window.focus();
    }
  });
  app
    .whenReady()
    .then(async () => {
      const resources = app.isPackaged
        ? process.resourcesPath
        : path.resolve(__dirname, "resources");
      const framework = await import(
        pathToFileURL(path.join(resources, "runtime", "runtime.mjs")).href
      );
      const packageFile = path.join(resources, "payload", "agent.poros.json"),
        pkg = framework.verifyPackage(JSON.parse(fs.readFileSync(packageFile, "utf8")));
      if (pkg.payload.appId !== meta.appId || pkg.fingerprint !== meta.publisher)
        throw new Error("软件身份或发布者不匹配");
      const image = {
        imageId: meta.runtimeImage.id,
        archive: path.join(resources, "runtime-component.tar"),
        sha256: meta.runtimeImage.sha256,
      };
      const prepareFree = async () => {
        freeEngine = await framework.prepareFreeEngine({
          directory:
            process.env.POROS_FREE_RUNTIME_DIRECTORY ||
            path.join(
              process.env.LOCALAPPDATA || app.getPath("appData"),
              "PorosRuntime",
              "engine-v1",
            ),
        });
        process.env.POROS_DOCKER_SOCKET = freeEngine.socket;
        await framework.ensureRuntimeImage(image);
      };
      if (process.argv.includes("--poros-free-runtime")) await prepareFree();
      else {
        try {
          await framework.ensureRuntimeImage(image);
        } catch (error) {
          if (headless) throw error;
          const answer = await dialog.showMessageBox({
            type: "info",
            title: "准备运行环境",
            message: "此软件需要隔离运行环境",
            detail:
              "可以安装免费的 Alpine Linux + Linux Engine，所有 Agent 软件共享使用。首次需要下载组件并启用 Windows WSL2；不会修改已有 Linux 发行版。已有环境未通过检查：" +
              (error instanceof Error ? error.message : ""),
            buttons: ["准备免费环境", "取消"],
            defaultId: 0,
            cancelId: 1,
          });
          if (answer.response !== 0) {
            app.quit();
            return;
          }
          await prepareFree();
        }
      }
      process.env.POROS_DSH_IMAGE = meta.runtimeImage.id;
      runtime = await framework.launchApp({
        packageFile,
        directory: path.join(dataRoot, "data"),
        publicDirectory: path.join(resources, "runtime", "public"),
      });
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      window = new BrowserWindow({
        title: meta.productName,
        width: 1120,
        height: 800,
        minWidth: 360,
        minHeight: 480,
        show: false,
        autoHideMenuBar: true,
        backgroundColor: "#f6f5f1",
        icon: path.join(resources, "poros-icon.png"),
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webSecurity: true,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event, url) => {
        try {
          if (new URL(url).origin !== new URL(runtime.address).origin) event.preventDefault();
        } catch {
          event.preventDefault();
        }
      });
      window.on("close", (event) => {
        if (tray && !quitting) {
          event.preventDefault();
          window.hide();
        }
      });
      window.once("ready-to-show", () => {
        if (!headless) window.show();
      });
      if (!headless) {
        tray = new Tray(
          nativeImage
            .createFromPath(path.join(resources, "poros-icon.png"))
            .resize({ width: 16, height: 16 }),
        );
        tray.setToolTip(meta.productName);
        tray.setContextMenu(
          Menu.buildFromTemplate([
            {
              label: "打开 " + meta.productName,
              click: () => {
                window.show();
                window.focus();
              },
            },
            { type: "separator" },
            { label: "退出软件", click: () => app.quit() },
          ]),
        );
        tray.on("double-click", () => {
          window.show();
          window.focus();
        });
      }
      await window.loadURL(runtime.ownerUrl);
    })
    .catch((error) => {
      if (!headless)
        dialog.showErrorBox(
          "软件启动失败",
          error instanceof Error ? error.message : "运行环境不可用",
        );
      else console.error(error instanceof Error ? error.message : "Desktop startup failed");
      app.exit(1);
    });
  app.on("window-all-closed", () => {
    if (!tray) app.quit();
  });
  app.on("before-quit", (event) => {
    if (!quitting && runtime) {
      event.preventDefault();
      quitting = true;
      void runtime.app.close().finally(async () => {
        await freeEngine?.close();
        tray?.destroy();
        app.quit();
      });
    }
  });
}
