import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";

// Dev-only fixture: open with #diff-view-mock to inspect DiffView in isolation.
if (import.meta.env.DEV && window.location.hash === "#diff-view-mock") {
  void import("./dev/DiffMock").then(({ DiffMock }) => {
    ReactDOM.createRoot(document.getElementById("root")!).render(
      <React.StrictMode>
        <div className="app-shell" data-theme="obsidian" style={{ height: "100vh" }}>
          <DiffMock />
        </div>
      </React.StrictMode>,
    );
  });
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>,
  );
}
