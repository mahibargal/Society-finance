import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/** Route changes keep window scroll position; reset so the next screen starts at the top. */
export function ScrollToTop() {
  const { pathname, search, hash } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
  }, [pathname, search, hash]);
  return null;
}
