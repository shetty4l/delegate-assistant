import type { APIRoute } from "astro";
import { filtersFromUrl } from "../../../lib/sessions";
import { getSessionStore } from "../../../lib/store";

export const GET: APIRoute = async ({ url }) => {
  const store = await getSessionStore();
  const page = await store.listSessions(filtersFromUrl(url));
  return Response.json({ ok: true, ...page });
};
