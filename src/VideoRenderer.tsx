/// Plays a video from raw bytes via a `blob:` object URL and a `<video>` element.
/// The CSP allows `media-src 'self' blob:` (see tauri.conf.json) — that's the one place
/// blob media is permitted. The blob is built from the app's own file read, so nothing
/// external loads. Large files hit the 50MB preview cap upstream before we get here.
import { useEffect, useState } from "react";

const MIME_BY_EXT: Record<string, string> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  ogv: "video/ogg",
};

function extensionOf(path: string): string {
  const withoutSuffix = path.split(/[?#]/, 1)[0];
  return withoutSuffix.slice(withoutSuffix.lastIndexOf(".") + 1).toLowerCase();
}

export function VideoRenderer({ data, path }: { data: Uint8Array; path: string }): React.ReactElement {
  const [url, setUrl] = useState<string | null>(null);
  const mime = MIME_BY_EXT[extensionOf(path)] ?? "video/mp4";

  useEffect(() => {
    if (data.length === 0) {
      setUrl(null);
      return;
    }
    const objectUrl = URL.createObjectURL(new Blob([data], { type: mime }));
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [data, mime]);

  if (data.length === 0) {
    return <div className="docv-error">This video file is empty.</div>;
  }
  if (!url) {
    return <div className="docv-loading">Loading video…</div>;
  }
  return (
    <div className="docv-video">
      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
      <video className="docv-video-el" src={url} controls autoPlay playsInline />
    </div>
  );
}
