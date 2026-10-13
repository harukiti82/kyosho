import "./style.css";
import { registerServiceWorker } from "./pwa";
import { App } from "./ui/app";
import { installCrashNotice } from "./ui/crash";

// 想定外のエラーの知らせは App より先に入れる（App の作成中の例外も拾う）
installCrashNotice();
new App();
if (import.meta.env.PROD) registerServiceWorker();
