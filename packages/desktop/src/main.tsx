import React from "react";
import { createRoot } from "react-dom/client";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@phosphor-icons/web/regular";
import "@phosphor-icons/web/fill";
import "./nocturne.css";
import "./app.css";
import App from "./App";
import { installMock } from "./mock";

// Outside Electron (plain browser against the Vite dev server) there is no
// preload bridge — install a fixture-backed window.spawn so the UI can be
// eyeballed and screenshotted without a daemon.
if (!window.spawn) installMock();

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
