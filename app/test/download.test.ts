import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadBlob, safeFilename } from "../src/lib/download";
import { stubDownload } from "./utils";

describe("safeFilename", () => {
  it("keeps an ordinary name", () => {
    expect(safeFilename("Layla Haddad", "contact")).toBe("Layla Haddad");
  });

  it("strips characters a filesystem rejects", () => {
    expect(safeFilename('A/B:"C"', "x")).toBe("ABC");
    expect(safeFilename("a\u0001b\\c|d", "x")).toBe("abcd");
  });

  it("trims, and falls back when nothing is left", () => {
    expect(safeFilename("  Mass  ", "x")).toBe("Mass");
    expect(safeFilename('/:*?"', "event")).toBe("event");
    expect(safeFilename("   ", "event")).toBe("event");
  });
});

describe("downloadBlob", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("clicks a named link at the blob, then lets the object URL go", () => {
    const { create, revoke, clicked } = stubDownload();
    const blob = new Blob(["hi"], { type: "text/plain" });
    downloadBlob(blob, "hi.txt");

    expect(create).toHaveBeenCalledWith(blob);
    expect(clicked()?.download).toBe("hi.txt");
    expect(clicked()?.href).toBe("blob:download");
    expect(revoke).toHaveBeenCalledWith("blob:download");
    // The link does not outlive the click.
    expect(document.querySelector("a[download]")).toBeNull();
  });
});
