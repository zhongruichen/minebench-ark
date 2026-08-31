import { NextResponse } from "next/server";
import { z } from "zod";
import { fetchProviderModels } from "@/lib/ai/providers/configuredProvider";
import { assertSafeCustomApiUrl } from "@/lib/ai/providers/customApiGuard";
import { providerConfigSchema } from "@/lib/ai/providerConfigSchema";
import type { ProviderConfig } from "@/lib/ai/providerConfig";

export const runtime = "nodejs";

// The model list must be fetched server-side: the browser cannot reach most
// provider endpoints (CORS), and routing it here keeps every outbound request
// behind the same SSRF guard the generation path uses.
const reqSchema = z.object({
  provider: providerConfigSchema,
});

const REQUEST_TIMEOUT_MS = 30_000;

export async function POST(req: Request) {
  const json = (await req.json().catch(() => null)) as unknown;
  const parsed = reqSchema.safeParse(json);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const provider = parsed.data.provider as ProviderConfig;

  try {
    await assertSafeCustomApiUrl(provider.baseUrl, {
      endpoint: "models",
      appendV1: provider.appendV1,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid provider API server URL";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // Propagate client disconnects so an abandoned request stops promptly.
  req.signal.addEventListener("abort", () => controller.abort(), { once: true });

  try {
    const { models, log } = await fetchProviderModels({
      provider,
      signal: controller.signal,
    });
    return NextResponse.json({ models, log });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to fetch model list";
    return NextResponse.json({ error: message }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
