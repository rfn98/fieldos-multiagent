import { MossClient, type SearchResult } from "@moss-dev/moss";
import { PipeError } from "./types";
import { embedText } from "./embedding";

const PLACEHOLDERS = new Set(["", "...", "xxx", "your-project-id", "your-project-key"]);

const CUSTOM_INDEX_NAME = (
  process.env.MOSS_CUSTOM_INDEX_NAME ?? "fieldos-knowledge-custom"
).trim();
const PROJECT_ID = process.env.MOSS_PROJECT_ID?.trim() ?? "";
const PROJECT_KEY = process.env.MOSS_PROJECT_KEY?.trim() ?? "";

function hasCredentials(): boolean {
  return (
    Boolean(PROJECT_ID) &&
    Boolean(PROJECT_KEY) &&
    !PLACEHOLDERS.has(PROJECT_ID) &&
    !PLACEHOLDERS.has(PROJECT_KEY)
  );
}

export function mossConfigured(): boolean {
  return hasCredentials();
}

let client: MossClient | null = null;
let loadedIndex: string | null = null;
let loadPromise: Promise<string> | null = null;

function getClient(): MossClient {
  if (!hasCredentials()) {
    throw new PipeError(
      "moss_config",
      503,
      "Moss retrieval is not configured. Set MOSS_PROJECT_ID and MOSS_PROJECT_KEY to a real Moss project."
    );
  }
  client ??= new MossClient(PROJECT_ID, PROJECT_KEY);
  return client;
}

function ensureIndexLoaded(): Promise<string> {
  if (loadedIndex) return Promise.resolve(loadedIndex);

  loadPromise ??= (async () => {
    try {
      await getClient().loadIndex(CUSTOM_INDEX_NAME);
    } catch (error) {
      loadPromise = null;
      loadedIndex = null;
      if (error instanceof PipeError) throw error;
      throw new PipeError(
        "moss_config",
        503,
        "The Moss custom-embedding index is not loadable. Verify credentials and build it with `npm run moss:index:custom`."
      );
    }
    loadedIndex = CUSTOM_INDEX_NAME;
    return CUSTOM_INDEX_NAME;
  })();

  return loadPromise;
}

export interface MossDocument {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, string>;
}

export interface MossRetrieval {
  docs: MossDocument[];
  latencyMs: number | null;
  indexName: string;
  query: string;
}

export async function queryMoss(question: string, topK = 5): Promise<MossRetrieval> {
  const indexName = await ensureIndexLoaded();
  const moss = getClient();

  const embedding = await embedText(question);

  let result: SearchResult;
  try {
    result = await moss.query(indexName, question, { topK, embedding });
  } catch (error) {
    if (error instanceof PipeError) throw error;
    throw new PipeError("moss_retrieval", 502, "Moss retrieval failed.");
  }

  return {
    docs: result.docs.map((doc) => ({
      id: doc.id,
      text: doc.text,
      score: doc.score,
      metadata: doc.metadata ?? {},
    })),
    latencyMs: typeof result.timeTakenInMs === "number" ? result.timeTakenInMs : null,
    indexName: result.indexName ?? indexName,
    query: question,
  };
}