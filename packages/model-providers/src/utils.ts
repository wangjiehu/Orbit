export function zodToJsonSchema(schema: any): any {
  if (!schema || !schema._def) return { type: "object" };
  const def = schema._def;
  const typeName = def.typeName;

  switch (typeName) {
    case "ZodObject": {
      const shape = def.shape();
      const properties: Record<string, any> = {};
      const required: string[] = [];

      for (const key of Object.keys(shape)) {
        const propertySchema = shape[key];
        properties[key] = zodToJsonSchema(propertySchema);

        let isOptional = false;
        let inner = propertySchema;
        while (inner && inner._def) {
          if (inner._def.typeName === "ZodOptional") {
            isOptional = true;
            break;
          }
          inner = inner._def.innerType || inner._def.schema;
        }

        if (!isOptional) {
          required.push(key);
        }
      }

      return {
        type: "object",
        properties,
        ...(required.length > 0 ? { required } : {}),
      };
    }
    case "ZodString":
      return { type: "string" };
    case "ZodNumber":
      return { type: "number" };
    case "ZodBoolean":
      return { type: "boolean" };
    case "ZodArray":
      return {
        type: "array",
        items: zodToJsonSchema(def.type),
      };
    case "ZodOptional":
      return zodToJsonSchema(def.innerType);
    case "ZodEffects":
      return zodToJsonSchema(def.schema);
    default:
      return { type: "string" };
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit & { timeout?: number },
  maxRetries = 3,
): Promise<Response> {
  const timeoutMs = init.timeout ?? 60000;
  let attempt = 0;

  while (true) {
    const controller = new AbortController();
    const signal = controller.signal;

    let externalSignalAborted = false;
    const onExternalAbort = () => {
      externalSignalAborted = true;
      controller.abort();
    };

    if (init.signal) {
      if (init.signal.aborted) {
        throw (
          init.signal.reason ||
          new DOMException("The user aborted a request.", "AbortError")
        );
      }
      init.signal.addEventListener("abort", onExternalAbort);
    }

    const timeoutId = setTimeout(() => {
      controller.abort();
    }, timeoutMs);
    timeoutId.unref?.();

    try {
      const response = await fetch(url, {
        ...init,
        signal,
      });

      if (response.ok) {
        return response;
      }

      const status = response.status;
      const isTransient = status === 429 || (status >= 500 && status <= 504);
      if (!isTransient || attempt >= maxRetries) {
        return response;
      }
      await response.body?.cancel();
    } catch (err: any) {
      const isExternalAbort = externalSignalAborted || init.signal?.aborted;
      if (isExternalAbort) {
        throw err;
      }

      const isTimeout = err.name === "AbortError" && !isExternalAbort;
      if (isTimeout) {
        if (attempt >= maxRetries) {
          throw new DOMException("Request timed out", "TimeoutError");
        }
      } else {
        if (attempt >= maxRetries) {
          throw err;
        }
      }
    } finally {
      clearTimeout(timeoutId);
      if (init.signal) {
        init.signal.removeEventListener("abort", onExternalAbort);
      }
    }

    attempt++;
    const delay = Math.min(
      3000,
      Math.pow(2, attempt) * 250 + Math.random() * 250,
    );
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
