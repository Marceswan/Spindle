import { useEffect, useRef } from "react";

/** Each new request supersedes its predecessor; unmount invalidates every response. */
export function useRequestEpoch(): () => () => boolean {
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  return () => {
    const current = ++epoch.current;
    return () => current === epoch.current;
  };
}
