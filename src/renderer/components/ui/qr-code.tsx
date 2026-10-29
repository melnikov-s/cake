import { useEffect, useState } from "react";
import QRCode from "qrcode";

/** Encode locally: URLs are never sent to an external QR service. */
export function QrCode({ value, label }: { value: string; label: string }) {
  const [image, setImage] = useState<{ value: string; src: string }>();
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let cancelled = false;
    setFailed(false);
    void QRCode.toString(value, {
      type: "svg",
      width: 224,
      margin: 4,
      errorCorrectionLevel: "M",
    }).then(
      (svg) => {
        const src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        if (!cancelled) setImage({ value, src });
      },
      () => {
        if (!cancelled) setFailed(true);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [value]);
  if (failed) return <span role="status">QR code unavailable. Open the URL instead.</span>;
  if (image?.value !== value) return null;
  return (
    <img src={image.src} alt={label} width={224} height={224} className="size-56 rounded-md" />
  );
}
