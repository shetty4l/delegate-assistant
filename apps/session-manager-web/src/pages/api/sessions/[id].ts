import type { APIRoute } from "astro";
import { getSessionStore } from "../../../lib/store";

export const GET: APIRoute = async ({ params }) => {
  const id = params.id ?? "";
  const store = await getSessionStore();
  const session = await store.getSessionById(id);
  if (!session) {
    return Response.json(
      {
        ok: false,
        error: "session_not_found",
      },
      { status: 404 },
    );
  }

  return Response.json({ ok: true, session });
};
