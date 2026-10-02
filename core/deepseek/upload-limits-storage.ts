/**
 * Reads the page's own upload limits from the extension-owned cache.
 *
 * The raw value originates in a page-owned `localStorage` store, written by the
 * isolated content script and re-validated here at every receiving boundary, so
 * no consumer has to trust it. This is the single reader used by the background
 * service worker, the active client, and the side panel.
 */
import {
  DEEPSEEK_UPLOAD_LIMITS_STORAGE_KEY,
  FALLBACK_DEEPSEEK_UPLOAD_LIMITS,
  resolveDeepSeekUploadLimits,
  type ResolvedDeepSeekUploadLimits,
} from './upload-limits';

export async function readDeepSeekUploadLimits(): Promise<ResolvedDeepSeekUploadLimits> {
  try {
    const data = await chrome.storage.local.get(DEEPSEEK_UPLOAD_LIMITS_STORAGE_KEY) as Record<string, unknown>;
    const raw = data[DEEPSEEK_UPLOAD_LIMITS_STORAGE_KEY];
    return resolveDeepSeekUploadLimits(typeof raw === 'string' ? raw : null);
  } catch {
    return {
      limits: FALLBACK_DEEPSEEK_UPLOAD_LIMITS,
      source: 'fallback',
      fallbackReason: 'upload limits storage read failed',
    };
  }
}
