import type { APIRoute } from "astro";
import { getSessionStore } from "../../../../../lib/store";

export const GET: APIRoute = async ({ params }) => {
  const turnId = params.turnId ?? "";
  const store = await getSessionStore();
  const events = await store.getTurnEvents(turnId);

  if (events.length === 0) {
    return Response.json(
      { ok: false, error: "turn_not_found" },
      { status: 404 },
    );
  }

  return Response.json({ ok: true, turnId, events });
};
