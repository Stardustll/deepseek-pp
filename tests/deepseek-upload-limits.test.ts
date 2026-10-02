import { describe, expect, it } from 'vitest';
import {
  DEEPSEEK_UPLOAD_TRANSPORT_MAX_BYTES,
  FALLBACK_DEEPSEEK_UPLOAD_LIMITS,
  buildUploadAcceptAttribute,
  effectiveUploadMaxBytes,
  extensionFromMimeType,
  isUploadExtensionAccepted,
  readUploadExtension,
  resolveDeepSeekUploadLimits,
  resolveUploadFilename,
} from '../core/deepseek/upload-limits';

/** The shape the live page publishes (schemaVersion 2, `entries[key].value`). */
function pageStore(fileFeature: Record<string, unknown>, options: { isDefault?: boolean } = {}): string {
  return JSON.stringify({
    schemaVersion: 2,
    entries: {
      model_configs: {
        id: 1,
        value: [
          { model_type: 'expert', enabled: false, is_default: false },
          { model_type: 'default', enabled: true, is_default: options.isDefault !== false, file_feature: fileFeature },
        ],
      },
    },
  });
}

const LIVE_FILE_FEATURE = {
  token_limit: 890880,
  max_input_file_count: 50,
  max_upload_file_size: 104857600,
  support_file_exts: ['pdf', 'PNG', '.docx', 'py', 'json', 'pdf'],
};

describe('DeepSeek page upload limits', () => {
  it('reads the default model file_feature from the live page store shape', () => {
    const resolved = resolveDeepSeekUploadLimits(pageStore(LIVE_FILE_FEATURE));

    expect(resolved.source).toBe('page-config');
    expect(resolved.fallbackReason).toBeNull();
    expect(resolved.limits.maxFileCount).toBe(50);
    expect(resolved.limits.maxFileSizeBytes).toBe(104857600);
    // Extensions are normalized (case, leading dot) and de-duplicated.
    expect(resolved.limits.supportedExtensions).toEqual(['pdf', 'png', 'docx', 'py', 'json']);
  });

  it.each([
    ['absent config', null],
    ['non-JSON', 'not json'],
    ['schema mismatch', JSON.stringify({ schemaVersion: 3, entries: {} })],
    ['missing entries', JSON.stringify({ schemaVersion: 2 })],
    ['missing model_configs', JSON.stringify({ schemaVersion: 2, entries: {} })],
    ['no default model', JSON.stringify({
      schemaVersion: 2,
      entries: { model_configs: { value: [{ model_type: 'default', is_default: false }] } },
    })],
    ['no file_feature', pageStore(undefined as never)],
    ['non-numeric size', pageStore({ ...LIVE_FILE_FEATURE, max_upload_file_size: '100' })],
    ['zero size', pageStore({ ...LIVE_FILE_FEATURE, max_upload_file_size: 0 })],
    ['non-integer count', pageStore({ ...LIVE_FILE_FEATURE, max_input_file_count: 1.5 })],
    ['empty extension list', pageStore({ ...LIVE_FILE_FEATURE, support_file_exts: [] })],
    ['unusable extension list', pageStore({ ...LIVE_FILE_FEATURE, support_file_exts: [1, null, '  '] })],
  ])('fails closed to the released image-only limits on %s', (_label, raw) => {
    const resolved = resolveDeepSeekUploadLimits(raw);

    expect(resolved.source).toBe('fallback');
    expect(resolved.fallbackReason).toBeTruthy();
    expect(resolved.limits).toBe(FALLBACK_DEEPSEEK_UPLOAD_LIMITS);
    expect(resolved.limits.supportedExtensions).toContain('png');
    expect(resolved.limits.supportedExtensions).not.toContain('pdf');
  });

  it('never widens past the released limits when the page config is unreadable', () => {
    const fallback = resolveDeepSeekUploadLimits('{bad json}');
    expect(fallback.limits.maxFileSizeBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(effectiveUploadMaxBytes(fallback.limits)).toBeLessThanOrEqual(8 * 1024 * 1024);
  });

  it('clamps the page ceiling to what one runtime message can carry', () => {
    const resolved = resolveDeepSeekUploadLimits(pageStore(LIVE_FILE_FEATURE));
    expect(resolved.limits.maxFileSizeBytes).toBeGreaterThan(DEEPSEEK_UPLOAD_TRANSPORT_MAX_BYTES);
    expect(effectiveUploadMaxBytes(resolved.limits)).toBe(DEEPSEEK_UPLOAD_TRANSPORT_MAX_BYTES);
  });

  it('keeps a page ceiling below the transport bound untouched', () => {
    const resolved = resolveDeepSeekUploadLimits(pageStore({ ...LIVE_FILE_FEATURE, max_upload_file_size: 1024 }));
    expect(effectiveUploadMaxBytes(resolved.limits)).toBe(1024);
  });
});

describe('upload extension handling', () => {
  const limits = { maxFileCount: 4, maxFileSizeBytes: 1024, supportedExtensions: ['png', 'pdf'] };

  it('reads extensions case-insensitively and ignores directory segments', () => {
    expect(readUploadExtension('Report.PDF')).toBe('pdf');
    expect(readUploadExtension('/tmp/a.b/shot.PNG')).toBe('png');
    expect(readUploadExtension('no-extension')).toBeNull();
    expect(readUploadExtension('trailing.')).toBeNull();
    expect(readUploadExtension('.hidden')).toBeNull();
  });

  it('accepts only listed extensions and rejects extension-less names', () => {
    expect(isUploadExtensionAccepted('a.pdf', limits)).toBe(true);
    expect(isUploadExtensionAccepted('a.PDF', limits)).toBe(true);
    expect(isUploadExtensionAccepted('a.exe', limits)).toBe(false);
    expect(isUploadExtensionAccepted('README', limits)).toBe(false);
  });

  it('derives a name from the MIME type when the transport omits one', () => {
    expect(resolveUploadFilename('image', 'image/png')).toBe('image.png');
    expect(resolveUploadFilename('image', 'image/jpeg')).toBe('image.jpg');
    expect(resolveUploadFilename('doc', 'application/pdf')).toBe('doc.pdf');
    // An existing extension always wins over the declared MIME type.
    expect(resolveUploadFilename('shot.png', 'image/jpeg')).toBe('shot.png');
    // Nothing to derive from leaves the name untouched (and thus rejected).
    expect(resolveUploadFilename('image', '')).toBe('image');
    expect(extensionFromMimeType('')).toBeNull();
    expect(extensionFromMimeType('not-a-mime')).toBeNull();
  });

  it('builds the picker accept list from the resolved extensions', () => {
    expect(buildUploadAcceptAttribute(limits)).toBe('.png,.pdf');
    expect(buildUploadAcceptAttribute(FALLBACK_DEEPSEEK_UPLOAD_LIMITS)).toContain('.png');
  });
});
