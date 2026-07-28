import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { registerServiceWorker } from "./push";
import "./style.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root puuttuu index.html:stä");

// Registered at boot rather than when the operator taps "ota käyttöön": the
// worker must already be active before a push subscription can be created, and
// on iOS the registration itself is what survives the app being closed.
void registerServiceWorker();

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
