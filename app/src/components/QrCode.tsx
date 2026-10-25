import { useEffect, useState } from "react";
import { qrModules, qrSvgPath } from "../lib/qr";

/**
 * A QR code for `value`, as an inline SVG that fills whatever box it is given.
 *
 * Computed after mount because the encoder is lazily imported (see `qr.ts`). Until
 * it arrives a blank square of the same shape is rendered, so the layout does not
 * jump when the code appears. The white background is part of the image: a code
 * on a dark or tinted surface cannot be scanned without its quiet zone.
 */
export function QrCode({
  value,
  className = "",
  title = "QR code",
}: {
  value: string;
  className?: string;
  /** What a screen reader says, e.g. "QR code for Parish picnic". */
  title?: string;
}) {
  const [modules, setModules] = useState<boolean[][] | null>(null);

  useEffect(() => {
    let cancelled = false;
    setModules(null);
    qrModules(value).then(
      (result) => {
        if (!cancelled) setModules(result);
      },
      () => {}
    );
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (!modules) {
    return <div className={`aspect-square bg-white ${className}`} aria-hidden="true" />;
  }

  const { d, viewBoxSize } = qrSvgPath(modules);
  return (
    <svg
      role="img"
      aria-label={title}
      viewBox={`0 0 ${viewBoxSize} ${viewBoxSize}`}
      // Crisp edges between modules rather than anti-aliased grey seams.
      shapeRendering="crispEdges"
      className={`aspect-square bg-white ${className}`}
    >
      <rect width={viewBoxSize} height={viewBoxSize} fill="#ffffff" />
      <path d={d} fill="#000000" />
    </svg>
  );
}
