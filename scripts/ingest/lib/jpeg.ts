interface SegmentStep {
  next: number;
  /** Present when this segment stays in the file. */
  keep?: Buffer;
  /** Start of scan: `keep` already includes the rest of the file. */
  rest?: boolean;
}

/** One JPEG marker. `null` means the rest of the buffer is not a segment. */
function readSegment(input: Buffer, i: number): SegmentStep | null {
  const markerStart = input[i];
  const marker = input[i + 1];
  if (markerStart !== 0xff || marker === undefined) return null;
  if (marker === 0xff) return { next: i + 1 };
  if (marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) {
    return { next: i + 2, keep: input.subarray(i, i + 2) };
  }
  const length = input.readUInt16BE(i + 2);
  const end = i + 2 + length;
  if (length < 2 || end > input.length) return null;
  if (marker === 0xda) return { next: input.length, keep: input.subarray(i), rest: true };
  const drop = marker === 0xe1 || marker === 0xed;
  return { next: end, keep: drop ? undefined : input.subarray(i, end) };
}

/**
 * Drop EXIF and XMP (APP1) and IPTC (APP13) from a JPEG so a re-hosted cover
 * cannot carry a camera location or other embedded metadata. Image data and
 * the other segments stay. A buffer that is not a JPEG is returned unchanged.
 */
export function stripJpegMetadata(input: Buffer): Buffer {
  if (input.length < 4 || input[0] !== 0xff || input[1] !== 0xd8) return input;
  const parts: Buffer[] = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  while (i + 3 < input.length) {
    const step = readSegment(input, i);
    if (!step) {
      parts.push(input.subarray(i));
      return Buffer.concat(parts);
    }
    if (step.keep) parts.push(step.keep);
    if (step.rest) return Buffer.concat(parts);
    i = step.next;
  }
  if (i < input.length) parts.push(input.subarray(i));
  return Buffer.concat(parts);
}
