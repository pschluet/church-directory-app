import { useRef, useState } from "react";
import type { ReactNode } from "react";
import {
  GROUP_DOCUMENT_CONTENT_TYPES,
  GROUP_POST_MAX_ATTACHMENTS,
  MAX_PHOTO_BYTES,
  PHOTO_CONTENT_TYPES,
  type GroupPostAttachment,
} from "@shared";
import { uploadGroupFileAttachment, uploadGroupImageAttachment } from "../lib/api";
import { loadWorkingImage, renderRenditions } from "../lib/images";

/**
 * Picking, and uploading, a group post's attachments -- pictures and
 * documents together, up to `GROUP_POST_MAX_ATTACHMENTS`.
 *
 * Not `useAttachmentPicker`: that hook is image-only, matching the prayer
 * request pipeline it was built for. A group post also accepts PDFs, Office
 * documents, plain text and CSV (see requirements/groups.md), and those are
 * never decoded to a canvas at all -- see `uploadGroupFileAttachment` and the
 * `group-post` passthrough in api/src/photos.ts. An image still gets the same
 * crop-free downscale `useAttachmentPicker` does, reusing the "attachment"
 * rendition sizes.
 */

export interface GroupAttachmentPicker {
  open: () => void;
  elements: ReactNode;
  attachments: GroupPostAttachment[];
  remove: (photoKey: string) => void;
  reset: () => void;
  busy: boolean;
  error: string | null;
  full: boolean;
}

const ACCEPT = [...PHOTO_CONTENT_TYPES, ...GROUP_DOCUMENT_CONTENT_TYPES].join(",");

export function useGroupAttachmentPicker(): GroupAttachmentPicker {
  const inputRef = useRef<HTMLInputElement>(null);
  const [attachments, setAttachments] = useState<GroupPostAttachment[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const full = attachments.length >= GROUP_POST_MAX_ATTACHMENTS;

  async function handleFiles(files: File[]): Promise<void> {
    setError(null);
    setBusy(true);

    let accepted = attachments.length;
    const problems: string[] = [];

    try {
      for (const file of files) {
        if (accepted >= GROUP_POST_MAX_ATTACHMENTS) {
          problems.push(`Only ${GROUP_POST_MAX_ATTACHMENTS} attachments can be added.`);
          break;
        }
        if (file.size > MAX_PHOTO_BYTES) {
          problems.push(`${file.name} is larger than ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`);
          continue;
        }

        const isImage = (PHOTO_CONTENT_TYPES as readonly string[]).includes(file.type);
        const isDocument = (GROUP_DOCUMENT_CONTENT_TYPES as readonly string[]).includes(file.type);
        if (!isImage && !isDocument) {
          problems.push(`${file.name} is not a supported picture or document type.`);
          continue;
        }

        try {
          if (isImage) {
            const working = await loadWorkingImage(file);
            const renditions = await renderRenditions(
              working,
              { main: { x: 0, y: 0, width: working.width, height: working.height } },
              "attachment"
            );
            const { photoKey, width, height } = await uploadGroupImageAttachment(
              file.name,
              renditions
            );
            accepted += 1;
            setAttachments((previous) => [
              ...previous,
              {
                photoKey,
                kind: "IMAGE",
                filename: file.name,
                contentType: renditions.contentType,
                byteSize: renditions.blobs.full.size,
                width,
                height,
              },
            ]);
          } else {
            const photoKey = await uploadGroupFileAttachment(file);
            accepted += 1;
            setAttachments((previous) => [
              ...previous,
              {
                photoKey,
                kind: "FILE",
                filename: file.name,
                contentType: file.type,
                byteSize: file.size,
              },
            ]);
          }
        } catch (err) {
          problems.push(err instanceof Error ? err.message : `${file.name} could not be added.`);
        }
      }
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = "";
      if (problems.length > 0) setError(problems.join(" "));
    }
  }

  const elements = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept={ACCEPT}
      className="sr-only"
      tabIndex={-1}
      aria-hidden="true"
      onChange={(event) => {
        const files = Array.from(event.target.files ?? []);
        if (files.length > 0) void handleFiles(files);
      }}
    />
  );

  return {
    open: () => inputRef.current?.click(),
    elements,
    attachments,
    remove: (photoKey) =>
      setAttachments((previous) => previous.filter((a) => a.photoKey !== photoKey)),
    reset: () => {
      setAttachments([]);
      setError(null);
    },
    busy,
    error,
    full,
  };
}
