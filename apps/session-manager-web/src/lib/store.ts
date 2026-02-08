import { SqliteSessionStore } from "@delegate/adapters-session-store-sqlite";
import { resolveSessionDbPath } from "./config";

let storePromise: Promise<SqliteSessionStore> | null = null;

export const getSessionStore = (): Promise<SqliteSessionStore> => {
  if (!storePromise) {
    storePromise = (async () => {
      const store = new SqliteSessionStore(resolveSessionDbPath());
      await store.init();
      return store;
    })();
  }

  return storePromise;
};
