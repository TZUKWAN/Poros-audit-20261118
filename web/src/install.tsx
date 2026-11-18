import { useEffect, useState } from "react";
import { Button, Dialog, DialogClose } from "./ui.js";

interface InstallEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: string }>;
}

export function InstallApp() {
  const [install, setInstall] = useState<InstallEvent | null>(null);
  const [open, setOpen] = useState(false);
  const [standalone, setStandalone] = useState(
    () =>
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true,
  );
  useEffect(() => {
    const available = (event: Event) => {
      event.preventDefault();
      setInstall(event as InstallEvent);
    };
    const installed = () => setStandalone(true);
    window.addEventListener("beforeinstallprompt", available);
    window.addEventListener("appinstalled", installed);
    if (window.isSecureContext && "serviceWorker" in navigator)
      void navigator.serviceWorker.register("/sw.js").catch(() => {});
    return () => {
      window.removeEventListener("beforeinstallprompt", available);
      window.removeEventListener("appinstalled", installed);
    };
  }, []);
  if (standalone) return null;
  return (
    <>
      <Button
        variant="ghost"
        onClick={async () => {
          if (!install) return setOpen(true);
          try {
            await install.prompt();
            if ((await install.userChoice).outcome === "accepted") setStandalone(true);
          } catch {
            setOpen(true);
          } finally {
            setInstall(null);
          }
        }}
      >
        安装应用
      </Button>
      {open && (
        <Dialog open onOpenChange={setOpen} title="安装 Poros">
          {window.isSecureContext ? (
            <ul className="list-disc space-y-2 pl-5 text-sm">
              <li>iPhone 或 iPad：在 Safari 打开，点「分享」，再点「添加到主屏幕」。</li>
              <li>Android：用 Chrome 打开，在浏览器菜单中选择「安装应用」或「添加到主屏幕」。</li>
            </ul>
          ) : (
            <p className="text-sm">当前是浏览器访问地址。使用管理员提供的 HTTPS 入口可安装应用。</p>
          )}
          <div className="mt-4 flex justify-end">
            <DialogClose asChild>
              <Button>知道了</Button>
            </DialogClose>
          </div>
        </Dialog>
      )}
    </>
  );
}
