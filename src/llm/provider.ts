/**
 * Model access, kept behind a narrow interface.
 *
 * Casefile's verdicts never depend on a model being reachable: the deterministic
 * verifier decides, and generation only ever produces prose about a decision that has
 * already been made. When no key is configured the narrator falls back to a template,
 * which is why install, test, evaluate, replay and the demo all run offline.
 */

export interface GenerationRequest {
  readonly system: string;
  readonly prompt: string;
  readonly maxOutputTokens?: number;
}

export interface Provider {
  readonly name: string;
  generate(request: GenerationRequest): Promise<string>;
}

export class ProviderUnavailableError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "ProviderUnavailableError";
  }
}

const DEFAULT_MODEL = "gemini-2.5-flash";

/**
 * Returns a provider only when one is actually configured. Callers treat `undefined` as
 * an ordinary condition rather than an error — no key is the default state.
 */
export function providerFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): Provider | undefined {
  const apiKey = env.GEMINI_API_KEY?.trim();
  if (!apiKey) return undefined;
  return geminiProvider(apiKey, env.CASEFILE_LLM_MODEL?.trim() || DEFAULT_MODEL);
}

function geminiProvider(apiKey: string, model: string): Provider {
  return {
    name: `gemini:${model}`,
    async generate(request) {
      // Resolved at call time and typed structurally, so the package stays a genuine
      // optional dependency: a checkout without it type-checks, builds and runs
      // everything that does not need a model.
      const specifier = "@google/genai";
      const module = (await import(specifier).catch(() => {
        throw new ProviderUnavailableError(
          "the @google/genai package is not installed; run npm install --include=optional",
        );
      })) as unknown as {
        GoogleGenAI: new (options: {
          apiKey: string;
        }) => {
          models: {
            generateContent(request: {
              model: string;
              contents: string;
              config: {
                systemInstruction: string;
                maxOutputTokens: number;
                temperature: number;
              };
            }): Promise<{ text?: string }>;
          };
        };
      };

      const client = new module.GoogleGenAI({ apiKey });
      const response = await client.models.generateContent({
        model,
        contents: request.prompt,
        config: {
          systemInstruction: request.system,
          maxOutputTokens: request.maxOutputTokens ?? 600,
          temperature: 0,
        },
      });
      return response.text ?? "";
    },
  };
}

/** Deterministic stand-in used by tests, so the narration path is exercised offline. */
export function scriptedProvider(responses: readonly string[]): Provider {
  let index = 0;
  return {
    name: "scripted",
    generate: async () => {
      const response = responses[Math.min(index, responses.length - 1)] ?? "";
      index += 1;
      return response;
    },
  };
}
