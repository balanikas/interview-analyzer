// Talking to the server.

import type { ErrorResponse, JobEvent, TranscribeResponse } from "../shared/types.js";

async function json<T>(r: Response): Promise<T> {
  const data = (await r.json().catch(() => ({ error: `Server error (HTTP ${r.status}).` }))) as T | ErrorResponse;
  if (!r.ok || (data && typeof data === "object" && "error" in data)) throw new Error((data as ErrorResponse).error ?? "Request failed");
  return data as T;
}

export const getJson = async <T>(url: string): Promise<T> => json<T>(await fetch(url));

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  return json<T>(await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));
}

/**
 * Follows a job's events until it ends; resolves with its result. The browser reconnects by itself when the connection
 * drops (the server restarting, say) and the server sends only what was missed.
 */
export function followJob(id: string, onLog: (message: string) => void): Promise<TranscribeResponse> {
  return new Promise((resolve, reject) => {
    const events = new EventSource(`/api/jobs/${encodeURIComponent(id)}/events`);
    events.onmessage = m => {
      const event = JSON.parse(m.data as string) as JobEvent;
      if ("log" in event) return onLog(event.log);
      events.close();
      if ("done" in event) resolve(event.done); else reject(new Error(event.error));
    };
    events.onerror = () => {
      if (events.readyState === EventSource.CLOSED) reject(new Error("Lost track of the job. Reload the page to follow it again."));
    };
  });
}
