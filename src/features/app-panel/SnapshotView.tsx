import { useEffect, useRef } from "react";
import type { SnapshotImage } from "./snapshotImage";

/**
 * Still image of the hosted window, drawn while a dialog needs its area. The canvas is released
 * (size zero, pixels dropped) as soon as the view goes away, so nothing is kept between dialogs.
 */
export function SnapshotView({ image }: { image: SnapshotImage }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d");
    if (context) {
      const data = context.createImageData(image.width, image.height);
      data.data.set(image.rgba);
      context.putImageData(data, 0, 0);
    }
    return () => {
      canvas.width = 0;
      canvas.height = 0;
    };
  }, [image]);

  return (
    <div className="app-panel-snapshot" data-app-snapshot>
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}
