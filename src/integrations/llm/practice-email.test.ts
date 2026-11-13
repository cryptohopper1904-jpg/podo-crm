import { describe, expect, it } from "vitest";
import { OpenAiCompatibleLlm } from "./openai-compatible";

describe("OpenAiCompatibleLlm.choosePracticeEmail (Praxissuche, nur öffentliche Geschäftsdaten)", () => {
  const make = (answer: string, sent: unknown[]) =>
    new OpenAiCompatibleLlm({
      baseUrl: "https://llm.example/v1",
      apiKey: "test",
      model: "m",
      fetch: async (_u, i) => {
        sent.push(JSON.parse(String(i?.body)));
        return new Response(JSON.stringify({ choices: [{ message: { content: answer } }] }));
      },
    });

  it("braucht keine Patientendaten-Freigabe, sendet nur Praxisname + Kandidaten, Antwort nur aus der Liste", async () => {
    const sent: { messages: { content: string }[]; response_format?: unknown }[] = [];
    const llm = make('Antwort: {"best":"kontakt@p.example","personal":["anna.x@p.example","fremd@x.example"]}', sent as unknown[]);
    const r = await llm.choosePracticeEmail("Podologie X", ["Kontakt@p.example", "anna.x@p.example"]);
    expect(r).toEqual({ best: "kontakt@p.example", personal: ["anna.x@p.example"] });
    expect(JSON.parse(sent[0].messages[1].content)).toEqual({ praxis: "Podologie X", kandidaten: ["kontakt@p.example", "anna.x@p.example"] });
    expect(sent[0].response_format).toBeUndefined();
  });

  it("erfundene oder als persönlich markierte Auswahl wird verworfen", async () => {
    expect(await make('{"best":"erfunden@x.example","personal":[]}', []).choosePracticeEmail("P", ["info@p.example"])).toEqual({ best: null, personal: [] });
    expect(await make('{"best":"info@p.example","personal":["info@p.example"]}', []).choosePracticeEmail("P", ["info@p.example"])).toEqual({ best: null, personal: ["info@p.example"] });
  });

  it("Patientendaten-Funktionen bleiben ohne Freigabe gesperrt", async () => {
    const prev = process.env.LLM_DATA_PROCESSING_APPROVED;
    delete process.env.LLM_DATA_PROCESSING_APPROVED;
    await expect(make("{}", []).suggestReply("Hallo")).rejects.toThrow(/freigegeben/);
    if (prev !== undefined) process.env.LLM_DATA_PROCESSING_APPROVED = prev;
  });
});
