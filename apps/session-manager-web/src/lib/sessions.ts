import type {
  SessionListFilters,
  SessionListItem,
} from "@delegate/adapters-session-store-sqlite";

const asPositiveInt = (raw: string | null, fallback: number): number => {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const asOptionalText = (raw: string | null): string | undefined => {
  if (!raw) {
    return undefined;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const asStatus = (raw: string | null): "active" | "stale" | undefined => {
  if (raw === "active" || raw === "stale") {
    return raw;
  }
  return undefined;
};

export const filtersFromUrl = (url: URL): SessionListFilters => ({
  q: asOptionalText(url.searchParams.get("q")),
  status: asStatus(url.searchParams.get("status")),
  topicKey: asOptionalText(url.searchParams.get("topic")),
  workspacePath: asOptionalText(url.searchParams.get("workspace")),
  page: asPositiveInt(url.searchParams.get("page"), 1),
  pageSize: asPositiveInt(url.searchParams.get("pageSize"), 25),
});

export const formatRelativeAge = (iso: string): string => {
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) {
    return "unknown";
  }
  const deltaMs = Date.now() - ms;
  if (deltaMs < 60_000) {
    return "just now";
  }
  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};

export const sessionTitle = (item: SessionListItem): string => {
  const [chatId, threadId] = item.topicKey.split(":");
  const threadLabel = threadId && threadId !== "root" ? threadId : "root";
  return `${chatId ?? "unknown"} / ${threadLabel}`;
};
