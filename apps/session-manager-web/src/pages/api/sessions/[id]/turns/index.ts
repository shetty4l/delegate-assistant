import { decodeSessionKeyId } from "@delegate/adapters-session-store-sqlite";
import type { APIRoute } from "astro";
import { getSessionStore } from "../../../../../lib/store";

export const GET: APIRoute = async ({ params }) => {
  const id = params.id ?? "";
  const store = await getSessionStore();
  const sessionKey = decodeSessionKeyId(id);
  if (!sessionKey) {
    return Response.json(
      { ok: false, error: "invalid_session_id" },
      { status: 400 },
    );
  }

  const turns = await store.listTurns(sessionKey);
  return Response.json({ ok: true, turns });
};
