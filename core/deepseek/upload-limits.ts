/**
 * Upload limits and the page-config cache that carries them.
 *
 * The DeepSeek page publishes its own file limits in a page-owned
 * `localStorage` store. Extension codecs never read page storage directly
 * (that belongs to the content script); instead the content script caches the
 * raw store string under {@link DEEPSEEK_UPLOAD_LIMITS_STORAGE_KEY} and the
 * background service worker resolves it with the pure reader below.
 *
 * The stored value is validated at the receiving boundary with the same reader
 * the content script uses, so an untrusted page value cannot widen uploads.
 */

/** Conservative fallback: the pre-merge behavior (images only, 8 MiB). */
export const DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES = 8 * 1024 * 1024;

/** Key of the page's persisted remote-feature model store. */
export const DEEPSEEK_REMOTE_MODEL_STORE_KEY = '__ds_remote_feature_store_model';

/**
 * Extension-owned cache of that store. Additive extension storage: a missing or
 * stale value falls back to {@link FALLBACK_DEEPSEEK_UPLOAD_LIMITS} and never
 * blocks an upload the released build allowed.
 */
export const DEEPSEEK_UPLOAD_LIMITS_STORAGE_KEY = 'deepseekPageUploadLimits';

/**
 * Hard bound on what the extension's own upload path may carry.
 *
 * The sidepanel hands the file to the background service worker as a base64
 * data URL inside one runtime message, so the page's own 100 MiB ceiling cannot
 * be honored on this path: base64 inflates by ~33% and runtime messages are
 * bounded well below that. Files above this bound stay a page-composer job —
 * the extension reports the bound instead of silently failing the transfer.
 */
export const DEEPSEEK_UPLOAD_TRANSPORT_MAX_BYTES = 24 * 1024 * 1024;

export interface DeepSeekUploadLimits {
  readonly maxFileCount: number;
  readonly maxFileSizeBytes: number;
  /** Lower-cased extensions without the leading dot. */
  readonly supportedExtensions: readonly string[];
}

export type DeepSeekUploadLimitsSource = 'page-config' | 'fallback';

export interface ResolvedDeepSeekUploadLimits {
  readonly limits: DeepSeekUploadLimits;
  readonly source: DeepSeekUploadLimitsSource;
  /** Non-null only when `source` is `fallback`; safe to log. */
  readonly fallbackReason: string | null;
}

/** Fallback used whenever the page config is missing, unreadable, or unknown. */
export const FALLBACK_DEEPSEEK_UPLOAD_LIMITS: DeepSeekUploadLimits = Object.freeze({
  maxFileCount: 4,
  maxFileSizeBytes: DEEPSEEK_IMAGE_UPLOAD_MAX_BYTES,
  supportedExtensions: Object.freeze([
    'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'svg', 'svgz', 'avif', 'apng', 'tif', 'tiff', 'ico',
  ]) as readonly string[],
});

export function normalizeUploadExtension(value: string): string {
  return value.trim().replace(/^\.+/, '').toLowerCase();
}

/**
 * Reads the page's `file_feature` limits out of the raw remote-model store
 * string. Pure: the caller owns storage access. Only the schema version
 * observed live is understood; anything else fails closed.
 */
export function resolveDeepSeekUploadLimits(raw: string | null): ResolvedDeepSeekUploadLimits {
  const fallback = (reason: string): ResolvedDeepSeekUploadLimits => ({
    limits: FALLBACK_DEEPSEEK_UPLOAD_LIMITS,
    source: 'fallback',
    fallbackReason: reason,
  });

  if (typeof raw !== 'string' || !raw) return fallback('page model config is absent');

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return fallback('page model config is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return fallback('page model config is not an object');
  }

  const store = parsed as Record<string, unknown>;
  if (store.schemaVersion !== 2) {
    return fallback(`unsupported page model config schema version ${String(store.schemaVersion)}`);
  }

  const entries = store.entries;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) {
    return fallback('page model config has no entries');
  }
  const modelConfigsEntry = (entries as Record<string, unknown>).model_configs;
  if (!modelConfigsEntry || typeof modelConfigsEntry !== 'object' || Array.isArray(modelConfigsEntry)) {
    return fallback('page model config has no model_configs entry');
  }
  const modelConfigs = (modelConfigsEntry as Record<string, unknown>).value;
  if (!Array.isArray(modelConfigs)) return fallback('page model configs are not an array');

  const defaultModel = modelConfigs.find((candidate) => (
    !!candidate
    && typeof candidate === 'object'
    && !Array.isArray(candidate)
    && (candidate as Record<string, unknown>).is_default === true
  )) as Record<string, unknown> | undefined;
  if (!defaultModel) return fallback('page model config has no default model');

  const fileFeature = defaultModel.file_feature;
  if (!fileFeature || typeof fileFeature !== 'object' || Array.isArray(fileFeature)) {
    return fallback('default page model has no file_feature');
  }
  const feature = fileFeature as Record<string, unknown>;

  const maxFileSizeBytes = feature.max_upload_file_size;
  if (typeof maxFileSizeBytes !== 'number' || !Number.isFinite(maxFileSizeBytes) || maxFileSizeBytes <= 0) {
    return fallback('default page model has no usable max_upload_file_size');
  }

  const maxFileCount = feature.max_input_file_count;
  if (typeof maxFileCount !== 'number' || !Number.isInteger(maxFileCount) || maxFileCount <= 0) {
    return fallback('default page model has no usable max_input_file_count');
  }

  const rawExtensions = feature.support_file_exts;
  if (!Array.isArray(rawExtensions) || rawExtensions.length === 0) {
    return fallback('default page model has no support_file_exts');
  }
  const supportedExtensions = Array.from(new Set(
    rawExtensions
      .filter((value): value is string => typeof value === 'string')
      .map(normalizeUploadExtension)
      .filter((value) => value.length > 0),
  ));
  if (supportedExtensions.length === 0) {
    return fallback('default page model support_file_exts are unusable');
  }

  return {
    limits: Object.freeze({
      maxFileCount,
      maxFileSizeBytes,
      supportedExtensions: Object.freeze(supportedExtensions),
    }),
    source: 'page-config',
    fallbackReason: null,
  };
}

/** Reads the filename extension, or null when the name carries none. */
export function readUploadExtension(filename: string): string | null {
  const lastSegment = filename.split(/[\\/]/).pop() ?? filename;
  const dot = lastSegment.lastIndexOf('.');
  if (dot <= 0 || dot === lastSegment.length - 1) return null;
  const extension = normalizeUploadExtension(lastSegment.slice(dot + 1));
  return extension.length > 0 ? extension : null;
}

/**
 * The filename to validate and send: the caller's name when it carries an
 * extension, otherwise a name derived from the declared MIME type, otherwise
 * the original (which is then rejected as extension-less).
 */
export function resolveUploadFilename(filename: string, mimeType: string): string {
  if (readUploadExtension(filename)) return filename;
  const fromMime = extensionFromMimeType(mimeType);
  return fromMime ? `${filename}.${fromMime}` : filename;
}

/**
 * Whether a filename is accepted by the resolved limits. A name with no
 * extension is rejected — the page rejects those too, and guessing from MIME
 * would accept files the page then refuses.
 */
export function isUploadExtensionAccepted(
  filename: string,
  limits: DeepSeekUploadLimits,
): boolean {
  const extension = readUploadExtension(filename);
  if (!extension) return false;
  return limits.supportedExtensions.includes(extension);
}

/** `accept` string for the file picker, built from the resolved extension list. */
export function buildUploadAcceptAttribute(limits: DeepSeekUploadLimits): string {
  return limits.supportedExtensions.map((extension) => `.${extension}`).join(',');
}

/**
 * Subtype -> extension overrides where the MIME subtype is not already the
 * extension. Anything else uses the subtype verbatim, which is correct for the
 * common `text/plain` -> `txt`-style shapes once non-alphanumerics drop out.
 */
const MIME_SUBTYPE_EXTENSIONS: Record<string, string> = {
  jpeg: 'jpg',
  'svg+xml': 'svg',
  'x-icon': 'ico',
  'x-markdown': 'md',
};

/** Filename extension for a MIME type, or null when it carries no subtype. */
export function extensionFromMimeType(mimeType: string): string | null {
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  const slash = normalized.indexOf('/');
  if (slash <= 0) return null;
  const subtype = normalized.slice(slash + 1);
  const override = MIME_SUBTYPE_EXTENSIONS[subtype];
  if (override) return override;
  const sanitized = subtype.replace(/[^a-z0-9]/g, '');
  return sanitized.length > 0 ? sanitized : null;
}

/**
 * The effective per-file ceiling for the extension's own upload path: the
 * page's advertised limit, clamped to what one runtime message can carry.
 */
export function effectiveUploadMaxBytes(limits: DeepSeekUploadLimits): number {
  return Math.min(limits.maxFileSizeBytes, DEEPSEEK_UPLOAD_TRANSPORT_MAX_BYTES);
}
