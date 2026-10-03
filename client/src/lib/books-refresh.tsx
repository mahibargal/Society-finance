import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";

type BooksRefreshContextValue = {
  version: number;
  bumpBooks: () => void;
};

const BooksRefreshContext = createContext<BooksRefreshContextValue>({
  version: 0,
  bumpBooks: () => {},
});

export function BooksRefreshProvider({ children }: { children: ReactNode }) {
  const [version, setVersion] = useState(0);
  const bumpBooks = useCallback(() => setVersion((current) => current + 1), []);
  const value = useMemo(() => ({ version, bumpBooks }), [version, bumpBooks]);
  return <BooksRefreshContext.Provider value={value}>{children}</BooksRefreshContext.Provider>;
}

export function useBooksVersion() {
  return useContext(BooksRefreshContext).version;
}

export function useBumpBooks() {
  return useContext(BooksRefreshContext).bumpBooks;
}
