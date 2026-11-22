/** Entry point. Owner: UI foundation engineer (integrator-seeded placeholder). */
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./styles/index.css";
import { App } from "./app/App";
// Synchronous, before the router and analytics exist: an exact /promo#<code> link is saved for this browser
// session and the fragment is stripped (contract D3). No-op on every other path; never throws.
import { capturePromoLinkAtStartup } from "./features/promotions/savedCode";

capturePromoLinkAtStartup();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
