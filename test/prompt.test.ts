import { describe, expect, it } from "vitest";
import { convertPrompt, resourcePath, UnsupportedPromptContentError } from "../src/acp/prompt.ts";

describe("convertPrompt", () => {
  it("joins text blocks and keeps display text", () => {
    const result = convertPrompt([
      { type: "text", text: "hello " },
      { type: "text", text: "world" },
    ]);
    expect(result.text).toBe("hello world");
    expect(result.displayText).toBe("hello  world");
    expect(result.images).toEqual([]);
  });

  it("turns resource links into path references", () => {
    const result = convertPrompt([
      { type: "text", text: "look at " },
      { type: "resource_link", name: "a.ts", uri: "file:///w/a.ts" },
    ]);
    expect(result.text).toContain('[resource_link name="a.ts" path="/w/a.ts"]');
    expect(result.displayText).toBe("look at  @a.ts");
  });

  it("embeds text resources as fenced context", () => {
    const result = convertPrompt([
      { type: "resource", resource: { uri: "file:///w/b.md", text: "# B", mimeType: "text/markdown" } },
    ]);
    expect(result.text).toContain('<context ref="/w/b.md">\n# B\n</context>');
  });

  it("attaches images in pi's shape and canonicalizes jpg", () => {
    const result = convertPrompt([
      { type: "text", text: "what is this" },
      { type: "image", data: "AAAA", mimeType: "image/jpg" },
    ]);
    expect(result.images).toEqual([{ type: "image", data: "AAAA", mimeType: "image/jpeg" }]);
    expect(result.displayText).toBe("what is this [image]");
  });

  it("refuses images when the model cannot take them", () => {
    expect(() =>
      convertPrompt([{ type: "image", data: "AAAA", mimeType: "image/png" }], { images: false }),
    ).toThrow(UnsupportedPromptContentError);
  });

  it("refuses audio and binary resources", () => {
    expect(() => convertPrompt([{ type: "audio", data: "AAAA", mimeType: "audio/wav" }])).toThrow(
      UnsupportedPromptContentError,
    );
    expect(() =>
      convertPrompt([
        {
          type: "resource",
          resource: { uri: "file:///x.bin", blob: "AAAA", mimeType: "application/octet-stream" },
        },
      ]),
    ).toThrow(UnsupportedPromptContentError);
  });

  it("maps file URIs to paths and leaves other URIs alone", () => {
    expect(resourcePath("file:///tmp/x%20y.ts")).toBe("/tmp/x y.ts");
    expect(resourcePath("https://example.com/a")).toBe("https://example.com/a");
  });
});
