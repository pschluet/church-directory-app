import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MAX_PHOTO_BYTES } from "@shared";
import { usePhotoPicker } from "../src/components/usePhotoPicker";

const uploadPhoto = vi.fn();
vi.mock("../src/lib/api", () => ({
  api: vi.fn(),
  DEV_AUTH: false,
  uploadPhoto: (...args: unknown[]) => uploadPhoto(...args),
}));

// The cropper decodes with createImageBitmap and draws to a canvas, neither of
// which jsdom has. Stubbed to a marker so these tests can assert that choosing
// a file opens the cropper rather than uploading -- the crop arithmetic itself
// is covered in images.test.ts.
vi.mock("../src/components/PhotoCropper", () => ({
  PhotoCropper: ({ owner, onCancel }: { owner: string; onCancel: () => void }) => (
    <div role="dialog" aria-label={`cropper:${owner}`}>
      <button type="button" onClick={onCancel}>
        cancel crop
      </button>
    </div>
  ),
}));

/**
 * The hook is headless, so a test needs something to render its `elements` and
 * an error to read. Both pages that use it do the same, with a menu item in
 * place of the button.
 */
function Harness({ owner }: { owner: { personId: string } | { familyId: string } }) {
  const picker = usePhotoPicker({ owner, onUploaded: vi.fn() });
  return (
    <>
      {picker.elements}
      <button type="button" onClick={picker.open}>
        Add a photo
      </button>
      {picker.error && <p role="alert">{picker.error}</p>}
    </>
  );
}

/** The input is sr-only and label-less by design; `open()` drives it. */
function fileInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>("input[type=file]");
  if (!input) throw new Error("no file input rendered");
  return input;
}

function pick(name = "face.jpg", type = "image/jpeg", size = 1024): File {
  const file = new File(["x"], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("usePhotoPicker", () => {
  it("opens the cropper instead of uploading the file as picked", async () => {
    render(<Harness owner={{ personId: "p1" }} />);

    await userEvent.upload(fileInput(), pick());

    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    expect(uploadPhoto).not.toHaveBeenCalled();
  });

  it("locks a person to a square crop and leaves a family free-form", async () => {
    const { unmount } = render(<Harness owner={{ personId: "p1" }} />);
    await userEvent.upload(fileInput(), pick());
    expect(await screen.findByLabelText("cropper:person")).toBeInTheDocument();
    unmount();

    render(<Harness owner={{ familyId: "f1" }} />);
    await userEvent.upload(fileInput(), pick());
    expect(await screen.findByLabelText("cropper:family")).toBeInTheDocument();
  });

  it("hides the input from the tab order, since a menu item is the way in", () => {
    render(<Harness owner={{ personId: "p1" }} />);

    const input = fileInput();
    expect(input).toHaveAttribute("aria-hidden", "true");
    expect(input).toHaveAttribute("tabindex", "-1");
  });

  it("rejects a file type the cropper cannot decode", () => {
    render(<Harness owner={{ personId: "p1" }} />);

    // fireEvent rather than userEvent.upload: the latter honours the input's
    // `accept` attribute and would simply drop the file, so the hook's own
    // check -- the one that matters, since `accept` is only a hint -- would
    // never run.
    fireEvent.change(fileInput(), { target: { files: [pick("scan.gif", "image/gif")] } });

    expect(screen.getByRole("alert")).toHaveTextContent(/JPEG, PNG or WebP/i);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("accepts a photo well past the old 5MB limit", async () => {
    // The reported bug. Nothing about the upload cares how big the original is
    // any more -- it is cropped and downscaled locally and never leaves the
    // browser -- so the only ceiling is what the decode can hold.
    render(<Harness owner={{ personId: "p1" }} />);

    await userEvent.upload(fileInput(), pick("big.jpg", "image/jpeg", 12 * 1024 * 1024));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("still rejects an oversized original, which has to be decoded to be cropped", async () => {
    render(<Harness owner={{ personId: "p1" }} />);

    await userEvent.upload(fileInput(), pick("huge.jpg", "image/jpeg", MAX_PHOTO_BYTES + 1));

    expect(screen.getByRole("alert")).toHaveTextContent(/too large/i);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
