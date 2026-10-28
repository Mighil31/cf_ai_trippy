import { useSyncExternalStore } from "react";

export type Route = { name: "home" } | { name: "trip"; tripId: string };

function parse(pathname: string): Route {
  const match = pathname.match(/^\/trips\/([\w-]+)\/?$/);
  return match ? { name: "trip", tripId: match[1] } : { name: "home" };
}

function subscribe(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}

export function useRoute(): Route {
  const pathname = useSyncExternalStore(subscribe, () => location.pathname);
  return parse(pathname);
}

export function navigate(path: string) {
  history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
