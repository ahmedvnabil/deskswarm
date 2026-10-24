/** Provider-neutral function-calling exchange. Credentials never enter events. */
import type { Model } from "./store";
export type Message = Record<string, any>;
export async function requestModel(
  model: Model,
  key: string,
  messages: Message[],
  tools: any[],
  signal: AbortSignal,
) {
  const url = `${model.base_url}/${model.protocol === "responses" ? "responses" : "chat/completions"}`;
  const body =
    model.protocol === "responses"
      ? {
          model: model.model,
          input: messages,
          tools: tools.map((t) => ({
            type: "function",
            name: t.name,
            description: t.description,
            parameters: t.inputSchema,
            strict: false,
          })),
          parallel_tool_calls: false,
          store: false,
          include: ["reasoning.encrypted_content"],
        }
      : {
          model: model.model,
          messages,
          tools: tools.map((t) => ({
            type: "function",
            function: {
              name: t.name,
              description: t.description,
              parameters: t.inputSchema,
            },
          })),
          parallel_tool_calls: false,
        };
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.any([signal, AbortSignal.timeout(60_000)]),
  });
  if (!res.ok)
    throw new Error(
      `Model provider returned HTTP ${res.status}; check the endpoint, model and credentials.`,
    );
  const data: any = await res.json();
  if (model.protocol === "responses") {
    if (data.status === "incomplete" || data.error)
      throw new Error("Model response was incomplete");
    const items = data.output;
    if (!Array.isArray(items))
      throw new Error("Provider returned no Responses output");
    const calls = items
      .filter((i: any) => i.type === "function_call")
      .map((i: any) => ({
        id: i.call_id,
        name: i.name,
        arguments: i.arguments,
      }));
    const text = items
      .filter((i: any) => i.type === "message")
      .flatMap((i: any) => i.content || [])
      .filter((i: any) => i.type === "output_text")
      .map((i: any) => i.text)
      .join("\n");
    return { calls, text, assistant: items };
  }
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("Provider returned no assistant message");
  if (data.choices[0].finish_reason === "length")
    throw new Error("Model response was truncated");
  return {
    calls: (message.tool_calls || []).map((i: any) => ({
      id: i.id,
      name: i.function?.name,
      arguments: i.function?.arguments,
    })),
    text: typeof message.content === "string" ? message.content : "",
    assistant: [{ ...message, role: "assistant" }],
  };
}
export function toolReply(protocol: string, id: string, text: string): Message {
  return protocol === "responses"
    ? { type: "function_call_output", call_id: id, output: text }
    : { role: "tool", tool_call_id: id, content: text };
}
export function imageMessage(protocol: string, data: string): Message {
  return {
    role: "user",
    content: [
      protocol === "responses"
        ? { type: "input_image", image_url: `data:image/png;base64,${data}` }
        : {
            type: "image_url",
            image_url: { url: `data:image/png;base64,${data}` },
          },
    ],
  };
}
