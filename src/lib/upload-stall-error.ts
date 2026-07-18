const UPLOAD_STALLED_BRAND = Symbol.for("silicon-interface.upload-stalled.v1");

export class UploadStalledError extends Error {
  readonly code = "upload_stalled";

  static [Symbol.hasInstance](value: unknown): boolean {
    return Boolean(
      value &&
        typeof value === "object" &&
        (value as Record<symbol, unknown>)[UPLOAD_STALLED_BRAND] === true,
    );
  }

  constructor() {
    super("upload stopped making progress");
    this.name = "UploadStalledError";
    Object.defineProperty(this, UPLOAD_STALLED_BRAND, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
}
