import React from "react";
import { createRoot } from "react-dom/client";
// Tokens and base styles first, so component styles imported below win ties.
import "./ui/theme.css";
import "./ui/primitives/primitives.css";
import { App } from "./ui/App.js";

createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
