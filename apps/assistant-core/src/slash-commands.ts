export const RESTART_COMMAND = "/restart";

export const isRestartIntent = (text: string): boolean => {
  const trimmed = text.trim();
  return (
    /^\/restart$/i.test(trimmed) ||
    /^(restart assistant|restart)$/i.test(trimmed)
  );
};

export const expandSlashCommand = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.toLowerCase() === RESTART_COMMAND) {
    return "restart assistant";
  }
  return text;
};

export const isSlashCommand = (text: string): boolean =>
  text.trim().startsWith("/");
