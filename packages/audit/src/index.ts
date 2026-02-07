import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { AuditEvent } from "@delegate/domain";
import type { AuditPort } from "@delegate/ports";

export class JsonlAuditPort implements AuditPort {
  constructor(private readonly logPath: string) {}

  async init(): Promise<void> {
    await mkdir(dirname(this.logPath), { recursive: true });
    await appendFile(this.logPath, "", "utf8");
  }

  async ping(): Promise<void> {
    await appendFile(this.logPath, "", "utf8");
  }

  async append(event: AuditEvent): Promise<void> {
    const line = JSON.stringify(event);
    await appendFile(this.logPath, `${line}\n`, "utf8");
  }
}
