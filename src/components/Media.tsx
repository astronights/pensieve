"use client";

import { useState } from "react";
import type { MediaItem } from "@/db/schema";

/** Renders one external media URL; on load failure shows a small note instead. */
export function Media({ item }: { item: MediaItem }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <p className="media-missing">media unavailable</p>;
  const onError = () => setFailed(true);
  switch (item.type) {
    case "image":
      // External, arbitrary hosts: a plain <img> avoids configuring next/image remotePatterns.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={item.url} alt="" loading="lazy" onError={onError} />;
    case "video":
      return <video src={item.url} controls playsInline preload="metadata" onError={onError} />;
    case "audio":
      return <audio src={item.url} controls preload="metadata" onError={onError} />;
    default:
      return <p className="media-missing">media unavailable</p>;
  }
}

export function MediaList({ media, side }: { media: MediaItem[]; side: "front" | "back" }) {
  return media
    .filter((m) => m.side === side)
    .map((m, i) => <Media key={`${side}-${i}-${m.url}`} item={m} />);
}
