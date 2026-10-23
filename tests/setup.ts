import "@testing-library/jest-dom/vitest";

// jsdom has no native dialog top layer. Runtime smoke covers real modality/focus.
if (typeof HTMLDialogElement !== "undefined") {
  HTMLDialogElement.prototype.showModal = function () { this.open = true; };
  HTMLDialogElement.prototype.close = function () { this.open = false; };
}
