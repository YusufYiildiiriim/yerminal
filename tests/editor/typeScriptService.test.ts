import { describe, expect, it, vi } from "vitest";
import { createTypeScriptService } from "../../src/features/editor/typeScriptService";

describe("TypeScript language service gate", () => {
  it("never starts for languages other than TypeScript and JavaScript", () => {
    const start = vi.fn(async () => {});
    const service = createTypeScriptService(start);
    expect(service.ensureFor("python")).toBeNull();
    expect(service.ensureFor("plaintext")).toBeNull();
    expect(start).not.toHaveBeenCalled();
  });

  it("starts once on the first TypeScript or JavaScript file and shares the start", async () => {
    const start = vi.fn(async () => {});
    const service = createTypeScriptService(start);
    await service.ensureFor("typescript");
    await service.ensureFor("javascript");
    expect(start).toHaveBeenCalledTimes(1);
  });

  it("allows a retry after a failed start", async () => {
    const start = vi.fn().mockRejectedValueOnce(new Error("chunk unavailable")).mockResolvedValueOnce(undefined);
    const service = createTypeScriptService(start);
    await expect(service.ensureFor("typescript")).rejects.toThrow("chunk unavailable");
    await expect(service.ensureFor("typescript")).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledTimes(2);
  });
});
