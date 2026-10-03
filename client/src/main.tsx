import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { App } from "./App";
import { AuthProvider } from "./lib/auth";
import { BooksRefreshProvider } from "./lib/books-refresh";
import "./styles.css";

// After mobile PDF viewers, back navigation can restore a blank bfcache snapshot.
window.addEventListener("pageshow", (event) => {
  if (event.persisted) window.location.reload();
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <BooksRefreshProvider>
          <App />
        </BooksRefreshProvider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
