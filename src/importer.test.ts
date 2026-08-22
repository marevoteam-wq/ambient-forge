import { describe, expect, it } from "vitest";
import { parseImportedLibrary } from "./importer";

describe("library import", () => {
  it("converts a compatible Djinni library", () => {
    const imported = parseImportedLibrary({
      forest: {
        id: "forest", folderName: "Forest", folderColor: "#22aa66",
        streams: [{
          id: "rain", streamName: "Rain", streamIcon: "🌧️", streamVolume: 75,
          streamData: [{ id: "track", name: "Rain loop", link: "https://example.com/rain.ogg", loop: true }],
        }],
      },
    });
    expect(imported.format).toBe("Djinni");
    expect(imported.library.folders).toHaveLength(1);
    expect(imported.library.scenes[0].tracks[0].url).toBe("https://example.com/rain.ogg");
  });

  it("rejects unsafe and unsupported input", () => {
    expect(() => parseImportedLibrary({
      bad: {
        id: "bad", folderName: "Bad", streams: [{ id: "x", streamName: "X", streamData: [{ link: "javascript:alert(1)" }] }],
      },
    })).toThrow("Unsupported library format");
    expect(() => parseImportedLibrary({ version: 1, folders: [], scenes: [] })).toThrow("Unsupported library format");
  });
});
