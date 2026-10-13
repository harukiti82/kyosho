import "./style.css";
import { registerServiceWorker } from "./pwa";
import { App } from "./ui/app";

new App();
if (import.meta.env.PROD) registerServiceWorker();
