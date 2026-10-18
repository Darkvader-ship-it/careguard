import { afterEach, describe, expect, it, vi } from "vitest";

const { mockToastError } = vi.hoisted(() => ({
  mockToastError: vi.fn(),
}));

vi.mock("sonner", () => ({ toast: { error: mockToastError } }));

import { copyText } from "../lib/clipboard";

function withGlobals({
  clipboardWrite,
  isSecureContext,
  execCommand,
}: {
  clipboardWrite?: ((text: string) => Promise<void>) | null;
  isSecureContext?: boolean;
  execCommand?: ((cmd: string) => boolean) | null;
}) {
  const created: HTMLTextAreaElement[] = [];
  const removed: HTMLTextAreaElement[] = [];

  const fakeBody: any = {
    appendChild: vi.fn((node: any) => created.push(node)),
    removeChild: vi.fn((node: any) => removed.push(node)),
  };

  const fakeDoc: any = {
    createElement: vi.fn(() => {
      const ta: any = {
        style: {} as Record<string, string>,
        value: "",
        focus: vi.fn(),
        select: vi.fn(),
        setSelectionRange: vi.fn(),
        setAttribute: vi.fn(),
        parentNode: fakeBody,
      };
      return ta;
    }),
    body: fakeBody,
    execCommand: execCommand === null ? undefined : execCommand,
  };

  vi.stubGlobal(
    "navigator",
    clipboardWrite === null
      ? {}
      : {
          clipboard: { writeText: clipboardWrite },
        },
  );
  vi.stubGlobal("document", fakeDoc);
  vi.stubGlobal("window", { isSecureContext: Boolean(isSecureContext) });

  return { fakeBody, fakeDoc, created, removed };
}

describe("copyText", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns 'ok' when clipboard.writeText succeeds in a secure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    withGlobals({ clipboardWrite: writeText, isSecureContext: true });
    const result = await copyText("hello");
    expect(result).toBe("ok");
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("falls back to execCommand when clipboard.writeText throws", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const exec = vi.fn().mockReturnValue(true);
    const { fakeBody, created } = withGlobals({
      clipboardWrite: writeText,
      isSecureContext: true,
      execCommand: exec,
    });
    const result = await copyText("hello");
    expect(result).toBe("fallback");
    expect(exec).toHaveBeenCalledWith("copy");
    expect(created).toHaveLength(1);
    expect(fakeBody.removeChild).toHaveBeenCalled();
  });

  it("falls back to execCommand in an insecure context", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const exec = vi.fn().mockReturnValue(true);
    withGlobals({
      clipboardWrite: writeText,
      isSecureContext: false,
      execCommand: exec,
    });
    const result = await copyText("hello");
    expect(result).toBe("fallback");
    expect(writeText).not.toHaveBeenCalled();
    expect(exec).toHaveBeenCalledWith("copy");
  });

  it("returns 'failed' when both paths fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const exec = vi.fn().mockReturnValue(false);
    withGlobals({
      clipboardWrite: writeText,
      isSecureContext: true,
      execCommand: exec,
    });
    const result = await copyText("hello");
    expect(result).toBe("failed");
  });

  it("returns 'failed' when no clipboard API and no execCommand", async () => {
    withGlobals({
      clipboardWrite: null,
      isSecureContext: false,
      execCommand: null,
    });
    const result = await copyText("hello");
    expect(result).toBe("failed");
  });

  it("shows toast error when both paths fail", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const exec = vi.fn().mockReturnValue(false);
    withGlobals({
      clipboardWrite: writeText,
      isSecureContext: true,
      execCommand: exec,
    });
    const result = await copyText("hello");
    expect(result).toBe("failed");
    expect(mockToastError).toHaveBeenCalled();
    expect(mockToastError.mock.calls[0][0]).toContain("Couldn't copy to clipboard");
  });

  it("shows toast error when no clipboard API and no execCommand", async () => {
    withGlobals({
      clipboardWrite: null,
      isSecureContext: false,
      execCommand: null,
    });
    const result = await copyText("hello");
    expect(result).toBe("failed");
    expect(mockToastError).toHaveBeenCalled();
    expect(mockToastError.mock.calls[0][0]).toContain("Couldn't copy to clipboard");
  });

  it("removes the textarea even when execCommand throws", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    const exec = vi.fn(() => {
      throw new Error("boom");
    });
    const { fakeBody, removed } = withGlobals({
      clipboardWrite: writeText,
      isSecureContext: true,
      execCommand: exec,
    });
    const result = await copyText("hello");
    expect(result).toBe("failed");
    expect(fakeBody.removeChild).toHaveBeenCalled();
    expect(removed).toHaveLength(1);
  });
});
