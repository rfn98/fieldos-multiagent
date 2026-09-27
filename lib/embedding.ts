import {
  env,
  pipeline,
  type FeatureExtractionPipeline,
} from "@huggingface/transformers";
import { PipeError } from "./types";

const MODEL_ID = (
  process.env.EMBEDDING_MODEL_ID ?? "Xenova/all-MiniLM-L6-v2"
).trim();

env.cacheDir = "/tmp/transformers-cache";

const wasmBackend = env.backends.onnx.wasm;

if (wasmBackend) {
  wasmBackend.numThreads = 1;
}

export const EMBEDDING_DIMENSION = 384;

type EmbeddingPipeline = FeatureExtractionPipeline;

type PipelineFactory = (
  task: string,
  modelId: string
) => Promise<unknown>;

let pipelinePromise: Promise<EmbeddingPipeline> | null = null;

function getPipeline(): Promise<EmbeddingPipeline> {
  pipelinePromise ??= (async () => {
    try {
      const extractor = await (pipeline as PipelineFactory)(
        "feature-extraction",
        MODEL_ID
      );

      return extractor as EmbeddingPipeline;
    } catch (error) {
      pipelinePromise = null;

      console.error("[embedding] Failed to load model:", error);

      throw new PipeError(
        "moss_config",
        503,
        `Embedding model could not be loaded (${MODEL_ID}).`
      );
    }
  })();

  return pipelinePromise;
}

export async function embedText(text: string): Promise<number[]> {
  const extractor = await getPipeline();

  let rows: unknown;

  try {
    const output = await extractor(text, {
      pooling: "mean",
      normalize: true,
    });

    rows = (output as { tolist: () => unknown }).tolist();
  } catch {
    throw new PipeError(
      "moss_config",
      503,
      "Embedding generation failed."
    );
  }

  if (
    !Array.isArray(rows) ||
    rows.length !== 1 ||
    !Array.isArray(rows[0])
  ) {
    throw new PipeError(
      "moss_config",
      503,
      "Embedding output had an unexpected shape."
    );
  }

  const vector = rows[0];

  if (
    !Array.isArray(vector) ||
    vector.length !== EMBEDDING_DIMENSION ||
    !vector.every(
      (value) =>
        typeof value === "number" && Number.isFinite(value)
    )
  ) {
    throw new PipeError(
      "moss_config",
      503,
      `Embedding dimension was ${
        Array.isArray(vector) ? vector.length : "n/a"
      }, expected ${EMBEDDING_DIMENSION}.`
    );
  }

  return vector as number[];
}