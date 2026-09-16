import {
  classifyAnswerSource,
  councilSynthesisMissingError,
  isCouncilSynthesis,
  logCouncilCompletion,
  preferCouncilSynthesis,
  promptRequestsCouncil,
  utf8ByteLength,
} from "./councilCompletion";

export type ConnectorJobSnapshot =
  | { status: "working"; createdAt: number; updatedAt: number }
  | { status: "done"; text: string; createdAt: number; updatedAt: number }
  | { status: "error"; error: string; createdAt: number; updatedAt: number };

type StoredConnectorJob = ConnectorJobSnapshot & { prompt: string };

const JOB_TTL_MS = 24 * 60 * 60 * 1000;

export class ConnectorJobManager {
  private readonly jobs = new Map<string, StoredConnectorJob>();

  constructor(private readonly run: (prompt: string) => Promise<string>) {}

  startOrGet(id: string, prompt: string): ConnectorJobSnapshot {
    this.prune();
    const existing = this.jobs.get(id);
    if (existing) return this.publicSnapshot(existing);

    const now = Date.now();
    this.jobs.set(id, {
      status: "working",
      prompt,
      createdAt: now,
      updatedAt: now,
    });

    void this.run(prompt)
      .then((text) => {
        const current = this.jobs.get(id);
        if (!current || current.status !== "working") return;
        if (!text.trim()) throw new Error("empty response from Mike backend");
        const finalized = preferCouncilSynthesis(text);
        const source = classifyAnswerSource(finalized);
        logCouncilCompletion({
          site: "ConnectorJobManager.done",
          source,
          answer_bytes: utf8ByteLength(finalized),
          answer_snapshot: finalized,
          job_id: id,
        });
        if (promptRequestsCouncil(prompt) && !isCouncilSynthesis(finalized)) {
          throw councilSynthesisMissingError();
        }
        this.jobs.set(id, {
          status: "done",
          text: finalized,
          prompt: "",
          createdAt: current.createdAt,
          updatedAt: Date.now(),
        });
      })
      .catch((error) => {
        const current = this.jobs.get(id);
        if (!current || current.status !== "working") return;
        const message = error instanceof Error ? error.message : String(error);
        logCouncilCompletion({
          site: "ConnectorJobManager.error",
          source: "unknown",
          answer_bytes: 0,
          answer_snapshot: "",
          job_id: id,
          error: message,
        });
        this.jobs.set(id, {
          status: "error",
          error: message,
          prompt: "",
          createdAt: current.createdAt,
          updatedAt: Date.now(),
        });
      });

    return this.publicSnapshot(this.jobs.get(id)!);
  }

  private publicSnapshot(job: StoredConnectorJob): ConnectorJobSnapshot {
    if (job.status === "done") {
      return {
        status: "done",
        text: job.text,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    }
    if (job.status === "error") {
      return {
        status: "error",
        error: job.error,
        createdAt: job.createdAt,
        updatedAt: job.updatedAt,
      };
    }
    return {
      status: "working",
      createdAt: job.createdAt,
      updatedAt: job.updatedAt,
    };
  }

  private prune(): void {
    const cutoff = Date.now() - JOB_TTL_MS;
    for (const [id, job] of this.jobs) {
      if (job.status !== "working" && job.updatedAt < cutoff) {
        this.jobs.delete(id);
      }
    }
  }
}

export async function readMikeSseText(
  response: Response,
  prompt = "",
): Promise<string> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Mike /chat ${response.status}: ${body.slice(0, 300) || response.statusText}`,
    );
  }
  if (!response.body) throw new Error("Mike backend response had no body");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let text = "";
  let streamError = "";
  let sawDone = false;

  const consume = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) return;
    const data = trimmed.slice(5).trim();
    if (!data) return;
    if (data === "[DONE]") {
      sawDone = true;
      return;
    }
    try {
      const event = JSON.parse(data) as {
        type?: unknown;
        text?: unknown;
        message?: unknown;
      };
      if (typeof event.text === "string") text += event.text;
      if (event.type === "error" && typeof event.message === "string") {
        streamError = event.message;
      }
    } catch {
      // A malformed event is ignored; the surrounding SSE stream remains valid.
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) consume(line);
  }
  buffer += decoder.decode();
  if (buffer) consume(buffer);

  const finalized = preferCouncilSynthesis(text);
  const source = classifyAnswerSource(finalized);
  logCouncilCompletion({
    site: "readMikeSseText",
    source,
    answer_bytes: utf8ByteLength(finalized),
    answer_snapshot: finalized,
    saw_done: sawDone,
    stream_error: streamError || null,
  });

  // Abort/error events must not mark a preamble as done. If the judge
  // synthesis already landed, keep it even if the writer then aborted.
  if (streamError && !isCouncilSynthesis(finalized)) {
    throw new Error(streamError);
  }

  if (promptRequestsCouncil(prompt) && !isCouncilSynthesis(finalized)) {
    throw councilSynthesisMissingError();
  }
  if (!sawDone && !isCouncilSynthesis(finalized)) {
    throw new Error(
      "SSE stream ended without DONE (possible upstream timeout)",
    );
  }
  return finalized;
}
