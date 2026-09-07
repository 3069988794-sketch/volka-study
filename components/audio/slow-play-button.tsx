"use client";

/**
 * 0.7× playback with pitch preserved (`preservesPitch`), so slow listening
 * stays intelligible instead of sounding drunk. Thin wrapper over PlayButton —
 * `<PlayButton slow />` is equivalent.
 */

import { PlayButton } from "./play-button";
import type { PlayButtonProps } from "./play-button";

export type SlowPlayButtonProps = Omit<PlayButtonProps, "slow" | "rate">;

export function SlowPlayButton(props: SlowPlayButtonProps) {
  return <PlayButton {...props} slow />;
}

export default SlowPlayButton;
