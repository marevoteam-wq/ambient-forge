const manifestUrl = "https://ambient-forge.marevo.workers.dev/manifest.json";

for (const button of document.querySelectorAll("[data-copy-manifest]")) {
  button.addEventListener("click", async () => {
    const original = button.textContent;
    try {
      await navigator.clipboard.writeText(manifestUrl);
      button.textContent = "Copied!";
    } catch {
      window.prompt("Copy the Ambient Forge install link:", manifestUrl);
    }
    window.setTimeout(() => { button.textContent = original; }, 1800);
  });
}
