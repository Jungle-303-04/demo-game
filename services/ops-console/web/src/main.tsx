import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { GameAdminConsole } from "./GameAdminConsole.js";
import "./globals.css";

const root = document.getElementById("root");

if (!root) {
  throw new Error("missing_root_element");
}

createRoot(root).render(
  <StrictMode>
    <GameAdminConsole />
  </StrictMode>,
);
